// Spike D5 (plan 2026-11-04-screen-recording-demo §1 Media and uploads, §4.2, §10 Phase 0): memory of upload assembly
// for a 150 MB recording, as media-assemble-background does it today and with the planned changes.
//   npx tsx docs/spikes/d5/assemble.ts [--out /tmp/va-d5] [--mb 150] [--variant current,proto,proto-noslice]
// The byte path of assembleUpload (src/domain/media-uploads.ts) runs against @netlify/blobs' local BlobsServer through
// the production adapter (src/adapters/blobs.ts) and the real classify(), so the SDK's and fetch's copies count:
//   current        get parts, sha256 each, Buffer.concat, new Uint8Array copy, sha256 whole, classify, blobs.set
//                  (the adapter slices the ArrayBuffer: another copy)
//   proto          hash part by part while reading, Buffer.concat once, pass the Buffer through, classify, blobs.set
//   proto-noslice  proto, and blobs.set hands the SDK the Buffer's own ArrayBuffer when the view covers all of it
//   prealloc       one Buffer.allocUnsafe(size); each part is hashed, copied in and dropped (no concat double)
//   prealloc-blob  prealloc, and the SDK gets new Blob([bytes]) (fetch streams a Blob body instead of copying it)
//   prealloc-stream prealloc, and the SDK gets a ReadableStream of 1 MB views of bytes (makeRequest sets duplex half)
// --gc runs every child with --expose-gc and collects every 100 ms, to tell live memory from garbage V8 hasn't freed.
// Each variant runs in its own child process (fresh heap); memory is sampled every 20 ms and per stage. The DB writes
// and meta.json are left out (kilobytes). JSON lines on stderr, a summary between ===D5-JSON=== lines.
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { arch, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getStore, setEnvironmentContext } from '@netlify/blobs'
import { BlobsServer } from '@netlify/blobs/server'
import { netlifyBlobs } from '../../../src/adapters/blobs.js'
import { classify, LIMITS } from '../../../src/lib/media/classify.js'
import { log, parseFlags, printSummary, round } from '../lib/proc.js'

const flags = parseFlags(process.argv.slice(2))
const outDir = flags.out ?? join(tmpdir(), 'va-d5')
const MB = Number(flags.mb ?? 150)
const PART = 4 * 1024 * 1024
const variants = (flags.variant ?? 'current,proto,proto-noslice,prealloc,prealloc-blob,prealloc-stream').split(',')
const GC = flags.gc === 'true'
const TOKEN = 'd5-local'
const SITE = 'd5site'
mkdirSync(outDir, { recursive: true })
const mb = (n: number) => round(n / 1048576, 1)

// ---------- Child: one variant ----------

async function child(variant: string, port: number, parts: number, size: number, sha: string) {
  const url = `http://localhost:${port}`
  setEnvironmentContext({ siteID: SITE, token: TOKEN, edgeURL: url, uncachedEdgeURL: url })
  const peak = { rss: 0, arrayBuffers: 0, heapUsed: 0, external: 0 }
  const sample = () => {
    const m = process.memoryUsage()
    peak.rss = Math.max(peak.rss, m.rss)
    peak.arrayBuffers = Math.max(peak.arrayBuffers, m.arrayBuffers)
    peak.heapUsed = Math.max(peak.heapUsed, m.heapUsed)
    peak.external = Math.max(peak.external, m.external)
    return m
  }
  const timer = setInterval(sample, 20)
  const gc = (globalThis as { gc?: () => void }).gc
  const gcTimer = gc ? setInterval(gc, 100) : null
  const stages: Record<string, unknown> = {}
  const mark = (stage: string) => {
    const m = sample()
    stages[stage] = { rssMb: mb(m.rss), arrayBuffersMb: mb(m.arrayBuffers), peakRssMb: mb(peak.rss) }
    log('stage', { variant, stage, rssMb: mb(m.rss), arrayBuffersMb: mb(m.arrayBuffers), peakRssMb: mb(peak.rss) })
  }
  mark('start')
  const started = Date.now()
  const whole = createHash('sha256')
  const chunks: Uint8Array[] = []
  const prealloc = variant.startsWith('prealloc')
  const into = prealloc ? Buffer.allocUnsafe(size) : null
  let at = 0
  for (let i = 0; i < parts; i++) {
    const b = await netlifyBlobs.get('media', `uploads/d5/part-${i}`)
    if (!b) throw new Error(`part ${i} missing`)
    createHash('sha256').update(b).digest('hex')
    if (variant !== 'current') whole.update(b)
    if (into) {
      into.set(b, at)
      at += b.byteLength
    } else chunks.push(b)
  }
  mark('parts')
  let bytes: Uint8Array
  if (into) {
    bytes = into
    if (whole.digest('hex') !== sha) throw new Error('sha mismatch')
  } else if (variant === 'current') {
    bytes = new Uint8Array(Buffer.concat(chunks))
    mark('concat+copy')
    if (createHash('sha256').update(bytes).digest('hex') !== sha) throw new Error('sha mismatch')
  } else {
    bytes = Buffer.concat(chunks)
    chunks.length = 0
    mark('concat')
    if (whole.digest('hex') !== sha) throw new Error('sha mismatch')
  }
  if (bytes.byteLength !== size) throw new Error('size mismatch')
  mark('hashed')
  // Recordings get their own role limit in phase 1 (1.2b); today video stops at 100 MB.
  ;(LIMITS as { videoBytes: number }).videoBytes = Math.max(LIMITS.videoBytes, size)
  const c = classify(bytes)
  mark('classified')
  if (variant === 'prealloc-stream') {
    const view = bytes
    let off = 0
    const body = new ReadableStream<Uint8Array>({
      pull(ctl) {
        if (off >= view.byteLength) return ctl.close()
        ctl.enqueue(view.subarray(off, Math.min(view.byteLength, off + 1048576)))
        off += 1048576
      },
    })
    await getStore({ name: 'media', consistency: 'strong' }).set('media/d5/original.mp4', body as unknown as Blob)
  } else if (variant === 'prealloc-file') {
    // A file-backed Blob (fs.openAsBlob): a known length (a plain Content-Length PUT, no chunked encoding) and no
    // copy in memory; fetch reads it from disk.
    const { openAsBlob } = await import('node:fs')
    const { writeFileSync: write, rmSync: rm } = await import('node:fs')
    const path = join(tmpdir(), `va-d5-${String(process.pid)}.mp4`)
    write(path, bytes)
    mark('written')
    try {
      await getStore({ name: 'media', consistency: 'strong' }).set('media/d5/original.mp4', await openAsBlob(path))
    } finally {
      rm(path, { force: true })
    }
  } else if (variant === 'prealloc-blob')
    await getStore({ name: 'media', consistency: 'strong' }).set('media/d5/original.mp4', new Blob([bytes as Uint8Array<ArrayBuffer>]))
  else if (variant === 'proto-noslice' && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength)
    await getStore({ name: 'media', consistency: 'strong' }).set('media/d5/original.mp4', bytes.buffer as ArrayBuffer)
  else await netlifyBlobs.set('media', 'media/d5/original.mp4', bytes, { contentType: c.mime })
  mark('stored')
  clearInterval(timer)
  if (gcTimer) clearInterval(gcTimer)
  return { variant, ms: Date.now() - started, kind: c.kind, stages, peak: { rssMb: mb(peak.rss), arrayBuffersMb: mb(peak.arrayBuffers), heapUsedMb: mb(peak.heapUsed), externalMb: mb(peak.external) } }
}

// ---------- Parent ----------

async function main() {
  const fixture = join(outDir, `fixture-${MB}mb.mp4`)
  if (!existsSync(fixture)) {
    // A real H.264 MP4 of about MB megabytes (noise at a high bitrate keeps it short to encode).
    const seconds = 30
    const kbps = Math.round((MB * 8 * 1024) / seconds)
    const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=1280x720:r=30:d=${seconds},noise=alls=40:allf=t`, '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`, '-g', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', fixture])
    if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`)
  }
  const file = readFileSync(fixture)
  const size = file.byteLength
  const sha = createHash('sha256').update(file).digest('hex')
  const parts = Math.ceil(size / PART)
  log('fixture', { bytes: size, mb: mb(size), parts })

  const server = new BlobsServer({ directory: join(outDir, 'blobs'), token: TOKEN, port: 0 })
  const { port } = await server.start()
  const url = `http://localhost:${port}`
  setEnvironmentContext({ siteID: SITE, token: TOKEN, edgeURL: url, uncachedEdgeURL: url })
  for (let i = 0; i < parts; i++)
    await netlifyBlobs.set('media', `uploads/d5/part-${i}`, file.subarray(i * PART, Math.min(size, (i + 1) * PART)))
  log('parts_written', { parts })

  const results: Record<string, unknown> = {}
  for (const variant of variants) {
    // Async: the BlobsServer lives in this process, so it must keep serving while the child runs.
    const proc = spawn(process.execPath, [...process.execArgv, ...(GC ? ['--expose-gc'] : []), fileURLToPath(import.meta.url), '--child', variant, '--port', String(port), '--parts', String(parts), '--size', String(size), '--sha', sha], { stdio: ['ignore', 'pipe', 'inherit'] })
    let stdout = ''
    proc.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    const code = await new Promise<number | null>((r) => proc.on('close', r))
    const line = stdout.trim().split('\n').reverse().find((l) => l.startsWith('{'))
    results[variant] = line ? JSON.parse(line) : { error: `exit ${code}` }
    log('variant', { variant, ...(results[variant] as object) })
  }
  await server.stop()
  const summary = {
    env: { platform: platform(), arch: arch(), node: process.version, blobs: JSON.parse(readFileSync(join(fileURLToPath(new URL('../../../node_modules/@netlify/blobs/package.json', import.meta.url))), 'utf8')).version },
    fixture: { mb: mb(size), parts, partMb: PART / 1048576, onDisk: statSync(fixture).size },
    gc: GC,
    results,
    passBelow700Mb: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, ((v as { peak?: { rssMb: number } }).peak?.rssMb ?? Infinity) < 700])),
  }
  printSummary('D5-JSON', join(outDir, 'summary.json'), summary)
}

if (flags.child) {
  const r = await child(flags.child, Number(flags.port), Number(flags.parts), Number(flags.size), flags.sha!)
  console.log(JSON.stringify(r))
} else await main()
