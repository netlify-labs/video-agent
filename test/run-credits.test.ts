// Credits for Openverse music a run fetched itself: the strict reader for video/assets/music/credits.json, finalize
// storing it on the version from the saved composition, the merge with library credits, and the share page, embed
// and Video DTO showing them. Revisions keep them because the file travels with the source.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { versionCredits, type Credit } from '../src/domain/credits.js'
import { MAX_RUN_CREDITS, readRunCredits, type RunCredit } from '../src/lib/openverse-rules.js'
import type { VersionProvenanceRow } from '../src/domain/types.js'
import { loadEdge } from './edge.js'
import type { TestDeps } from './fakes.js'
import { harness, PROMPT, type Harness } from './helpers.js'
import { tarGz } from './tarball.js'

let current: TestDeps | null = null
vi.mock('@netlify/blobs', async () => (await import('./edge.js')).fakeBlobsModule(() => current?.blobs))

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const enc = (s: string) => new TextEncoder().encode(s)

const entry = (n: number, o: Record<string, unknown> = {}) => ({
  file: `assets/music/track-${n}.mp3`,
  openverseId: id(n),
  title: `Track ${n}`,
  creator: `Artist ${n}`,
  creatorUrl: `https://www.jamendo.com/artist/${n}`,
  license: 'by',
  licenseVersion: '4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  sourceUrl: `https://www.jamendo.com/track/${n}`,
  attribution: `"Track ${n}" by Artist ${n}`,
  ...o,
})
const audio = (file: string, i = 1) =>
  `<audio id="a${i}" data-va-layer="music" src="${file}" data-start="0" data-duration="10" data-track-index="2"></audio>`

/** A composition's files: index.html playing `played`, the audio files in `files`, and credits.json. */
function composition(credits: unknown, played: string[], files: string[] = played) {
  const m = new Map<string, Uint8Array>([
    ['index.html', enc(`<!doctype html><div id="root">${played.map((f, i) => audio(f, i)).join('')}</div>`)],
    ['assets/music/credits.json', enc(typeof credits === 'string' ? credits : JSON.stringify(credits))],
  ])
  for (const f of files) m.set(f, new Uint8Array([1, 2, 3]))
  return m
}

describe('readRunCredits', () => {
  it('keeps valid entries for files the composition has and plays', () => {
    const r = readRunCredits(
      JSON.stringify([entry(1), entry(2, { license: 'cc0', creator: null, creatorUrl: null })]),
      composition(
        null,
        ['assets/music/track-1.mp3', './assets/music/track-2.mp3'],
        ['assets/music/track-1.mp3', 'assets/music/track-2.mp3'],
      ),
    )
    expect(r.dropped).toBe(0)
    expect(r.credits.map((c) => [c.openverseId, c.license])).toEqual([
      [id(1), 'by'],
      [id(2), 'cc0'],
    ])
  })

  it('drops entries that fail any check', () => {
    const played = ['assets/music/track-1.mp3', 'assets/sfx/click.wav']
    const files = [...played, 'assets/music/silent.mp3']
    const bad = [
      entry(2, { license: 'by-nc' }),
      entry(3, { license: 'by-sa' }),
      entry(4, { sourceUrl: 'javascript:alert(1)' }),
      entry(5, { creatorUrl: 'ftp://example.org/x' }),
      entry(6, { title: 'x'.repeat(201) }),
      entry(7, { title: '' }),
      entry(8, { openverseId: 'not-an-id' }),
      entry(9, { file: '../index.html' }),
      entry(10, { file: 'assets/music/missing.mp3' }),
      // In the composition but no <audio> plays it.
      entry(11, { file: 'assets/music/silent.mp3' }),
      entry(12, { file: 'assets/media/med_abc.mp3' }),
      entry(13, { attribution: 'x'.repeat(1001) }),
      entry(14, { licenseVersion: '4.0<script>' }),
      entry(15, { creator: 42 }),
      // The same Openverse work twice: the first one counts.
      entry(1, { file: 'assets/sfx/click.wav' }),
      'not an object',
      null,
    ]
    const r = readRunCredits(JSON.stringify([entry(1), ...bad]), composition(null, played, files))
    expect(r.credits.map((c) => c.openverseId)).toEqual([id(1)])
    expect(r.dropped).toBe(bad.length)
  })

  it('keeps nothing from a file that is not a JSON array of at most 20 entries', () => {
    const files = composition(null, ['assets/music/track-1.mp3'])
    expect(readRunCredits('{"file":1}', files).credits).toEqual([])
    expect(readRunCredits('nope', files).credits).toEqual([])
    const many = Array.from({ length: MAX_RUN_CREDITS + 1 }, () => entry(1))
    expect(readRunCredits(JSON.stringify(many), files).credits).toEqual([])
  })
})

describe('versionCredits with run credits', () => {
  const v = { n: 1, sound: 'music' as const, voiceover: null }
  const lib = (n: number): VersionProvenanceRow => ({
    versionN: 1,
    mediaId: `med_${n}`,
    position: 0,
    kind: 'audio',
    source: 'openverse',
    sourceId: id(n),
    sourceUrl: `https://www.jamendo.com/track/${n}`,
    sourceTitle: `Library ${n}`,
    license: 'by',
    licenseVersion: '4.0',
    licenseUrl: null,
    creator: `Artist ${n}`,
    creatorUrl: null,
    attribution: null,
  })
  const run = (n: number, o: Partial<RunCredit> = {}) => ({ ...(entry(n) as RunCredit), ...o })

  it('adds CC BY files the run fetched after the library ones, deduped by Openverse id; CC0 needs none', () => {
    const credits = versionCredits([lib(1)], v, [
      run(1),
      run(2),
      run(3, { license: 'cc0' }),
      run(4, { file: 'assets/sfx/click.mp3' }),
    ])
    expect(credits.map((c) => [c.mediaId, c.role, c.title])).toEqual([
      ['med_1', 'Music', 'Library 1'],
      [null, 'Music', 'Track 2'],
      [null, 'Sound effect', 'Track 4'],
    ])
    expect(credits[1]).toMatchObject({
      kind: 'audio',
      source: 'openverse',
      licenseLabel: 'CC BY 4.0',
      text: '"Track 2" by Artist 2, CC BY 4.0, https://www.jamendo.com/track/2',
    })
    expect(versionCredits([], v, null)).toEqual([])
  })
})

describe('credits from the run, end to end', () => {
  beforeEach(() => {
    vi.stubGlobal('Netlify', { env: { get: () => undefined } })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    current = null
  })

  /** The source.tar.gz the next run saves: music it fetched, its credits.json and an index.html that plays it. */
  const source = (credits: unknown[], played = ['assets/music/track-1.mp3']) =>
    tarGz([
      { name: 'video/', type: '5' },
      {
        name: 'video/index.html',
        body: `<!doctype html><div id="root">${played.map((f, i) => audio(f, i)).join('')}</div>`,
      },
      { name: 'video/summary.json', body: '{}' },
      ...played.map((f) => ({ name: `video/${f}`, body: new Uint8Array([0xff, 0xfb, 0x90, 0x00]) })),
      { name: 'video/assets/music/credits.json', body: JSON.stringify(credits) },
    ])
  const versions = async (h: Harness, vid: string) =>
    (
      await h.json<{ versions: { n: number; credits: Credit[] }[] }>(
        await h.call('GET', `/api/v1/videos/${vid}`, { as: h.member }),
      )
    ).versions

  it('records valid credits on the version and shows them on the Video page, embed and share page', async () => {
    const h = harness()
    current = h.deps
    h.deps.nextSource = source([entry(1), entry(9, { license: 'by-nc-sa' })])
    const { id: vid } = await h.json<{ id: string }>(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT, sound: 'music' } }),
    )
    await h.drive(4)
    // The run was told how to find music, since nothing was picked.
    expect(h.deps.runner.starts.at(-1)?.prompt).toContain('npx tsx scripts/openverse.ts search')
    const out = await h.deps.store.getOutput(vid, 1)
    expect(out?.runCredits?.map((c) => c.openverseId)).toEqual([id(1)])
    expect(h.deps.logs.some((l) => l.includes('finalize.run_credits_dropped'))).toBe(true)

    const [v1] = await versions(h, vid)
    expect(v1?.credits).toEqual([
      {
        mediaId: null,
        kind: 'audio',
        role: 'Music',
        title: 'Track 1',
        creator: 'Artist 1',
        creatorUrl: 'https://www.jamendo.com/artist/1',
        license: 'by',
        licenseLabel: 'CC BY 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
        sourceUrl: 'https://www.jamendo.com/track/1',
        source: 'openverse',
        text: '"Track 1" by Artist 1, CC BY 4.0, https://www.jamendo.com/track/1',
      },
    ])
    const pub = await h.json<{ slug: string; embed: string }>(
      await h.call('POST', `/api/v1/videos/${vid}/versions/1/publish`, { as: h.member }),
    )
    expect(pub.embed).toContain('Music: <a href="https://www.jamendo.com/track/1"')
    const page = await (
      await (
        await loadEdge('public')
      )(new Request(`https://video.example.com/v/${pub.slug}`), { deploy: { published: true } })
    ).text()
    expect(page).toContain(
      '<small class="credits" data-credits>Music: <a href="https://www.jamendo.com/track/1"',
    )
    expect(page).not.toContain('Track 9')
  })

  it('a revision keeps the credit while its composition still plays the track, and drops it when not', async () => {
    const h = harness()
    current = h.deps
    h.deps.nextSource = source([entry(1)])
    const { id: vid } = await h.json<{ id: string }>(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT, sound: 'music' } }),
    )
    await h.drive(4)
    // The revision restores the parent's source, so credits.json and the file come with it.
    h.deps.nextSource = source([entry(1)])
    await h.call('POST', `/api/v1/videos/${vid}/versions`, { as: h.member, body: { prompt: 'Warmer.' } })
    await h.drive(4)
    // This one replaced the music, leaving a stale credits.json behind.
    h.deps.nextSource = source([entry(1)], [])
    await h.call('POST', `/api/v1/videos/${vid}/versions`, { as: h.member, body: { prompt: 'No music.' } })
    await h.drive(4)
    const vs = await versions(h, vid)
    expect(vs.map((v) => [v.n, v.credits.map((c) => c.title)])).toEqual([
      [3, []],
      [2, ['Track 1']],
      [1, ['Track 1']],
    ])
  })
})
