// Upload assembly memory (screen-recording plan §4.2, spike D5): assembly fills one buffer of the declared size,
// hashing each part as it's copied in, and the production blobs adapter sends bodies over 8 MB as a stream of views
// (fetch copies a buffered body whole). Assembled bytes and hashes are unchanged; the stream round-trips through
// @netlify/blobs' local server. VA_MEMORY_SMOKE=1 also runs D5's 150 MB measurement (what assembly adds stays under
// 450 MB).
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setEnvironmentContext } from '@netlify/blobs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { netlifyBlobs, streamAbove, viewStream } from '../src/adapters/blobs.js'
import { PART_SIZE } from '../src/domain/media-uploads.js'
import { harness, raw } from './helpers.js'

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const log = (fields: Record<string, unknown>) => console.log(JSON.stringify(fields))

/** The fixture clip padded with a trailing `free` box: a valid MP4 big enough for three parts. */
function bigClip(total = 9 * 1024 * 1024) {
  const clip = new Uint8Array(readFileSync(new URL('./fixtures/a169.mp4', import.meta.url)))
  const out = new Uint8Array(total)
  out.set(clip)
  new DataView(out.buffer).setUint32(clip.byteLength, total - clip.byteLength)
  out.set(new TextEncoder().encode('free'), clip.byteLength + 4)
  for (let i = clip.byteLength + 8; i < total; i++) out[i] = (i * 31) & 0xff
  return out
}

describe('assembly', () => {
  it('stores the same bytes and hash as were uploaded, and logs memory per stage', async () => {
    const h = harness()
    const file = bigClip()
    const s = await h.json<{ id: string; partCount: number; mediaId: string | null }>(
      await h.call('POST', '/api/v1/media/uploads', {
        as: h.member,
        body: { filename: 'clip.mp4', size: file.byteLength, sha256: sha(file) },
      }),
    )
    expect(s.partCount).toBe(3)
    for (let i = 0; i < s.partCount; i++) {
      const body = file.subarray(i * PART_SIZE, Math.min(file.byteLength, (i + 1) * PART_SIZE))
      await raw(h, h.member, 'PUT', `/api/v1/media/uploads/${s.id}/parts/${i}`, body, {
        'x-part-sha256': sha(body),
      })
    }
    const done = await h.json<{ status: string; mediaId: string }>(
      await h.call('POST', `/api/v1/media/uploads/${s.id}/complete`, { as: h.member, body: {} }),
    )
    expect(done.status).toBe('done')
    const row = await h.deps.store.getMedia(done.mediaId)
    const stored = await h.deps.blobs.get('media', row?.originalKey ?? '')
    log({ test: 'golden', uploadId: s.id, bytes: stored?.byteLength, sha: stored ? sha(stored) : null })
    expect(stored && sha(stored)).toBe(sha(file))
    expect(row).toMatchObject({ status: 'ready', bytes: file.byteLength, originalSha256: sha(file) })
    const stages = h.deps.logs
      .filter((l) => l.includes('"media.assembly_memory"'))
      .map((l) => (JSON.parse(l) as { stage: string }).stage)
    expect(stages).toEqual(['parts', 'classified', 'stored'])
  })
})

describe('blobs adapter streaming', () => {
  it('viewStream yields the bytes in 1 MB views without copying', async () => {
    const data = bigClip(2.5 * 1024 * 1024)
    const chunks: Uint8Array[] = []
    for await (const c of viewStream(data) as unknown as AsyncIterable<Uint8Array>) chunks.push(c)
    expect(chunks.map((c) => c.byteLength)).toEqual([1048576, 1048576, 524288])
    expect(chunks.every((c) => c.buffer === data.buffer)).toBe(true)
    expect(sha(Buffer.concat(chunks))).toBe(sha(data))
  })

  describe('through @netlify/blobs and its local server', () => {
    // The server runs in its own process, as in spike D5, so this process's memory is the client's alone.
    let server: ChildProcess
    let dir: string
    const STREAM_ABOVE = 8 * 1024 * 1024
    beforeAll(async () => {
      // Lowered from production's 100 MiB so the streamed path is exercised with small bodies.
      streamAbove.bytes = STREAM_ABOVE
      dir = mkdtempSync(join(tmpdir(), 'va-blobs-'))
      const code = `import { BlobsServer } from '@netlify/blobs/server'
        const s = new BlobsServer({ directory: ${JSON.stringify(dir)}, token: 'local', port: 0 })
        const { port } = await s.start()
        console.log(port)`
      server = spawn(process.execPath, ['--input-type=module', '-e', code], {
        stdio: ['ignore', 'pipe', 'inherit'],
      })
      const port = await new Promise<string>((resolve) =>
        server.stdout?.once('data', (d: Buffer) => resolve(d.toString().trim())),
      )
      const url = `http://localhost:${port}`
      setEnvironmentContext({ siteID: 'local-site', token: 'local', edgeURL: url, uncachedEdgeURL: url })
    })
    afterAll(() => {
      streamAbove.bytes = 100 * 1024 * 1024
      server.kill()
      rmSync(dir, { recursive: true, force: true })
    })

    it('round-trips a body over STREAM_ABOVE (streamed) and one under it (buffered)', async () => {
      for (const size of [STREAM_ABOVE + 3 * 1024 * 1024 + 17, 64 * 1024]) {
        const data = bigClip(size)
        await netlifyBlobs.set('media', `assembly/${size}`, data, { contentType: 'video/mp4' })
        const back = await netlifyBlobs.get('media', `assembly/${size}`)
        log({
          test: 'round trip',
          size,
          streamed: size > STREAM_ABOVE,
          ok: !!back && sha(back) === sha(data),
        })
        expect(back && sha(back)).toBe(sha(data))
      }
    })

    it.runIf(process.env.VA_MEMORY_SMOKE === '1')(
      'stores 150 MB adding under 450 MB of RSS (spike D5: about 430 MB peak on a ~120 MB process)',
      { timeout: 120_000 },
      async () => {
        // What assembly adds: the RSS growth from just before the buffer exists, each part written straight in.
        const base = process.memoryUsage().rss
        let peak = base
        const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 20)
        const size = 150 * 1024 * 1024
        const bytes = Buffer.allocUnsafe(size)
        for (let at = 0; at < size; at += 4 * 1024 * 1024)
          bytes.set(bigClip(Math.min(4 * 1024 * 1024, size - at)), at)
        await netlifyBlobs.set('media', 'assembly/150mb', bytes)
        clearInterval(timer)
        const addedMb = Math.round((peak - base) / 1048576)
        log({ test: 'memory smoke', bytes: size, baseRssMb: Math.round(base / 1048576), addedMb })
        expect(addedMb).toBeLessThan(450)
      },
    )
  })
})
