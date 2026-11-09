// Finalize's scope check (redo a scene, plan §4.9): a scoped version becomes ready only when its saved composition is
// byte for byte the splice of the parent and its MP4 lasts as long as the splice; otherwise it fails before a single
// file is stored.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { registerScopeCheck, resetScopeChecks } from '../server/domain/engines.js'
import { attr, editText, load, save, walk, type Doc, type Summary } from '../server/lib/contract.js'
import { hyperframesScopeCheck, SCOPE_REFUSED_PREFIX, spliceBytes, spliceScoped } from '../server/lib/scope.js'
import type { Store } from '../server/store/types.js'
import { harness, pgStore, PROMPT, type Harness } from './helpers.js'
import { tarGz } from './tarball.js'

const music = save(
  load(readFileSync(new URL('./fixtures/contract1-music/index.html', import.meta.url), 'utf8')),
)
const summary: Summary = { title: 'Org webhooks', summary: 'The parent.', captions: [] }
const enc = (s: string) => new TextEncoder().encode(s)
const parentFiles: Record<string, string | Uint8Array> = {
  'index.html': music,
  'summary.json': JSON.stringify(summary),
  'assets/logo.svg': '<svg/>',
  'assets/music/credits.json': JSON.stringify([{ title: 'Theme', creator: 'A' }]),
}
const archive = (files: Record<string, string | Uint8Array>) =>
  tarGz(Object.entries(files).map(([p, body]) => ({ name: `video/${p}`, body })))

/** H.264 MP4s of exact lengths at 1920x1080, like render-job's. */
const mp4s = new Map<number, Uint8Array>()
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'va-scope-mp4-'))
  for (const s of [9, 9.2, 9.5, 11]) {
    const out = join(dir, `${s}.mp4`)
    execFileSync('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=black:s=1920x1080:r=30:d=${s}`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      out,
    ])
    mp4s.set(s, new Uint8Array(readFileSync(out)))
  }
}, 60_000)
beforeEach(() => registerScopeCheck('hyperframes', hyperframesScopeCheck))
afterEach(() => resetScopeChecks())

const edit = (html: string, f: (d: Doc) => void) => {
  const d = load(html)
  f(d)
  return save(d)
}
const text = (d: Doc, id: string, value: string) =>
  editText(
    [...walk(d.root)].find((e) => attr(e, 'data-va-text') === id)!,
    value,
  )
const redo = (d: Doc) => text(d, 'demo-sub', 'Ship on Friday')
/** What an honest render-job uploads: the splice's bytes for the agent's edit. */
const spliced = (agentHtml: string, extra: Record<string, string | Uint8Array> = {}) => {
  const bytes = spliceBytes(
    spliceScoped({
      parent: { html: music, summary },
      agent: { html: agentHtml, summary },
      beats: ['demo'],
      lockedLength: false,
    }),
  )
  return { ...parentFiles, ...extra, ...bytes }
}

/** v1 ready from the parent files; v2 a scoped revision of "demo" whose run uploads `upload` and an MP4 `seconds` long. */
async function scopedRun(
  h: Harness,
  upload: Record<string, string | Uint8Array>,
  seconds = 9,
  before?: (id: string) => Promise<void>,
) {
  h.deps.nextSource = archive(parentFiles)
  const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
  const id = v.id as string
  await h.drive(4)
  expect((await h.deps.store.getVersion(id, 1))?.status).toBe('ready')
  await h.call('POST', `/api/v1/videos/${id}/versions`, {
    as: h.member,
    body: { prompt: 'Redo the demo scene.' },
  })
  await h.deps.store.updateVersion(id, 2, { scope: { beats: ['demo'] } })
  h.deps.nextSource = archive(upload)
  h.deps.nextExtra = { files: { 'video.mp4': mp4s.get(seconds)! } }
  await before?.(id)
  const sets: string[] = []
  const set = h.deps.blobs.set.bind(h.deps.blobs)
  h.deps.blobs.set = async (s, k, b, m) => {
    if (k.startsWith(`${id}/v2`)) sets.push(`${s}:${k}`)
    return set(s, k, b, m)
  }
  await h.drive(4)
  const attempt = (await h.attempts(id)).find((a) => a.versionN === 2)!
  return { id, version: await h.deps.store.getVersion(id, 2), attempt, sets }
}
const refused = async (r: Awaited<ReturnType<typeof scopedRun>>, message: RegExp) => {
  expect(r.version?.status).toBe('failed')
  expect(r.attempt.errorCategory).toBe('invalid_output')
  expect(r.attempt.errorMessage?.startsWith(SCOPE_REFUSED_PREFIX) ?? false).toBe(true)
  expect(r.attempt.errorMessage).toMatch(message)
  expect(r.sets).toEqual([])
}

const stores: [string, () => Promise<Store | undefined>][] = [
  ['memory', async () => undefined],
  ['postgres', pgStore],
]
const opts = async (store: () => Promise<Store | undefined>) => {
  const s = await store()
  return s ? { store: s } : {}
}

describe.each(stores)('finalize a scoped revision (%s)', (_name, store) => {
  it('is ready when the upload is the splice and the MP4 matches, with beats and contract set', async () => {
    const h = harness({}, await opts(store))
    const r = await scopedRun(h, spliced(edit(music, redo)))
    expect(r.version?.status).toBe('ready')
    expect(r.version?.contract).toBe(1)
    expect(r.version?.beats?.map((b) => b.id)).toEqual(['intro', 'demo', 'outro'])
    expect(h.deps.logs.some((l) => l.includes('finalize.scope_ok'))).toBe(true)
  })

  it('refuses one that changed another scene, storing nothing', async () => {
    const h = harness({}, await opts(store))
    const agent = edit(music, (d) => {
      redo(d)
      text(d, 'intro-title', 'Org hooks')
    })
    await refused(
      await scopedRun(h, { ...parentFiles, 'index.html': agent }),
      /Scene "Opening" changed \(its headline text\)/,
    )
  })
})

describe('finalize a scoped revision', () => {
  it('requires the bytes: a re-indented frozen scene is refused though it means the same', async () => {
    const files = spliced(edit(music, redo))
    const html = files['index.html']
    const reindented = html.replace('<section id="intro"', '\n        <section id="intro"')
    expect(reindented).not.toBe(html)
    await refused(
      await scopedRun(harness(), { ...files, 'index.html': reindented }),
      /index\.html isn't the composition the scope allows/,
    )
  })

  it('refuses a changed or deleted file, and a removed credit', async () => {
    const honest = spliced(edit(music, redo))
    await refused(
      await scopedRun(harness(), { ...honest, 'assets/logo.svg': '<svg id="x"/>' }),
      /assets\/logo\.svg changed/,
    )
    const without = Object.fromEntries(Object.entries(honest).filter(([p]) => p !== 'assets/logo.svg'))
    await refused(await scopedRun(harness(), without), /assets\/logo\.svg was deleted/)
    await refused(
      await scopedRun(harness(), { ...honest, 'assets/music/credits.json': '[]' }),
      /credits\.json changed an existing credit/,
    )
  })

  it("fails as source_unavailable when the parent's archive is missing or not the one saved", async () => {
    for (const tamper of ['delete', 'replace'] as const) {
      const h = harness()
      const r = await scopedRun(h, spliced(edit(music, redo)), 9, async (id) => {
        const key = (await h.deps.store.getOutput(id, 1))!.sourceKey
        if (tamper === 'delete') await h.deps.blobs.delete('sources', key)
        else await h.deps.blobs.set('sources', key, enc('not the archive'))
      })
      expect(r.version?.status).toBe('failed')
      expect(r.attempt.errorCategory).toBe('source_unavailable')
      expect(r.attempt.errorMessage).toMatch(/Version 1's saved composition is missing/)
    }
  })

  it('binds the MP4 to the splice: 0.5 s off is refused, 0.2 s off is fine', async () => {
    const h = harness()
    const off = await scopedRun(h, spliced(edit(music, redo)), 9.5)
    expect(off.version?.status).toBe('failed')
    expect(off.attempt.errorMessage).toMatch(/The video is 9\.50 s long but its composition is 9\.00 s/)
    expect(h.deps.logs.some((l) => l.includes('finalize.scope_duration_mismatch'))).toBe(true)
    expect((await scopedRun(harness(), spliced(edit(music, redo)), 9.2)).version?.status).toBe('ready')
    // A longer scene: the composition and the MP4 both 11 s.
    const longer = edit(music, (d) => {
      redo(d)
      const demo = [...walk(d.root)].find((e) => attr(e, 'data-va-beat') === 'demo')!
      demo.attrs.find((a) => a.name === 'data-duration')!.value = '5'
    })
    expect((await scopedRun(harness(), spliced(longer), 11)).version?.status).toBe('ready')
  })

  it("reads a parent archive past the bundle's 50 MB within the source limits", async () => {
    const big = new Uint8Array(55 * 1024 * 1024)
    const parent = { ...parentFiles, 'assets/big.bin': big }
    const h = harness()
    h.deps.nextSource = archive(parent)
    const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
    await h.drive(4)
    await h.call('POST', `/api/v1/videos/${v.id}/versions`, {
      as: h.member,
      body: { prompt: 'Redo the demo scene.' },
    })
    await h.deps.store.updateVersion(v.id, 2, { scope: { beats: ['demo'] } })
    h.deps.nextSource = archive({ ...spliced(edit(music, redo)), 'assets/big.bin': big })
    h.deps.nextExtra = { files: { 'video.mp4': mp4s.get(9)! } }
    await h.drive(4)
    expect((await h.deps.store.getVersion(v.id, 2))?.status).toBe('ready')
  }, 60_000)

  it("doesn't read the parent's archive for an unscoped revision", async () => {
    const h = harness()
    h.deps.nextSource = archive(parentFiles)
    const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
    await h.drive(4)
    const key = (await h.deps.store.getOutput(v.id, 1))!.sourceKey
    const gets: string[] = []
    const get = h.deps.blobs.get.bind(h.deps.blobs)
    h.deps.blobs.get = async (s, k) => {
      if (s === 'sources' && k === key) gets.push(k)
      return get(s, k)
    }
    await h.call('POST', `/api/v1/videos/${v.id}/versions`, {
      as: h.member,
      body: { prompt: 'Warmer colours.' },
    })
    await h.drive(4)
    expect((await h.deps.store.getVersion(v.id, 2))?.status).toBe('ready')
    expect(gets).toEqual([])
  })
})
