// A fit run's steps before and after the agent (plan 2026-11-02 §6.4, bead va-2qq.6.2): scripts/narration.ts mixes
// the bus at the FROZEN target (not the draft's root length) and writes the narration element at it; the composition
// then fails the contract until the agent's beats total the target exactly, and an honest fit passes render-job's
// narration_modified guard. Cleanup off, so no ffmpeg is needed.
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runNarration } from '../scripts/narration.js'
import {
  narrationPaths,
  readNarrationReceipt,
  type NarrationInputs,
} from '../scripts/lib/narration-inputs.js'
import { bundleManifest } from '../src/lib/bundle-manifest.js'
import {
  applyDucking,
  applyNarration,
  load,
  NARRATION_SRC,
  narrationAttrs,
  read,
  save,
  validate,
  type Summary,
} from '../src/lib/contract.js'
import { readPcm16 } from '../src/lib/narration-cleanup.js'
import { checkNarrationModified } from '../src/lib/narration-modified.js'
import { fitSteps } from '../src/lib/narration-run.js'
import { FROZEN_DIR } from '../src/lib/revoice.js'
import type { FrozenNarration, RunManifest } from '../src/lib/run-manifest.js'
import { IDENTITY_FIT, SAMPLE_RATE as S, fitTarget, type NarrationOp } from '../src/lib/timeline.js'
import { wav } from '../src/lib/voice.js'

const fixture = (name: string) => new URL(`./fixtures/narration/${name}.wav`, import.meta.url).pathname
const vfx = (f: string) => readFileSync(new URL(`./fixtures/contract1-voice/${f}`, import.meta.url), 'utf8')
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const TAKE = 'med_noisyroom01'
// 10 s of the take from 1 s: the narration ends at 11 s, so the target is 11.5 s (345 frames), past the 9 s draft.
const op: NarrationOp = {
  op: 'narration',
  schema: 1,
  sampleRate: S,
  clips: [
    {
      id: 'a',
      mediaId: TAKE,
      srcStart: 0,
      srcEnd: 10 * S,
      fit: IDENTITY_FIT,
      offsetSamples: 0,
      start: S,
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
const TARGET = fitTarget(op.clips, 30)

/** What prepare-run leaves for a fit: the frozen draft in video/ and FROZEN_DIR, and the hydrated take. */
function prepared() {
  const root = mkdtempSync(join(tmpdir(), 'va-fit-run-'))
  dirs.push(root)
  const video = join(root, 'video')
  mkdirSync(join(video, 'assets/voice'), { recursive: true })
  writeFileSync(join(video, 'assets/voice/intro.wav'), wav(new Uint8Array(2.2 * S * 2)))
  writeFileSync(join(video, 'assets/voice/outro.wav'), wav(new Uint8Array(1.5 * S * 2)))
  const summary = JSON.parse(vfx('summary.json')) as Summary
  writeFileSync(join(video, 'index.html'), applyNarration(vfx('index.html'), summary, op, new Map()).html)
  writeFileSync(join(video, 'summary.json'), JSON.stringify(summary, null, 2))
  const frozen = bundleManifest(video)
  cpSync(video, join(root, FROZEN_DIR), { recursive: true })
  const bytes = new Uint8Array(readFileSync(fixture('noisy-room')))
  const narration: FrozenNarration = {
    op,
    takes: [{ mediaId: TAKE, key: `${TAKE}/original.wav`, sha256: sha(bytes), bytes: bytes.length }],
    recipe: { pipeline: 1, cleanup: 'off' },
    targetSamples: TARGET,
    captions: 'sidecar',
  }
  const m: RunManifest = {
    v: 1,
    jobId: 'vid_1',
    attemptId: 'att_1',
    versionN: 2,
    kind: 'author_from_frozen',
    source: null,
    bundle: { key: 'vid_1/v2/frozen.tar.gz', sha256: 'a'.repeat(64), manifestHash: frozen.hash, narration },
    media: null,
    feedback: null,
  }
  mkdirSync(join(root, '.render'), { recursive: true })
  writeFileSync(join(root, '.render', 'run-manifest.json'), JSON.stringify(m))
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
    targetSamples: TARGET,
    captions: 'sidecar',
    fit: true,
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
  return { root, video, m }
}

/** The agent's fit, by hand as it writes HTML: beats of 4, 4 and 3.5 s, the root and layers at 11.5 s, then --duck. */
function fitBeats(html: string) {
  const at: Record<string, [number, number]> = { intro: [0, 4], demo: [4, 4], outro: [8, 3.5] }
  let out = html
  for (const [beat, [start, dur]] of Object.entries(at))
    out = out.replace(
      new RegExp(`(<section id="${beat}"[^>]*?) data-start="[^"]*" data-duration="[^"]*"`),
      `$1 data-start="${start}" data-duration="${dur}"`,
    )
  out = out
    .replace(/(data-composition-id="main"[^>]*?data-duration=")9"/, '$111.5"')
    .replace(/(<(?:audio|div) id="(?:music|bg-glow)"[^>]*?data-duration=")9"/g, '$111.5"')
  const d = load(out)
  applyDucking(d)
  return save(d)
}

describe('a fit run', () => {
  it('restore, re-voice, mix and transcribe come before the agent; check and render after', () => {
    expect(fitSteps(null)).toEqual(['prepare', 'narration', 'transcribe', 'author', 'check', 'render'])
    expect(fitSteps({ revoice: {} })).toEqual([
      'prepare',
      'revoice',
      'narration',
      'transcribe',
      'author',
      'check',
      'render',
    ])
  })

  it('mixes the bus at the frozen target and writes the narration at it; the beats are left to the agent', () => {
    const w = prepared()
    const r = runNarration({ root: w.root })
    expect(r.target).toEqual({ manifestSamples: TARGET, samples: TARGET })
    expect(r.bus.samples).toBe(TARGET)
    expect(readPcm16(readFileSync(join(w.video, NARRATION_SRC))).samples.length).toBe(TARGET)
    expect(r.hold).toBeNull()
    const html = readFileSync(join(w.video, 'index.html'), 'utf8')
    // The draft's 9 s are untouched; the narration element is exactly what the guard expects at 11.5 s.
    expect(read(load(html)).duration).toBe(9)
    const tag = /<audio id="va-narration"[^>]*>/.exec(html)?.[0] ?? ''
    for (const a of narrationAttrs(TARGET / S, r.spans))
      expect(tag).toContain(`${a.name}="${a.value.replaceAll('"', '&quot;')}"`)
    // A fit replaces the AI voice.
    expect(html).toMatch(/<audio id="voice-intro"[^>]*data-volume="0"[^>]*data-va-muted=""/)
    // The narration validator fails until the beats total the target.
    expect(validate(html, undefined, { narration: { busSamples: TARGET } })).toContainEqual(
      expect.stringMatching(/bus is 11.5s but the video is 9s/),
    )
  })

  it('an honest fit to exactly the target passes the narration_modified guard', () => {
    const w = prepared()
    runNarration({ root: w.root })
    const index = join(w.video, 'index.html')
    const summary = JSON.parse(readFileSync(join(w.video, 'summary.json'), 'utf8')) as Summary
    const fitted = fitBeats(readFileSync(index, 'utf8'))
    expect(validate(fitted, summary, { narration: { busSamples: TARGET } })).toEqual([])
    writeFileSync(index, fitted)
    const check = () =>
      checkNarrationModified(join(w.root, FROZEN_DIR), w.video, readNarrationReceipt(w.root), w.m)
    expect(check()).toEqual([])
    // One frame short is not a fit.
    writeFileSync(
      index,
      fitted
        .replace(/(<section id="outro"[^>]*?data-duration=")3.5"/, '$13.466667"')
        .replaceAll('data-duration="11.5"', 'data-duration="11.466667"'),
    )
    expect(check()).toContainEqual(expect.stringMatching(/must last exactly 11.5s \(345 frames at 30 fps\)/))
  })
})
