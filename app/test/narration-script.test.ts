// scripts/narration.ts (plan 2026-11-02 §6.3 steps 1-5, bead va-2qq.3.9) on the S13 fixtures in a prepared workspace:
// sample counts kept, per-take loudness, bit-exact bypass, same inputs -> same bus, the bus at the root's final length,
// spans and the duck lane written into a contract composition, and the receipt. The bus limiter is tested on its own
// (no ffmpeg); the script cases skip without ffmpeg.
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NARRATION_SRC, load, read, speechSeconds, validate, type Summary } from '../server/lib/contract.js'
import { BUS_LIMITER, floatToPcm16, limitBus, pcm16ToFloat, truePeaks } from '../server/lib/narration-bus.js'
import { LIGHT, gatedLoudness, readPcm16, speechRegions } from '../server/lib/narration-cleanup.js'
import { detectSpeech } from '../server/lib/peaks.js'
import { IDENTITY_FIT, SAMPLE_RATE as S, type NarrationClip, type NarrationOp } from '../server/lib/timeline.js'
import { runNarration } from '../../scripts/narration.js'
import { ebur128, pcmSha256 } from '../../scripts/lib/narration-cleanup.js'
import { narrationPaths, type NarrationInputs } from '../../scripts/lib/narration-inputs.js'
import { which } from '../../scripts/lib/run-tools.js'

const fixture = (name: string) => new URL(`./fixtures/narration/${name}.wav`, import.meta.url).pathname
const composition = (f: string) => new URL(`./fixtures/contract1-voice/${f}`, import.meta.url).pathname
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'va-narration-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('limitBus', () => {
  const sine = (amp: number, n = S) =>
    Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * 997 * i) / S + 0.3))

  it('holds a full-scale signal to the ceiling, keeps its length, and is deterministic', () => {
    const x = sine(0.999)
    const a = limitBus(x)
    expect(a.bus.length).toBe(x.length)
    expect(a.truePeakDb).toBeLessThanOrEqual(BUS_LIMITER.ceilingDbtp)
    expect(Math.max(...truePeaks(a.bus))).toBeLessThanOrEqual(10 ** (BUS_LIMITER.ceilingDbtp / 20))
    expect(a.maxReductionDb).toBeLessThan(-1.9)
    expect(sha(new Uint8Array(floatToPcm16(limitBus(x).bus).buffer))).toBe(
      sha(new Uint8Array(floatToPcm16(a.bus).buffer)),
    )
  })

  it('leaves a bus under the ceiling bit for bit (after PCM16 rounding)', () => {
    const x = pcm16ToFloat(floatToPcm16(sine(0.3)))
    const r = limitBus(x)
    expect(r.limitedSamples).toBe(0)
    expect(r.maxReductionDb).toBe(0)
    expect(Array.from(floatToPcm16(r.bus))).toEqual(Array.from(floatToPcm16(x)))
  })

  it('a lone spike only pulls the gain down around it (look-ahead ramp, then release)', () => {
    const x = sine(0.2, 2 * S)
    x[S] = 1
    const r = limitBus(x)
    const pcm = floatToPcm16(r.bus)
    const before = floatToPcm16(x)
    expect(pcm[S / 2]).toBe(before[S / 2]) // well before the look-ahead
    expect(Math.abs(pcm[S] ?? 0)).toBeLessThan(32768 * 10 ** (BUS_LIMITER.ceilingDbtp / 20))
    expect(pcm[2 * S - 10]).toBe(before[2 * S - 10]) // recovered by the end
  })
})

const ffmpeg = which('ffmpeg')

describe.skipIf(!ffmpeg)('scripts/narration.ts', () => {
  const A = 'med_noisyroom01'
  const B = 'med_punchquiet1'
  const C = 'med_silenceonly'
  const takeFiles: Record<string, string> = { [A]: 'noisy-room', [B]: 'punch-quiet', [C]: 'silence-only' }
  const clip = (o: Partial<NarrationClip> & Pick<NarrationClip, 'id' | 'mediaId'>): NarrationClip => ({
    srcStart: 0,
    srcEnd: 3 * S,
    fit: IDENTITY_FIT,
    offsetSamples: 0,
    start: 0,
    gainDb: 0,
    fadeInSamples: 0,
    fadeOutSamples: 0,
    ...o,
  })
  const op = (cleanup: 'off' | 'light', clips?: NarrationClip[]): NarrationOp => ({
    op: 'narration',
    schema: 1,
    sampleRate: S,
    clips: clips ?? [
      clip({ id: 'a', mediaId: A, srcStart: S / 2, srcEnd: 4 * S, start: S / 2 }),
      clip({ id: 'b', mediaId: B, srcStart: 0, srcEnd: 3 * S, start: 5 * S }),
      clip({ id: 'c', mediaId: C, srcStart: 0, srcEnd: 2 * S, start: 4 * S, gainDb: -3 }),
    ],
    tracks: {
      narration: { volumeDb: 0, muted: false, solo: false },
      aiVoice: { mode: 'replace', volumeDb: -6 },
      music: { duck: true, duckDb: -12 },
      original: { muteAll: false },
    },
    cleanup,
  })

  /** What prepare-run leaves: video/ (a 9 s contract composition) and .va-run/narration/ with three takes. */
  function workspace(o: { cleanup?: 'off' | 'light'; targetSamples?: number; clips?: NarrationClip[] } = {}) {
    const root = tmp()
    const p = narrationPaths(root)
    mkdirSync(join(root, 'video'), { recursive: true })
    mkdirSync(p.src, { recursive: true })
    for (const f of ['index.html', 'summary.json']) copyFileSync(composition(f), join(root, 'video', f))
    const cleanup = o.cleanup ?? 'light'
    const takes = Object.entries(takeFiles).map(([mediaId, name]) => {
      const bytes = new Uint8Array(readFileSync(fixture(name)))
      const path = `.va-run/narration/src/${mediaId}.wav`
      writeFileSync(join(root, path), bytes)
      return {
        mediaId,
        key: `${mediaId}/original.wav`,
        sha256: sha(bytes),
        bytes: bytes.length,
        path,
        wavSha256: sha(bytes),
        samples: readPcm16(bytes).samples.length,
        decoded: false,
      }
    })
    const inputs: NarrationInputs = {
      v: 1,
      jobId: 'vid_1',
      attemptId: 'att_1',
      op: op(cleanup, o.clips),
      recipe: { pipeline: 1, cleanup },
      targetSamples: o.targetSamples ?? 9 * S,
      captions: 'sidecar',
      takes,
    }
    writeFileSync(p.manifest, JSON.stringify(inputs))
    return { root, p, inputs }
  }
  const bus = (root: string) => readPcm16(readFileSync(join(root, 'video', NARRATION_SRC)))

  it('cleans every take without changing its length, to the speech target; silence gets no gain', () => {
    const { root, p } = workspace()
    const r = runNarration({ root })
    for (const [id, name] of Object.entries(takeFiles)) {
      const raw = readPcm16(readFileSync(fixture(name))).samples
      const clean = readPcm16(readFileSync(join(p.clean, `${id}.wav`))).samples
      expect(clean.length).toBe(raw.length)
      expect(r.inputs.find((x) => x.mediaId === id)?.samples).toBe(raw.length)
    }
    const speechTake = r.inputs.find((x) => x.mediaId === A)
    expect(speechTake?.warnings).toEqual([])
    // Per-take loudness: speech regions (gated on the raw take, as cleanTake measures) land on the target.
    for (const id of [A, B]) {
      const raw = readPcm16(readFileSync(fixture(takeFiles[id] ?? ''))).samples
      const clean = readPcm16(readFileSync(join(p.clean, `${id}.wav`))).samples
      const lufs = gatedLoudness(clean, speechRegions(raw)) ?? -99
      expect(Math.abs(lufs - LIGHT.speechTargetLufs)).toBeLessThan(0.5)
    }
    const silent = r.inputs.find((x) => x.mediaId === C)
    expect(silent?.measured).toMatchObject({ preGainDb: 0, trimDb: 0 })
    expect(silent?.warnings.join()).toMatch(/^no_speech/)
    expect(r.warnings.some((w) => w.startsWith(`${C}: no_speech`))).toBe(true)
  })

  it('off is a bit-exact bypass of every take', () => {
    const { root, p } = workspace({ cleanup: 'off' })
    const r = runNarration({ root })
    for (const [id, name] of Object.entries(takeFiles)) {
      expect(pcmSha256(join(p.clean, `${id}.wav`))).toBe(pcmSha256(fixture(name)))
      expect(r.inputs.find((x) => x.mediaId === id)).toMatchObject({ filter: null, measured: null })
    }
  })

  it('same inputs give the same bus PCM, run after run', () => {
    const a = runNarration({ root: workspace().root })
    const b = runNarration({ root: workspace().root })
    expect(b.bus.pcmSha256).toBe(a.bus.pcmSha256)
    expect(b.bus.sha256).toBe(a.bus.sha256)
    expect(b.spans).toEqual(a.spans)
    // And again in place (the composition already carries the narration from the first run).
    const w = workspace()
    runNarration({ root: w.root })
    const html = readFileSync(join(w.root, 'video', 'index.html'), 'utf8')
    expect(runNarration({ root: w.root }).bus.pcmSha256).toBe(a.bus.pcmSha256)
    expect(readFileSync(join(w.root, 'video', 'index.html'), 'utf8')).toBe(html)
  })

  it("mixes at the composition's final root duration: pads past a shorter frozen target, cuts a clip past the end", () => {
    const short = workspace({ targetSamples: 7 * S })
    const r = runNarration({ root: short.root })
    expect(r.target).toEqual({ manifestSamples: 7 * S, samples: 9 * S })
    expect(bus(short.root).samples.length).toBe(9 * S)
    const long = workspace({
      targetSamples: 12 * S,
      clips: [clip({ id: 'late', mediaId: A, srcStart: 0, srcEnd: 6 * S, start: 6 * S })],
    })
    const l = runNarration({ root: long.root })
    expect(l.target).toEqual({ manifestSamples: 12 * S, samples: 9 * S })
    const pcm = bus(long.root).samples
    expect(pcm.length).toBe(9 * S)
    expect(pcm.slice(0, 6 * S).every((v) => v === 0)).toBe(true) // nothing before the clip
  })

  it('writes the bus, its speech spans and the duck lane into the composition, and a receipt', () => {
    const { root, p, inputs } = workspace()
    const before = readFileSync(join(root, 'video', 'index.html'), 'utf8')
    const r = runNarration({ root })
    const html = readFileSync(join(root, 'video', 'index.html'), 'utf8')
    const summary = JSON.parse(readFileSync(join(root, 'video', 'summary.json'), 'utf8')) as Summary
    const pcm = bus(root)
    expect(pcm).toMatchObject({ sampleRate: S, channels: 1 })
    expect(pcm.samples.length).toBe(9 * S)
    expect(validate(html, summary, { narration: { busSamples: pcm.samples.length } })).toEqual([])
    // Spans come from the processed bus, as written.
    expect(r.spans).toEqual(detectSpeech(pcm16ToFloat(pcm.samples)))
    expect(r.spans.length).toBeGreaterThan(0)
    const el = /<audio id="va-narration"[^>]*>/.exec(html)?.[0] ?? ''
    const speech = JSON.parse(/data-va-speech="([^"]*)"/.exec(el)?.[1]?.replace(/&quot;/g, '"') ?? 'null')
    expect(speech).toEqual(speechSeconds(r.spans, 9))
    // The music dips under the narration (and the replaced AI voice no longer counts).
    const music = (h: string) => /<audio id="music"[^>]*data-automation="([^"]*)"/.exec(h)?.[1]
    expect(music(html)).not.toBe(music(before))
    expect(read(load(html)).duration).toBe(9)
    // The bus is pre-limited to -2 dBTP (ffmpeg's own true-peak meter agrees within a tenth of a dB).
    expect(ebur128(join(root, 'video', NARRATION_SRC)).truePeakDb).toBeLessThanOrEqual(
      BUS_LIMITER.ceilingDbtp + 0.1,
    )
    const receipt = JSON.parse(readFileSync(p.receipt, 'utf8')) as typeof r
    expect(receipt).toEqual(r)
    expect(receipt).toMatchObject({
      v: 1,
      pipeline: 1,
      attemptId: 'att_1',
      recipe: { pipeline: 1, cleanup: 'light', vad: 1 },
      bus: { path: NARRATION_SRC, samples: 9 * S, pcmSha256: pcmSha256(join(root, 'video', NARRATION_SRC)) },
    })
    expect(receipt.recipe.ffmpeg).toMatch(/^ffmpeg version /)
    expect(receipt.inputs.map((x) => [x.mediaId, x.sha256])).toEqual(
      inputs.takes.map((t) => [t.mediaId, t.sha256]),
    )
    expect(receipt.inputs.every((x) => /^[0-9a-f]{64}$/.test(x.cleanSha256))).toBe(true)
  })

  it('a muted narration track gives a silent bus and no speech', () => {
    const w = workspace()
    const inputs = JSON.parse(readFileSync(w.p.manifest, 'utf8')) as NarrationInputs
    inputs.op.tracks.narration.muted = true
    writeFileSync(w.p.manifest, JSON.stringify(inputs))
    const r = runNarration({ root: w.root })
    expect(r.spans).toEqual([])
    expect(bus(w.root).samples.every((v) => v === 0)).toBe(true)
  })

  it('refuses a take that changed after hydration, and an attempt mismatch', () => {
    const w = workspace()
    writeFileSync(join(w.p.src, `${A}.wav`), readFileSync(fixture('usb-hot')))
    expect(() => runNarration({ root: w.root })).toThrow(/changed since prepare-run/)
    const x = workspace()
    mkdirSync(join(x.root, '.render'))
    writeFileSync(join(x.root, '.render', 'run-manifest.json'), JSON.stringify({ attemptId: 'att_other' }))
    expect(() => runNarration({ root: x.root })).toThrow(/different attempt/)
  })
})
