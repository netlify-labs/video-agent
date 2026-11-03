// Recorded narration's run inputs (plan 2026-11-02 §6.3 "Run inputs", bead va-2qq.3.7): prepare-run fetches each
// frozen take by key from the media store into .va-run/narration/ (never video/), checks it, decodes non-PCM uploads,
// and the archive assertion refuses a video/ that holds a copy of one. ffmpeg-dependent cases skip without ffmpeg.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NARRATION_SRC } from '../src/lib/contract.js'
import { readPcm16 } from '../src/lib/narration-cleanup.js'
import type { FrozenNarration, RunManifest } from '../src/lib/run-manifest.js'
import { IDENTITY_FIT, SAMPLE_RATE } from '../src/lib/timeline.js'
import { hydrateNarration, prepare, probeAudio } from '../scripts/prepare-run.js'
import { narrationPaths, readNarrationInputs } from '../scripts/lib/narration-inputs.js'
import { assertNoTakesInVideo, which } from '../scripts/lib/run-tools.js'

const fixture = (name: string) => new URL(`./fixtures/narration/${name}.wav`, import.meta.url).pathname
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const ffmpeg = which('ffmpeg') && which('ffprobe')

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'va-hydrate-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const A = 'med_take0000a'
const B = 'med_take0000b'
const narration = (takes: { mediaId: string; ext: string; bytes: Uint8Array }[]): FrozenNarration => ({
  op: {
    op: 'narration',
    schema: 1,
    sampleRate: SAMPLE_RATE,
    clips: takes.map((t, i) => ({
      id: `c${i}`,
      mediaId: t.mediaId,
      srcStart: 0,
      srcEnd: SAMPLE_RATE,
      fit: IDENTITY_FIT,
      offsetSamples: 0,
      start: i * SAMPLE_RATE,
      gainDb: 0,
      fadeInSamples: 0,
      fadeOutSamples: 0,
    })),
    tracks: {
      narration: { volumeDb: 0, muted: false, solo: false },
      aiVoice: { mode: 'replace', volumeDb: -6 },
      music: { duck: true, duckDb: -12 },
      original: { muteAll: false },
    },
    cleanup: 'light',
  },
  takes: takes.map((t) => ({
    mediaId: t.mediaId,
    key: `${t.mediaId}/original.${t.ext}`,
    sha256: sha(t.bytes),
    bytes: t.bytes.length,
  })),
  recipe: { pipeline: 1, cleanup: 'light' },
  targetSamples: 9 * SAMPLE_RATE,
  captions: 'sidecar',
})

/** A media store in memory; `fetch` follows prepare-run's signature (key, to, store). */
function store(blobs: Record<string, Uint8Array>) {
  const calls: [string, string | undefined][] = []
  return {
    calls,
    fetch: async (key: string, to: string, s?: string) => {
      calls.push([key, s])
      const b = blobs[key]
      if (!b) throw new Error(`no blob ${key}`)
      writeFileSync(to, b)
    },
  }
}

describe.skipIf(!ffmpeg)('hydrateNarration', () => {
  const m = { jobId: 'vid_1', attemptId: 'att_1' }

  it('puts recordings in .va-run/narration/src/ as they are, never under video/, with a manifest', async () => {
    const root = tmp()
    const a = new Uint8Array(readFileSync(fixture('punch-quiet')))
    const b = new Uint8Array(readFileSync(fixture('silence-only')))
    const n = narration([
      { mediaId: A, ext: 'wav', bytes: a },
      { mediaId: B, ext: 'wav', bytes: b },
    ])
    const s = store({ [`${A}/original.wav`]: a, [`${B}/original.wav`]: b })
    const inputs = await hydrateNarration(root, m, n, s.fetch)
    expect(s.calls).toEqual([
      [`${A}/original.wav`, 'media'],
      [`${B}/original.wav`, 'media'],
    ])
    const p = narrationPaths(root)
    expect(new Uint8Array(readFileSync(join(p.src, `${A}.wav`)))).toEqual(a)
    expect(existsSync(p.fetch)).toBe(false)
    expect(existsSync(join(root, 'video'))).toBe(false)
    expect(inputs?.takes[0]).toMatchObject({
      mediaId: A,
      sha256: sha(a),
      wavSha256: sha(a),
      path: `.va-run/narration/src/${A}.wav`,
      samples: readPcm16(a).samples.length,
      decoded: false,
    })
    expect(readNarrationInputs(root)).toEqual(inputs)
    expect(inputs).toMatchObject({ attemptId: 'att_1', targetSamples: 9 * SAMPLE_RATE, recipe: n.recipe })
  })

  it('a take that does not match its hash or size stops the run and leaves nothing behind', async () => {
    const root = tmp()
    const a = new Uint8Array(readFileSync(fixture('punch-quiet')))
    const n = narration([{ mediaId: A, ext: 'wav', bytes: a }])
    const tampered = a.slice()
    tampered[1000] = (tampered[1000] ?? 0) ^ 1
    await expect(
      hydrateNarration(root, m, n, store({ [`${A}/original.wav`]: tampered }).fetch),
    ).rejects.toThrow(/doesn't match its hash/)
    expect(existsSync(narrationPaths(root).dir)).toBe(false)
  })

  it('decodes a non-WAV upload (44.1 kHz stereo MP3) to 24 kHz mono PCM16, keeping the original digest', async () => {
    const root = tmp()
    const mp3 = join(root, 'in.mp3')
    execFileSync('ffmpeg', [
      ...['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=440:r=44100:d=1.5'],
      ...['-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', mp3],
    ])
    const bytes = new Uint8Array(readFileSync(mp3))
    const n = narration([{ mediaId: A, ext: 'mp3', bytes }])
    const inputs = await hydrateNarration(root, m, n, store({ [`${A}/original.mp3`]: bytes }).fetch)
    const t = inputs?.takes[0]
    const pcm = readPcm16(readFileSync(join(root, t?.path ?? '')))
    expect(pcm).toMatchObject({ sampleRate: SAMPLE_RATE, channels: 1 })
    expect(t).toMatchObject({
      sha256: sha(bytes),
      bytes: bytes.length,
      decoded: true,
      samples: pcm.samples.length,
    })
    expect(t?.wavSha256).not.toBe(t?.sha256)
    expect(Math.abs(pcm.samples.length - 1.5 * SAMPLE_RATE)).toBeLessThan(0.1 * SAMPLE_RATE)
  })

  it('decodes a WebM/Opus upload to 24 kHz mono PCM16, and refuses a WebM with video (§5.2)', async () => {
    const root = tmp()
    const webm = join(root, 'in.webm')
    execFileSync('ffmpeg', [
      ...['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=1.5'],
      ...['-ac', '2', '-c:a', 'libopus', '-b:a', '48k', webm],
    ])
    const bytes = new Uint8Array(readFileSync(webm))
    const n = narration([{ mediaId: A, ext: 'webm', bytes }])
    const inputs = await hydrateNarration(root, m, n, store({ [`${A}/original.webm`]: bytes }).fetch)
    const pcm = readPcm16(readFileSync(join(root, inputs?.takes[0]?.path ?? '')))
    expect(pcm).toMatchObject({ sampleRate: SAMPLE_RATE, channels: 1 })
    expect(inputs?.takes[0]).toMatchObject({ decoded: true, samples: pcm.samples.length })
    expect(Math.abs(pcm.samples.length - 1.5 * SAMPLE_RATE)).toBeLessThan(0.1 * SAMPLE_RATE)
    // The upload check refuses this; the run checks again, as it does for library audio.
    const av = join(root, 'av.webm')
    execFileSync('ffmpeg', [
      ...['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=s=64x36:d=1'],
      ...['-f', 'lavfi', '-i', 'sine=d=1', '-c:v', 'libvpx-vp9', '-c:a', 'libopus', '-shortest', av],
    ])
    const avBytes = new Uint8Array(readFileSync(av))
    await expect(
      hydrateNarration(
        tmp(),
        m,
        narration([{ mediaId: A, ext: 'webm', bytes: avBytes }]),
        store({ [`${A}/original.webm`]: avBytes }).fetch,
      ),
    ).rejects.toThrow(/has a video track/)
    expect(() => probeAudio(av, 'av.webm')).toThrow(/has a video track/)
    expect(() => probeAudio(webm, 'in.webm')).not.toThrow()
  })

  it('prepare() clears stale inputs on a run without narration; the next hydration writes its own', async () => {
    const root = tmp()
    const a = new Uint8Array(readFileSync(fixture('punch-loud')))
    const base: RunManifest = {
      v: 1,
      jobId: 'vid_1',
      attemptId: 'att_2',
      versionN: 2,
      kind: 'author',
      source: null,
      bundle: null,
      media: null,
      feedback: null,
    }
    mkdirSync(narrationPaths(root).src, { recursive: true })
    writeFileSync(join(narrationPaths(root).src, 'stale.wav'), 'old')
    await prepare(base, { tmp: root, root, fetch: store({}).fetch })
    expect(existsSync(narrationPaths(root).dir)).toBe(false)
    await hydrateNarration(
      root,
      base,
      narration([{ mediaId: A, ext: 'wav', bytes: a }]),
      store({ [`${A}/original.wav`]: a }).fetch,
    )
    expect(readNarrationInputs(root)?.attemptId).toBe('att_2')
  })
})

describe('assertNoTakesInVideo', () => {
  /** A prepared workspace: one hydrated take (stored original = mp3 bytes, local WAV) and a video/. */
  function workspace() {
    const root = tmp()
    const p = narrationPaths(root)
    mkdirSync(p.src, { recursive: true })
    mkdirSync(join(root, 'video', 'assets', 'narration'), { recursive: true })
    const wav = new Uint8Array(readFileSync(fixture('punch-quiet')))
    const original = new TextEncoder().encode('ID3 pretend mp3 bytes of the uploaded original')
    writeFileSync(join(p.src, `${A}.wav`), wav)
    writeFileSync(
      p.manifest,
      JSON.stringify({
        takes: [{ mediaId: A, sha256: sha(original), bytes: original.length, wavSha256: sha(wav) }],
      }),
    )
    writeFileSync(join(root, 'video', 'index.html'), '<html></html>')
    return { root, p, wav, original }
  }

  it('passes a clean video/ and a workspace without narration', () => {
    const { root } = workspace()
    expect(() => assertNoTakesInVideo(root)).not.toThrow()
    expect(() => assertNoTakesInVideo(tmp())).not.toThrow()
  })

  it('fails when a hydrated take is copied anywhere under video/, even renamed', () => {
    const { root, p } = workspace()
    copyFileSync(join(p.src, `${A}.wav`), join(root, 'video', 'assets', 'voice-over.wav'))
    expect(() => assertNoTakesInVideo(root)).toThrow(/video\/assets\/voice-over\.wav/)
  })

  it("fails on a copy of the stored original (whose bytes aren't on disk any more) and of a clean take", () => {
    const { root, p, original } = workspace()
    writeFileSync(join(root, 'video', 'take.mp3'), original)
    expect(() => assertNoTakesInVideo(root)).toThrow(/video\/take\.mp3/)
    rmSync(join(root, 'video', 'take.mp3'))
    mkdirSync(p.clean, { recursive: true })
    writeFileSync(join(p.clean, `${A}.wav`), 'cleaned take bytes')
    writeFileSync(join(root, 'video', 'c.wav'), 'cleaned take bytes')
    expect(() => assertNoTakesInVideo(root)).toThrow(/video\/c\.wav/)
  })

  it('fails on a link into .va-run/', () => {
    const { root, p } = workspace()
    symlinkSync(join(p.src, `${A}.wav`), join(root, 'video', 'link.wav'))
    expect(() => assertNoTakesInVideo(root)).toThrow(/video\/link\.wav/)
  })

  it('lets the bus through only when it is the one the receipt names', () => {
    const { root, p, wav } = workspace()
    const bus = join(root, 'video', NARRATION_SRC)
    writeFileSync(bus, wav) // a bypassed single-clip bus can equal its take
    expect(() => assertNoTakesInVideo(root)).toThrow(/bus\.wav/)
    writeFileSync(p.receipt, JSON.stringify({ bus: { sha256: sha(wav) } }))
    expect(() => assertNoTakesInVideo(root)).not.toThrow()
  })
})
