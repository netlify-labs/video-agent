// Run manifests and frozen bundles (plan v2 §14 rule 21): the server writes what a run restores and pins its hash
// in the prompt; prepare-run follows only those keys and stops on any mismatch.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { feedbackStills, prepare } from '../scripts/prepare-run.js'
import { uploadReferences } from '../scripts/lib/references.js'
import { archiveFiles, bundleManifest, compositionFiles, excluded } from '../src/lib/bundle-manifest.js'
import { isReference, REFERENCE_FILES, type BundleReference } from '../src/lib/bundle-references.js'
import { NARRATION_SRC } from '../src/lib/contract.js'
import {
  RUN_MANIFEST_VERSION,
  runManifestKey,
  serializeRunManifest,
  sha256Hex,
  verifyRunManifest,
  type RunManifest,
} from '../src/lib/run-manifest.js'
import { harness } from './helpers.js'

const H = (c: string) => c.repeat(64)
const base: RunManifest = {
  v: RUN_MANIFEST_VERSION,
  jobId: 'vid_1',
  attemptId: 'att_1',
  versionN: 2,
  kind: 'revision',
  source: { key: 'vid_1/v1/source.tar.gz', sha256: H('a'), parentN: 1 },
  bundle: null,
  media: null,
  feedback: null,
}
const verify = (m: RunManifest, raw = serializeRunManifest(m)) =>
  verifyRunManifest(raw, { attemptId: 'att_1', sha256: sha256Hex(raw) })

/** A temp workspace with video/ holding a small composition, archived like render-job does. */
function workspace(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'va-run-'))
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(root, 'video', p, '..'), { recursive: true })
    writeFileSync(join(root, 'video', p), body)
  }
  const archive = join(root, 'source.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', root, 'video'])
  return { root, archive, sha256: sha256Hex(readFileSync(archive)) }
}

describe('run manifest', () => {
  it('carries lines to re-voice only when there are some, and checks them', () => {
    const ru: RunManifest = {
      ...base,
      kind: 'render_unchanged',
      source: null,
      bundle: { key: 'vid_1/v2/frozen.tar.gz', sha256: H('b'), manifestHash: H('c') },
    }
    expect(serializeRunManifest(ru)).not.toContain('revoice')
    const withLines = { ...ru, bundle: { ...ru.bundle!, revoice: { beats: ['intro'], keptHash: H('d') } } }
    expect(verify(withLines).bundle?.revoice).toEqual({ beats: ['intro'], keptHash: H('d') })
    for (const revoice of [
      { beats: [], keptHash: H('d') },
      { beats: ['Intro!'], keptHash: H('d') },
      { beats: ['intro'], keptHash: 'nope' },
    ])
      expect(() => verify({ ...ru, bundle: { ...ru.bundle!, revoice } })).toThrow(/re-voice/)
  })

  it('accepts a well-formed manifest whose hash matches the prompt', () => {
    expect(verify(base).source?.key).toBe('vid_1/v1/source.tar.gz')
  })

  it('stops on a hash mismatch, another attempt, or keys outside the video', () => {
    const raw = serializeRunManifest(base)
    expect(() => verifyRunManifest(raw, { attemptId: 'att_1', sha256: H('0') })).toThrow(
      /hash in your prompt/,
    )
    expect(() => verifyRunManifest(raw, { attemptId: 'att_2', sha256: sha256Hex(raw) })).toThrow(
      /different attempt/,
    )
    const other = { ...base, source: { ...base.source!, key: 'vid_2/v1/source.tar.gz' } }
    expect(() => verify(other)).toThrow(/bad source/)
    const dots = { ...base, source: { ...base.source!, key: 'vid_1/../vid_2/source.tar.gz' } }
    expect(() => verify(dots)).toThrow(/bad source/)
    expect(() => verify({ ...base, source: null })).toThrow(/needs a source/)
    expect(() => verify({ ...base, kind: 'render_unchanged', source: null })).toThrow(/needs a bundle/)
    expect(() => verify(base, '{not json')).toThrow()
    const video = { key: 'vid_1/v1/video.mp4', sha256: H('f') }
    const pin = { commentId: 'c_1', timeSec: 1, x: 0.5, y: 0.5 }
    expect(verify({ ...base, feedback: { video, pins: [pin] } }).feedback?.pins).toHaveLength(1)
    expect(() => verify({ ...base, feedback: { video, pins: [{ ...pin, x: 2 }] } })).toThrow(
      /bad feedback pin/,
    )
    expect(() => verify({ ...base, feedback: { video, pins: [{ ...pin, commentId: '../x' }] } })).toThrow(
      /bad feedback pin/,
    )
    expect(() =>
      verify({ ...base, feedback: { video: { ...video, key: 'vid_9/v1/video.mp4' }, pins: [] } }),
    ).toThrow(/bad feedback video/)
  })

  it('carries reference files only when there are some, and checks them', () => {
    expect(serializeRunManifest(base)).not.toContain('references')
    const ref: BundleReference = {
      path: NARRATION_SRC,
      key: 'vid_1/v1/narration-bus.wav',
      sha256: H('a'),
      bytes: 10,
    }
    expect(verify({ ...base, source: { ...base.source!, references: [ref] } }).source?.references).toEqual([
      ref,
    ])
    const ru: RunManifest = {
      ...base,
      kind: 'render_unchanged',
      source: null,
      bundle: { key: 'vid_1/v2/frozen.tar.gz', sha256: H('b'), manifestHash: H('c'), references: [ref] },
    }
    expect(verify(ru).bundle?.references).toEqual([ref])
    for (const references of [
      [ref, ref],
      [{ ...ref, key: 'vid_2/v1/narration-bus.wav' }],
      [{ ...ref, key: 'vid_1/v1/../x/narration-bus.wav' }],
      [{ ...ref, key: 'vid_1/v1/video.mp4' }],
      [{ ...ref, path: 'index.html' }],
      [{ ...ref, sha256: 'x' }],
      [{ ...ref, bytes: -1 }],
    ])
      expect(() => verify({ ...base, source: { ...base.source!, references } })).toThrow(/bad reference/)
  })

  it('serializes the same inputs to the same bytes', () => {
    const { bundle, kind, ...rest } = base
    const reordered: RunManifest = { bundle, ...rest, kind }
    expect(serializeRunManifest(reordered)).toBe(serializeRunManifest(base))
  })
})

describe('bundle manifest', () => {
  it('hashes composition files and media digests, not library media bytes, caches or renders', () => {
    const { root } = workspace({
      'index.html': '<div>hi</div>',
      'summary.json': '{}',
      'assets/logo.svg': '<svg/>',
      'assets/media/med_abc123.mp4': 'library bytes',
      // Files the agent made itself are part of the composition, clips included.
      'assets/media/poster.png': 'agent bytes',
      'assets/media/clip.mp4': 'agent clip',
      'out.mp4': 'stray render',
      '.hyperframes/cache': 'x',
      'renders/out.mp4': 'x',
    })
    const m = bundleManifest(join(root, 'video'), [{ id: 'med_1', sha256: H('b') }])
    expect(m.files.map((f) => f.path)).toEqual([
      'assets/logo.svg',
      'assets/media/clip.mp4',
      'assets/media/poster.png',
      'index.html',
      'summary.json',
    ])
    expect(compositionFiles(join(root, 'video'))).toEqual(m.files.map((f) => f.path))
    expect(bundleManifest(join(root, 'video'), [{ id: 'med_1', sha256: H('b') }]).hash).toBe(m.hash)
    expect(bundleManifest(join(root, 'video'), [{ id: 'med_1', sha256: H('c') }]).hash).not.toBe(m.hash)
    writeFileSync(join(root, 'video', 'index.html'), '<div>changed</div>')
    expect(bundleManifest(join(root, 'video'), [{ id: 'med_1', sha256: H('b') }]).hash).not.toBe(m.hash)
    expect(excluded('node_modules/x/y.js')).toBe(true)
    expect(excluded('scenes/one.html')).toBe(false)
  })

  it('a composition without reference files hashes exactly as before them', () => {
    const { root } = workspace({ 'index.html': '<div>hi</div>', 'summary.json': '{}' })
    const m = bundleManifest(join(root, 'video'))
    expect(m.references).toEqual([])
    expect(archiveFiles(join(root, 'video'))).toEqual(compositionFiles(join(root, 'video')))
    // The v1 canonical form, spelled out: what versions frozen before reference entries pinned.
    const files = [
      ['index.html', sha256Hex('<div>hi</div>')],
      ['summary.json', sha256Hex('{}')],
    ]
    expect(m.hash).toBe(sha256Hex(JSON.stringify({ v: 1, files, media: [] })))
  })

  it('counts the narration bus in the hash but keeps it out of the archive', () => {
    expect(REFERENCE_FILES[NARRATION_SRC]).toBe('narration-bus.wav')
    expect(isReference(NARRATION_SRC)).toBe(true)
    expect(isReference('assets/narration/other.wav')).toBe(false)
    expect(excluded(NARRATION_SRC)).toBe(false)
    const plain = workspace({ 'index.html': '<div>hi</div>' })
    const { root } = workspace({ 'index.html': '<div>hi</div>', [NARRATION_SRC]: 'RIFF bus' })
    const m = bundleManifest(join(root, 'video'))
    expect(m.files.map((f) => f.path)).toEqual([NARRATION_SRC, 'index.html'])
    expect(m.references).toEqual([{ path: NARRATION_SRC, sha256: sha256Hex('RIFF bus'), bytes: 8 }])
    expect(archiveFiles(join(root, 'video'))).toEqual(['index.html'])
    expect(m.hash).not.toBe(bundleManifest(join(plain.root, 'video')).hash)
  })

  it('uploads each reference file under the attempt id and lists it for the manifest', async () => {
    const { root } = workspace({ 'index.html': '<div>hi</div>', [NARRATION_SRC]: 'RIFF bus' })
    const sent: [string, string][] = []
    const refs = await uploadReferences('att_1', join(root, 'video'), async (key, file) => {
      sent.push([key, readFileSync(file, 'utf8')])
    })
    expect(sent).toEqual([['att_1/narration-bus.wav', 'RIFF bus']])
    expect(refs).toEqual([{ path: NARRATION_SRC, sha256: sha256Hex('RIFF bus'), bytes: 8 }])
    const none = workspace({ 'index.html': '<div>hi</div>' })
    expect(await uploadReferences('att_1', join(none.root, 'video'), async () => {})).toEqual([])
  })
})

describe('prepare-run restore', () => {
  const fetchFrom = (archive: string) => async (_key: string, to: string) => {
    copyFileSync(archive, to)
  }

  it('restores a revision source and a frozen bundle whose files match', async () => {
    const src = workspace({ 'index.html': '<div>v1</div>', 'summary.json': '{}' })
    const target = mkdtempSync(join(tmpdir(), 'va-target-'))
    mkdirSync(join(target, 'video'))
    writeFileSync(join(target, 'video', 'index.html'), 'template')
    await prepare(
      { ...base, source: { key: 'vid_1/v1/source.tar.gz', sha256: src.sha256, parentN: 1 } },
      { tmp: target, root: target, fetch: fetchFrom(src.archive) },
    )
    expect(readFileSync(join(target, 'video', 'index.html'), 'utf8')).toBe('<div>v1</div>')

    const manifestHash = bundleManifest(join(src.root, 'video')).hash
    const bundle = { key: 'vid_1/v2/bundle.tar.gz', sha256: src.sha256, manifestHash }
    await prepare(
      { ...base, kind: 'render_unchanged', source: null, bundle },
      { tmp: target, root: target, fetch: fetchFrom(src.archive) },
    )
    expect(readFileSync(join(target, 'video', 'summary.json'), 'utf8')).toBe('{}')
  })

  it('restores reference files by key next to the archive, before the bundle hash is checked', async () => {
    const full = workspace({ 'index.html': '<div>v1</div>', [NARRATION_SRC]: 'RIFF bus' })
    // What render-job archives: everything but the bus.
    const archive = join(full.root, 'archived.tar.gz')
    execFileSync('tar', ['-czf', archive, '-C', full.root, 'video/index.html'])
    const sha256 = sha256Hex(readFileSync(archive))
    const busFile = join(full.root, 'video', NARRATION_SRC)
    const fetchBoth = async (key: string, to: string, store?: string) => {
      copyFileSync(store === 'videos' && key === 'vid_1/v1/narration-bus.wav' ? busFile : archive, to)
    }
    const ref = {
      path: NARRATION_SRC,
      key: 'vid_1/v1/narration-bus.wav',
      sha256: sha256Hex('RIFF bus'),
      bytes: 8,
    }
    const target = mkdtempSync(join(tmpdir(), 'va-target-'))
    await prepare(
      { ...base, source: { key: 'vid_1/v1/source.tar.gz', sha256, parentN: 1, references: [ref] } },
      { tmp: target, root: target, fetch: fetchBoth },
    )
    expect(readFileSync(join(target, 'video', NARRATION_SRC), 'utf8')).toBe('RIFF bus')

    const manifestHash = bundleManifest(join(full.root, 'video')).hash
    const bundle = { key: 'vid_1/v2/bundle.tar.gz', sha256, manifestHash, references: [ref] }
    await prepare(
      { ...base, kind: 'render_unchanged', source: null, bundle },
      { tmp: target, root: target, fetch: fetchBoth },
    )
    expect(bundleManifest(join(target, 'video')).hash).toBe(manifestHash)
  })

  it('stops when a reference file does not match its entry', async () => {
    const src = workspace({ 'index.html': '<div>v1</div>' })
    const target = mkdtempSync(join(tmpdir(), 'va-target-'))
    const ref = { path: NARRATION_SRC, key: 'vid_1/v1/narration-bus.wav', sha256: H('9'), bytes: 8 }
    await expect(
      prepare(
        {
          ...base,
          source: { key: 'vid_1/v1/source.tar.gz', sha256: src.sha256, parentN: 1, references: [ref] },
        },
        { tmp: target, root: target, fetch: fetchFrom(src.archive) },
      ),
    ).rejects.toThrow(/bus\.wav doesn't match its hash/)
    expect(existsSync(join(target, 'video', NARRATION_SRC))).toBe(false)
  })

  it('stops, leaving video/ alone, when the archive hash is wrong', async () => {
    const src = workspace({ 'index.html': '<div>v1</div>' })
    const target = mkdtempSync(join(tmpdir(), 'va-target-'))
    mkdirSync(join(target, 'video'))
    writeFileSync(join(target, 'video', 'index.html'), 'template')
    await expect(
      prepare(
        { ...base, source: { key: 'vid_1/v1/source.tar.gz', sha256: H('d'), parentN: 1 } },
        { tmp: target, root: target, fetch: fetchFrom(src.archive) },
      ),
    ).rejects.toThrow(/doesn't match its hash/)
    expect(readFileSync(join(target, 'video', 'index.html'), 'utf8')).toBe('template')
  })

  it("stops when a bundle's files don't match its manifest", async () => {
    const src = workspace({ 'index.html': '<div>v1</div>' })
    const target = mkdtempSync(join(tmpdir(), 'va-target-'))
    const bundle = { key: 'vid_1/v2/bundle.tar.gz', sha256: src.sha256, manifestHash: H('e') }
    await expect(
      prepare(
        { ...base, kind: 'render_unchanged', source: null, bundle },
        { tmp: target, root: target, fetch: fetchFrom(src.archive) },
      ),
    ).rejects.toThrow(/don't match its manifest/)
  })

  it('refuses archives with entries outside video/', async () => {
    const root = mkdtempSync(join(tmpdir(), 'va-evil-'))
    writeFileSync(join(root, 'AGENTS.md'), 'evil')
    const archive = join(root, 'evil.tar.gz')
    execFileSync('tar', ['-czf', archive, '-C', root, 'AGENTS.md'])
    const target = mkdtempSync(join(tmpdir(), 'va-target-'))
    await expect(
      prepare(
        {
          ...base,
          source: { key: 'vid_1/v1/source.tar.gz', sha256: sha256Hex(readFileSync(archive)), parentN: 1 },
        },
        { tmp: target, root: target, fetch: fetchFrom(archive) },
      ),
    ).rejects.toThrow(/unexpected entry/)
  })
})

/** The RGB of one pixel of a JPEG, via ffmpeg. */
function pixel(file: string, x: number, y: number) {
  const out = execFileSync('ffmpeg', [
    '-loglevel',
    'error',
    '-i',
    file,
    '-vf',
    `format=rgb24,crop=1:1:${x}:${y}`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-',
  ])
  return [out[0] ?? 0, out[1] ?? 0, out[2] ?? 0] as const
}

describe('feedback stills', () => {
  it('makes one still per pin with a dot at the spot, and an index for the agent', () => {
    const root = mkdtempSync(join(tmpdir(), 'va-fb-'))
    mkdirSync(join(root, 'video'))
    const mp4 = join(process.cwd(), 'test/fixtures/a169.mp4')
    const index = feedbackStills(root, mp4, [
      { commentId: 'c_dot', timeSec: 0.5, x: 0.25, y: 0.5 },
      { commentId: 'c_moment', timeSec: 0.5, x: null, y: null },
      { commentId: 'c_late', timeSec: 9999, x: 0.75, y: 0.25 },
    ])
    expect(index.map((i) => i.still)).toEqual([
      'feedback/01-c_dot.jpg',
      'feedback/02-c_moment.jpg',
      'feedback/03-c_late.jpg',
    ])
    const probe = (f: string) =>
      execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f], {
        encoding: 'utf8',
      }).trim()
    const [w, h] = probe(join(root, 'video', 'feedback/01-c_dot.jpg'))
      .split(',')
      .map(Number) as [number, number]
    const [r, g, b] = pixel(
      join(root, 'video', 'feedback/01-c_dot.jpg'),
      Math.round(w * 0.25),
      Math.round(h * 0.5),
    )
    expect(r).toBeGreaterThan(180)
    expect(g).toBeLessThan(90)
    expect(b).toBeLessThan(90)
    // No spot, no dot.
    const plain = pixel(
      join(root, 'video', 'feedback/02-c_moment.jpg'),
      Math.round(w * 0.25),
      Math.round(h * 0.5),
    )
    expect(plain[0] > 180 && plain[1] < 90).toBe(false)
    // A pin past the end still gets the last frame, with its dot.
    const late = pixel(
      join(root, 'video', 'feedback/03-c_late.jpg'),
      Math.round(w * 0.75),
      Math.round(h * 0.25),
    )
    expect(late[0]).toBeGreaterThan(180)
    const written = JSON.parse(readFileSync(join(root, 'video', 'feedback', 'index.json'), 'utf8'))
    expect(written[0]).toMatchObject({ commentId: 'c_dot', timeSec: 0.5, x: 0.25, y: 0.5 })
    // Stills stay out of the composition's hash.
    expect(bundleManifest(join(root, 'video')).files).toEqual([])
  })

  it('prepare-run checks the parent video hash before making stills', async () => {
    const target = mkdtempSync(join(tmpdir(), 'va-fb-'))
    mkdirSync(join(target, 'video'))
    const mp4 = join(process.cwd(), 'test/fixtures/a169.mp4')
    const feedback = {
      video: { key: 'vid_1/v1/video.mp4', sha256: H('0') },
      pins: [{ commentId: 'c_1', timeSec: 0.5, x: 0.5, y: 0.5 }],
    }
    const fetch = async (_key: string, to: string) => {
      copyFileSync(mp4, to)
    }
    await expect(
      prepare({ ...base, kind: 'author', source: null, feedback }, { tmp: target, root: target, fetch }),
    ).rejects.toThrow(/parent video doesn't match/)
    const good = { ...feedback, video: { ...feedback.video, sha256: sha256Hex(readFileSync(mp4)) } }
    await prepare(
      { ...base, kind: 'author', source: null, feedback: good },
      { tmp: target, root: target, fetch },
    )
    expect(readFileSync(join(target, 'video', 'feedback', 'index.json'), 'utf8')).toContain('c_1')
  })
})

describe('server side', () => {
  it('writes the run manifest for a revision and pins its hash in the prompt', async () => {
    const h = harness()
    const v = await h.json(
      await h.call('POST', '/api/v1/videos', {
        as: h.member,
        body: { prompt: 'A short launch video for org webhooks, with three beats and an end card.' },
      }),
    )
    await h.drive(4)
    expect(h.deps.runner.starts.at(-1)?.prompt).not.toContain('prepare-run')
    await h.call('POST', `/api/v1/videos/${v.id}/versions`, {
      as: h.member,
      body: { prompt: 'Warmer colours.' },
    })
    await h.drive(4)
    const req = h.deps.runner.starts[1]
    const attemptId = req?.requestId ?? ''
    const m = /prepare-run\.ts --job (\S+) --attempt (\S+) --manifest ([0-9a-f]{64})/.exec(req?.prompt ?? '')
    expect(m?.[1]).toBe(v.id)
    expect(m?.[2]).toBe(attemptId)
    const raw = await h.deps.blobs.get('sources', runManifestKey(v.id, attemptId))
    const text = new TextDecoder().decode(raw ?? new Uint8Array())
    const parsed = verifyRunManifest(text, { attemptId, sha256: m?.[3] ?? '' })
    expect(parsed).toMatchObject({ kind: 'revision', versionN: 2, source: { parentN: 1 } })
    expect(parsed.source?.key.startsWith(`${v.id}/`)).toBe(true)
  })
})
