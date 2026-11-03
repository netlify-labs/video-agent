// The keep-visuals guard (plan 2026-11-02 §6.3, bead va-2qq.3.10): narration-run.ts's one order of steps, and
// checkNarration over a prepared workspace after scripts/narration.ts (cleanup off, so no ffmpeg is needed): a clean
// run passes, alone and after a re-voice, and every tamper fails with its reason.
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { revoiceVideo } from '../scripts/voice.js'
import { runNarration } from '../scripts/narration.js'
import type { Snapshot } from '../scripts/lib/hold-still.js'
import { applyNarrationCaptions } from '../scripts/lib/narration-captions.js'
import { readSttRecord, type SttRecord } from '../scripts/lib/stt/index.js'
import {
  narrationPaths,
  readNarrationReceipt,
  type NarrationInputs,
} from '../scripts/lib/narration-inputs.js'
import { bundleManifest } from '../src/lib/bundle-manifest.js'
import {
  applyEdits,
  applyNarration,
  HOLD_STILL_SRC,
  holdBeatOf,
  load,
  NARRATION_SRC,
  type Summary,
} from '../src/lib/contract.js'
import { readPcm16 } from '../src/lib/narration-cleanup.js'
import { checkNarration } from '../src/lib/narration-guard.js'
import {
  frozenFilesFor,
  mayChange,
  optionalFrozenFilesFor,
  runSteps,
  STEP_COMMANDS,
} from '../src/lib/narration-run.js'
import { FROZEN_DIR, keptHash } from '../src/lib/revoice.js'
import type { FrozenNarration, RunManifest } from '../src/lib/run-manifest.js'
import { IDENTITY_FIT, SAMPLE_RATE as S, type NarrationOp } from '../src/lib/timeline.js'
import { SAMPLE_RATE, wav, type VoiceProvider } from '../src/lib/voice.js'

const fixture = (name: string) => new URL(`./fixtures/narration/${name}.wav`, import.meta.url).pathname
const vfx = (f: string) => readFileSync(new URL(`./fixtures/contract1-voice/${f}`, import.meta.url), 'utf8')
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('narration-run: one order of steps', () => {
  const narration = {} as FrozenNarration
  const revoice = { beats: ['intro'], keptHash: 'x' }
  it('restore, re-voice, narration, transcribe, check, render; each only when the bundle has it', () => {
    expect(runSteps(null)).toEqual(['prepare', 'check', 'render'])
    expect(runSteps({ revoice })).toEqual(['prepare', 'revoice', 'check', 'render'])
    expect(runSteps({ narration })).toEqual(['prepare', 'narration', 'transcribe', 'check', 'render'])
    expect(runSteps({ revoice, narration })).toEqual([
      'prepare',
      'revoice',
      'narration',
      'transcribe',
      'check',
      'render',
    ])
    expect(STEP_COMMANDS.transcribe).toBe('npx tsx scripts/narration-stt.ts')
  })
  it('allows exactly the files those steps write, and keeps frozen copies to recompute them from', () => {
    expect(mayChange(NARRATION_SRC, { narration })).toBe(true)
    expect(mayChange('index.html', { narration })).toBe(true)
    expect(mayChange('summary.json', { narration })).toBe(true)
    expect(mayChange('summary.json', null)).toBe(false)
    expect(mayChange(NARRATION_SRC, null)).toBe(false)
    expect(mayChange('assets/voice/intro.wav', { narration })).toBe(false)
    expect(mayChange('assets/voice/intro.wav', { revoice, narration })).toBe(true)
    expect(mayChange('assets/logo.svg', { revoice, narration })).toBe(false)
    expect(frozenFilesFor({ narration })).toEqual(['index.html', 'summary.json'])
    expect(frozenFilesFor({ revoice, narration })).toEqual([
      'index.html',
      'summary.json',
      'assets/voice/voice.json',
    ])
    expect(frozenFilesFor(null)).toEqual([])
  })
})

describe('checkNarration', () => {
  const TAKE = 'med_noisyroom01'
  const op: NarrationOp = {
    op: 'narration',
    schema: 1,
    sampleRate: S,
    clips: [
      {
        id: 'a',
        mediaId: TAKE,
        srcStart: S / 2,
        srcEnd: 4 * S,
        fit: IDENTITY_FIT,
        offsetSamples: 0,
        start: S / 2,
        gainDb: 0,
        fadeInSamples: 0,
        fadeOutSamples: 0,
      },
    ],
    tracks: {
      narration: { volumeDb: 0, muted: false, solo: false },
      aiVoice: { mode: 'replace', volumeDb: -6 },
      music: { duck: true, duckDb: -12 },
      original: { muteAll: false },
    },
    cleanup: 'off',
  }
  const silence = (seconds: number) => wav(new Uint8Array(Math.round(seconds * SAMPLE_RATE) * 2))
  const fakeKokoro: VoiceProvider = {
    name: 'kokoro',
    synthesize: (text) =>
      Promise.resolve({
        audio: new Uint8Array(Math.round(text.split(' ').length * 0.1 * SAMPLE_RATE) * 2).fill(7),
        format: 'pcm',
      }),
  }

  /**
   * What prepare-run leaves for a keep-visuals render: video/ restored from the frozen draft (the voiced fixture with
   * a draft narration, an unrelated asset, optionally lines to re-voice), the frozen copies and the hydrated take.
   */
  function prepared(
    o: { revoice?: Record<string, string>; holdSeconds?: number; staleStill?: boolean } = {},
  ) {
    const root = mkdtempSync(join(tmpdir(), 'va-guard-'))
    dirs.push(root)
    const video = join(root, 'video')
    mkdirSync(join(video, 'assets/voice'), { recursive: true })
    const voice = vfx('assets/voice/voice.json')
    writeFileSync(join(video, 'assets/voice/voice.json'), voice)
    writeFileSync(join(video, 'assets/voice/intro.wav'), silence(2.2))
    writeFileSync(join(video, 'assets/voice/outro.wav'), silence(1.5))
    writeFileSync(join(video, 'assets/logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    // A base that held its last frame keeps its still in the bundle (the narration step replaces or removes it).
    if (o.staleStill) {
      mkdirSync(join(video, 'assets/hold'), { recursive: true })
      writeFileSync(join(video, HOLD_STILL_SRC), Buffer.from(PNG))
    }
    const spoken = Object.fromEntries(
      (JSON.parse(voice) as { beats: { beat: string; text: string }[] }).beats.map((b) => [b.beat, b.text]),
    )
    const lines = o.revoice ?? {}
    const edited = applyEdits(
      vfx('index.html'),
      JSON.parse(vfx('summary.json')) as Summary,
      Object.entries(lines).map(([beat, text]) => ({ op: 'voice' as const, beat, text })),
      { narration: spoken },
    )
    const script = JSON.parse(vfx('assets/voice/script.json')) as { lines: { beat: string; text: string }[] }
    for (const l of script.lines) l.text = lines[l.beat] ?? l.text
    writeFileSync(join(video, 'assets/voice/script.json'), JSON.stringify(script))
    const holdSeconds = o.holdSeconds ?? 0
    writeFileSync(
      join(video, 'index.html'),
      applyNarration(edited.html, edited.summary, op, new Map(), { holdSeconds }).html,
    )
    writeFileSync(join(video, 'summary.json'), JSON.stringify(edited.summary, null, 2))

    const bytes = new Uint8Array(readFileSync(fixture('noisy-room')))
    const narration: FrozenNarration = {
      op,
      takes: [{ mediaId: TAKE, key: `${TAKE}/original.wav`, sha256: sha(bytes), bytes: bytes.length }],
      recipe: { pipeline: 1, cleanup: 'off' },
      targetSamples: (9 + holdSeconds) * S,
      captions: 'sidecar',
    }
    const beats = Object.keys(lines)
    const files = bundleManifest(video)
    const m: RunManifest = {
      v: 1,
      jobId: 'vid_1',
      attemptId: 'att_1',
      versionN: 2,
      kind: 'render_unchanged',
      source: null,
      bundle: {
        key: 'vid_1/v2/frozen.tar.gz',
        sha256: 'a'.repeat(64),
        manifestHash: files.hash,
        ...(beats.length ? { revoice: { beats, keptHash: keptHash(files.files, beats) } } : {}),
        narration,
      },
      media: null,
      feedback: null,
    }
    mkdirSync(join(root, '.render'), { recursive: true })
    writeFileSync(join(root, '.render', 'run-manifest.json'), JSON.stringify(m))
    for (const f of [...frozenFilesFor(m.bundle), ...optionalFrozenFilesFor(m.bundle)]) {
      if (!existsSync(join(video, f))) continue
      mkdirSync(dirname(join(root, FROZEN_DIR, f)), { recursive: true })
      copyFileSync(join(video, f), join(root, FROZEN_DIR, f))
    }
    const p = narrationPaths(root)
    mkdirSync(p.src, { recursive: true })
    const path = `.va-run/narration/src/${TAKE}.wav`
    writeFileSync(join(root, path), bytes)
    const inputs: NarrationInputs = {
      v: 1,
      jobId: 'vid_1',
      attemptId: 'att_1',
      op,
      recipe: narration.recipe,
      targetSamples: narration.targetSamples,
      captions: 'sidecar',
      takes: [
        {
          ...narration.takes[0]!,
          path,
          wavSha256: sha(bytes),
          samples: readPcm16(bytes).samples.length,
          decoded: false,
        },
      ],
    }
    writeFileSync(p.manifest, JSON.stringify(inputs))
    const check = () =>
      checkNarration(join(root, FROZEN_DIR), video, readNarrationReceipt(root), m, readSttRecord(root))
    return { root, video, m, p, check }
  }

  const edit = (file: string, fn: (s: string) => string) =>
    writeFileSync(file, fn(readFileSync(file, 'utf8')))

  it('passes a clean narration run, and needs the receipt', () => {
    const w = prepared()
    expect(w.check()).toEqual([expect.stringMatching(/left no receipt/)])
    runNarration({ root: w.root })
    expect(w.check()).toEqual([])
  })

  it('passes re-voice then narration (the combined order), and fails narration run before the re-voice', async () => {
    const w = prepared({ revoice: { outro: 'Read the docs today.' } })
    await revoiceVideo(w.video, { provider: fakeKokoro })
    runNarration({ root: w.root })
    expect(w.check()).toEqual([])

    const wrongOrder = prepared({ revoice: { outro: 'Read the docs today.' } })
    runNarration({ root: wrongOrder.root })
    expect(wrongOrder.check()).toContainEqual(expect.stringMatching(/new voice doesn't say its line/))
  })

  /** What scripts/narration-stt.ts leaves: stt.json with these words, and their cues in summary.json. */
  function transcribed(w: ReturnType<typeof prepared>, status: SttRecord['status'] = 'ok') {
    const words = [
      { text: 'Hello', start: 0.74, end: 1.1 },
      { text: 'from', start: 1.15, end: 1.4 },
      { text: 'me.', start: 1.45, end: 1.9 },
      { text: 'Second', start: 3, end: 3.4 },
      { text: 'line.', start: 3.45, end: 3.9 },
    ]
    const record: SttRecord = {
      v: 1,
      status,
      setting: 'local',
      provider: 'local',
      model: 'parakeet-tdt-0.6b-v3-int8',
      language: 'en',
      busSha256: null,
      words: status === 'ok' ? words : [],
      offsetMs: 240,
      durationMs: 1,
      cached: false,
      warnings: [],
    }
    writeFileSync(w.p.stt, JSON.stringify(record))
    applyNarrationCaptions(join(w.video, 'summary.json'), record)
  }

  it('passes the narration cues the transcribe step added, next to every frozen cue', () => {
    const w = prepared()
    runNarration({ root: w.root })
    const frozen = JSON.parse(readFileSync(join(w.video, 'summary.json'), 'utf8')) as Summary
    transcribed(w)
    const s = JSON.parse(readFileSync(join(w.video, 'summary.json'), 'utf8')) as Summary
    expect(s.captions?.filter((c) => c.narration)).toHaveLength(2)
    // Replace mode: the AI and text cues stay in summary.json (captions.vtt drops them).
    expect(s.captions?.filter((c) => !c.narration)).toEqual(frozen.captions)
    expect(w.check()).toEqual([])
    // A failed transcription adds nothing, and that passes too.
    const f = prepared()
    runNarration({ root: f.root })
    transcribed(f, 'failed')
    expect(f.check()).toEqual([])
  })

  it('fails an edited narration cue, an extra one, and cues without the transcript they came from', () => {
    const summary = (w: ReturnType<typeof prepared>) => join(w.video, 'summary.json')
    const a = prepared()
    runNarration({ root: a.root })
    transcribed(a)
    edit(summary(a), (s) => s.replace('Hello from me.', 'Hello from you.'))
    expect(a.check()).toContainEqual(expect.stringMatching(/summary.json differs/))

    const b = prepared()
    runNarration({ root: b.root })
    transcribed(b)
    const s = JSON.parse(readFileSync(summary(b), 'utf8')) as Summary
    s.captions = [
      ...(s.captions ?? []),
      { narration: true, id: 'nc_000000000000', start: 7, end: 8, text: 'Extra' },
    ]
    writeFileSync(summary(b), JSON.stringify(s, null, 2))
    expect(b.check()).toContainEqual(expect.stringMatching(/summary.json differs/))

    const c = prepared()
    runNarration({ root: c.root })
    transcribed(c)
    rmSync(c.p.stt)
    expect(c.check()).toContainEqual(expect.stringMatching(/summary.json differs/))
  })

  it('fails an edited attribute on the narration element', () => {
    const w = prepared()
    runNarration({ root: w.root })
    edit(join(w.video, 'index.html'), (s) =>
      s.replace(/(<audio id="va-narration"[^>]*?)data-volume="1"/, '$1data-volume="1.5"'),
    )
    expect(w.check()).toContainEqual(expect.stringMatching(/index.html differs from the frozen composition/))
  })

  it('fails a changed data-va-speech', () => {
    const w = prepared()
    runNarration({ root: w.root })
    edit(join(w.video, 'index.html'), (s) => s.replace(/data-va-speech="[^"]*"/, 'data-va-speech="[[0,1]]"'))
    expect(w.check()).toContainEqual(
      expect.stringMatching(/data-va-speech isn't the speech the receipt measured/),
    )
  })

  it('fails an extra <audio>', () => {
    const w = prepared()
    runNarration({ root: w.root })
    edit(join(w.video, 'index.html'), (s) =>
      s.replace(
        '<audio id="va-narration"',
        '<audio id="extra" src="assets/voice/intro.wav" data-start="0" data-duration="1" data-track-index="7"></audio><audio id="va-narration"',
      ),
    )
    expect(w.check()).toContainEqual(
      expect.stringMatching(/index.html has \d+ <audio> elements; the narration step makes \d+/),
    )
  })

  it('fails replaced bus bytes, even at the same length', () => {
    const w = prepared()
    runNarration({ root: w.root })
    writeFileSync(join(w.video, NARRATION_SRC), silence(9))
    expect(w.check()).toContainEqual(expect.stringMatching(/isn't the bus scripts\/narration.ts wrote/))
  })

  it('fails a modified unrelated file, and a changed summary.json', () => {
    const w = prepared()
    runNarration({ root: w.root })
    writeFileSync(join(w.video, 'assets/logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')
    expect(w.check()).toEqual(['Files other than the narration changed since prepare-run restored video/.'])
    writeFileSync(join(w.video, 'assets/logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    edit(join(w.video, 'summary.json'), (s) => s.replace('"title"', '"title": "x", "was"'))
    expect(w.check()).toContainEqual(expect.stringMatching(/summary.json differs from the frozen captions/))
  })

  it('fails .va-run leakage into video/, wherever the hash would not look', () => {
    const w = prepared()
    runNarration({ root: w.root })
    mkdirSync(join(w.video, 'renders'), { recursive: true })
    copyFileSync(join(w.p.src, `${TAKE}.wav`), join(w.video, 'renders', 'take.wav'))
    expect(w.check()).toContainEqual(
      expect.stringMatching(/holds recorded narration from .va-run\/: renders\/take.wav/),
    )
    rmSync(join(w.video, 'renders'), { recursive: true })
    mkdirSync(join(w.video, '.va-run'))
    expect(w.check()).toContainEqual(
      expect.stringMatching(/holds recorded narration from .va-run\/: .va-run/),
    )
  })

  it("fails another attempt's receipt, and a receipt over other takes", () => {
    const w = prepared()
    runNarration({ root: w.root })
    edit(w.p.receipt, (s) => s.replace('"attemptId": "att_1"', '"attemptId": "att_0"'))
    expect(w.check()).toEqual(["The narration receipt is from attempt att_0, not this run's (att_1)."])
    edit(w.p.receipt, (s) =>
      s
        .replace('"attemptId": "att_0"', '"attemptId": "att_1"')
        .replace(
          /"sha256": "[0-9a-f]{64}",\n {6}"wavSha256"/,
          `"sha256": "${'0'.repeat(64)}",\n      "wavSha256"`,
        ),
    )
    expect(w.check()).toContainEqual(expect.stringMatching(/takes aren't the ones this render froze/))
  })

  /** A stand-in for hyperframes snapshot: a PNG naming the frame time, and the project it was given. */
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const snaps: { dir: string; at: number; html: string; files: string[] }[] = []
  const snapshot: Snapshot = (dir, at, out) => {
    snaps.push({
      dir,
      at,
      html: readFileSync(join(dir, 'index.html'), 'utf8'),
      files: readdirSync(dir).sort(),
    })
    mkdirSync(out, { recursive: true })
    const png = join(out, `frame-00-at-${at}s.png`)
    writeFileSync(png, Buffer.concat([Buffer.from(PNG), Buffer.from(`frame at ${at}`)]))
    return png
  }

  it("a held last frame: the run renders the base composition's last frame as the still, and the guard checks it", () => {
    const w = prepared({ holdSeconds: 2 })
    const frozen = readFileSync(join(w.video, 'index.html'), 'utf8')
    expect(holdBeatOf(load(frozen))).toMatchObject({ start: 9, duration: 2 })
    snaps.length = 0
    const r = runNarration({ root: w.root, snapshot })
    // The base's last frame (frame 269 at 30 fps), from the composition without the hold, next to video/'s files.
    expect(snaps).toHaveLength(1)
    expect(snaps[0]?.at).toBe(8.966667)
    expect(holdBeatOf(load(snaps[0]?.html ?? ''))).toBeNull()
    expect(snaps[0]?.files).toEqual(['assets', 'index.html', 'summary.json'])
    expect(existsSync(join(w.root, '.render', 'hold-base'))).toBe(false)
    expect(existsSync(join(w.video, 'assets/voice/voice.json'))).toBe(true)
    expect(r.hold).toMatchObject({ path: HOLD_STILL_SRC, atSeconds: 8.966667, holdSeconds: 2 })
    expect(r.target.samples).toBe(11 * S)
    expect(w.check()).toEqual([])

    // Another still, no still, or a still without a hold all fail.
    writeFileSync(join(w.video, HOLD_STILL_SRC), Buffer.concat([Buffer.from(PNG), Buffer.from('other')]))
    expect(w.check()).toContainEqual(expect.stringMatching(/assets\/hold\/last.png isn't the held frame/))
    rmSync(join(w.video, HOLD_STILL_SRC))
    expect(w.check()).toContainEqual(expect.stringMatching(/assets\/hold\/last.png isn't the held frame/))
  })

  it('without a held frame, the run removes a stale still and the guard refuses one', () => {
    const w = prepared({ staleStill: true })
    snaps.length = 0
    expect(runNarration({ root: w.root, snapshot }).hold).toBeNull()
    expect(snaps).toHaveLength(0)
    expect(existsSync(join(w.video, HOLD_STILL_SRC))).toBe(false)
    expect(w.check()).toEqual([])
    writeFileSync(join(w.video, HOLD_STILL_SRC), Buffer.from(PNG))
    expect(w.check()).toContainEqual(expect.stringMatching(/is there, but the composition holds no frame/))
  })
})
