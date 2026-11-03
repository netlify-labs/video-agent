// The fit guard, narration_modified (plan 2026-11-02 §6.4, bead va-2qq.6.3): a fit run's video/ after the agent
// retimed the visuals, checked against the frozen draft (proved by the bundle's manifest hash) and the receipt. An
// honest fit passes; every tamper with the narration's level, automation, effects, group or master path, a new sound
// over the speech (audio or a <video> soundtrack), a replaced or copied bus, a removed element, a playing AI voice or a
// wrong length fails with its reason.
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bundleManifest } from '../src/lib/bundle-manifest.js'
import {
  applyBusNarration,
  applyEdits,
  applyNarration,
  NARRATION_SRC,
  type Summary,
} from '../src/lib/contract.js'
import { checkNarrationKept, checkNarrationModified } from '../src/lib/narration-modified.js'
import type { NarrationReceipt } from '../src/lib/narration-run.js'
import { FROZEN_DIR } from '../src/lib/revoice.js'
import type { FrozenNarration, RunManifest } from '../src/lib/run-manifest.js'
import {
  IDENTITY_FIT,
  SAMPLE_RATE as S,
  fitTarget,
  type NarrationOp,
  type Span,
} from '../src/lib/timeline.js'
import { wav } from '../src/lib/voice.js'

const vfx = (f: string) => readFileSync(new URL(`./fixtures/contract1-voice/${f}`, import.meta.url), 'utf8')
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const TAKE = 'med_noisyroom01'
// One clip from 1 s to 11.5 s: the fit's target is 12 s (+ 0.5 s post-roll), 3 s longer than the 9 s of visuals.
const op: NarrationOp = {
  op: 'narration',
  schema: 1,
  sampleRate: S,
  clips: [
    {
      id: 'a',
      mediaId: TAKE,
      srcStart: 0,
      srcEnd: 10.5 * S,
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
// Speech the bus's VAD measured: 1-3 s and 6-11.5 s, with a pause the agent may put a sound in.
const SPANS: Span[] = [
  [S, 3 * S],
  [6 * S, 11.5 * S],
]

/**
 * A fit run after prepare-run, scripts/narration.ts and an honest agent: the frozen draft (the voiced fixture with
 * its draft narration) kept in FROZEN_DIR, the bus and its receipt, and video/ retimed to the target (4 s a beat)
 * with the narration written at it.
 */
function fitted() {
  const root = mkdtempSync(join(tmpdir(), 'va-fit-guard-'))
  dirs.push(root)
  const video = join(root, 'video')
  mkdirSync(join(video, 'assets/voice'), { recursive: true })
  mkdirSync(join(video, 'assets/sfx'), { recursive: true })
  writeFileSync(join(video, 'assets/voice/intro.wav'), wav(new Uint8Array(2.2 * S * 2)))
  writeFileSync(join(video, 'assets/voice/outro.wav'), wav(new Uint8Array(1.5 * S * 2)))
  writeFileSync(join(video, 'assets/sfx/click.wav'), wav(new Uint8Array(S).fill(3)))
  const summary = JSON.parse(vfx('summary.json')) as Summary
  const draft = applyNarration(vfx('index.html'), summary, op, new Map())
  writeFileSync(join(video, 'index.html'), draft.html)
  writeFileSync(join(video, 'summary.json'), JSON.stringify(summary, null, 2))
  // prepare-run: the whole frozen composition, which the bundle's manifest hash covers.
  const frozen = bundleManifest(video)
  cpSync(video, join(root, FROZEN_DIR), { recursive: true })
  const takeBytes = wav(new Uint8Array(10.5 * S * 2).fill(1))
  const narration: FrozenNarration = {
    op,
    takes: [{ mediaId: TAKE, key: `${TAKE}/original.wav`, sha256: sha(takeBytes), bytes: takeBytes.length }],
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
  // scripts/narration.ts: the bus at the frozen target, and its receipt.
  mkdirSync(join(video, 'assets/narration'), { recursive: true })
  const bus = wav(new Uint8Array(TARGET * 2).map((_, i) => i % 5))
  writeFileSync(join(video, NARRATION_SRC), bus)
  const receipt: NarrationReceipt = {
    v: 1,
    pipeline: 1,
    jobId: 'vid_1',
    attemptId: 'att_1',
    inputs: [
      {
        mediaId: TAKE,
        sha256: sha(takeBytes),
        wavSha256: sha(takeBytes),
        cleanSha256: 'c'.repeat(64),
        samples: 10.5 * S,
        filter: null,
        measured: null,
        warnings: [],
      },
    ],
    recipe: { pipeline: 1, cleanup: 'off', ffmpeg: 'unavailable', limiter: {} as never, vad: 1 },
    target: { manifestSamples: TARGET, samples: TARGET },
    bus: {
      path: NARRATION_SRC,
      sha256: sha(bus),
      pcmSha256: 'd'.repeat(64),
      samples: TARGET,
      truePeakDb: -3,
      maxReductionDb: 0,
      limitedSamples: 0,
    },
    spans: SPANS,
    hold: null,
    warnings: [],
  }
  // The agent: every beat 4 s (12 s in all), then the narration as the narration step writes it at that length.
  const retimed = applyEdits(
    draft.html,
    summary,
    ['intro', 'demo', 'outro'].map((beat) => ({ op: 'retime' as const, beat, duration: 4 })),
  )
  const html = applyBusNarration(retimed.html, retimed.summary, op, SPANS).html
  writeFileSync(join(video, 'index.html'), html)
  writeFileSync(join(video, 'summary.json'), JSON.stringify(retimed.summary, null, 2))
  const index = join(video, 'index.html')
  const edit = (fn: (s: string) => string) => writeFileSync(index, fn(readFileSync(index, 'utf8')))
  const check = (r: NarrationReceipt | null = receipt) =>
    checkNarrationModified(join(root, FROZEN_DIR), video, r, m)
  return { root, video, m, receipt, edit, check }
}

/** Puts `tag` into beat `beat` (just after its opening tag). */
const inBeat = (beat: string, tag: string) => (s: string) =>
  s.replace(new RegExp(`(<section id="${beat}"[^>]*>)`), `$1${tag}`)
const narrationTag = /<audio id="va-narration"[^>]*>/

describe('checkNarrationModified', () => {
  it('passes an honest fit, and needs the receipt', () => {
    const w = fitted()
    expect(w.check()).toEqual([])
    expect(w.check(null)).toEqual([expect.stringMatching(/left no receipt/)])
  })

  it('passes new sound in a pause, a muted new clip, and frozen music over the speech', () => {
    const w = fitted()
    // The demo beat starts at 4 s: a click at 4.5-5 s is between the spans (3 s and 6 s).
    w.edit(
      inBeat(
        'demo',
        '<audio id="sfx-click" src="assets/sfx/click.wav" data-start="0.5" data-duration="0.5" data-volume="0.35"></audio>' +
          '<video id="b-roll" src="assets/clip.mp4" muted data-start="0" data-duration="2"></video>',
      ),
    )
    expect(w.check()).toEqual([])
  })

  it('fails a changed level on the narration', () => {
    const w = fitted()
    w.edit((s) => s.replace(narrationTag, (t) => t.replace('data-volume="1"', 'data-volume="0.8"')))
    expect(w.check()).toEqual([expect.stringMatching(/narration element changed \(data-volume\)/)])
  })

  it('fails automation on the narration', () => {
    const w = fitted()
    w.edit((s) =>
      s.replace(
        'id="va-narration"',
        `id="va-narration" data-automation='{"version":1,"lanes":[{"target":"volume","points":[{"t":0,"v":0.5}]}]}'`,
      ),
    )
    expect(w.check()).toEqual([expect.stringMatching(/narration element changed \(data-automation\)/)])
  })

  it('fails an effect chain on the narration', () => {
    const w = fitted()
    w.edit((s) => s.replace('id="va-narration"', `id="va-narration" data-fx-chain='[{"id":"lowpass"}]'`))
    expect(w.check()).toEqual([expect.stringMatching(/narration element changed \(data-fx-chain\)/)])
  })

  it('fails the narration put in a group with an effect, or an effect on the master', () => {
    const w = fitted()
    w.edit((s) =>
      s
        .replace('id="va-narration"', 'id="va-narration" data-audio-group="vo"')
        .replace(
          '</body>',
          `<hf-audio-group id="vo" data-fx-chain='[{"id":"gain"}]'></hf-audio-group></body>`,
        ),
    )
    expect(w.check()).toEqual([expect.stringMatching(/narration element changed \(data-audio-group\)/)])
    const master = fitted()
    master.edit((s) =>
      s.replace('data-composition-id="main"', `data-composition-id="main" data-fx-chain='[{"id":"gain"}]'`),
    )
    expect(master.check()).toEqual([expect.stringMatching(/path to the master bus changed/)])
    const hidden = fitted()
    hidden.edit((s) => s.replace('<body>', '<body data-hidden>'))
    expect(hidden.check()).toEqual([expect.stringMatching(/path to the master bus changed/)])
  })

  it('fails new audio over the speech', () => {
    const w = fitted()
    // The intro beat starts at 0: a click at 1.5-2 s is inside the first span.
    w.edit(
      inBeat(
        'intro',
        '<audio id="sfx-click" src="assets/sfx/click.wav" data-start="1.5" data-duration="0.5" data-volume="0.35"></audio>',
      ),
    )
    expect(w.check()).toEqual([
      expect.stringMatching(/<audio id="sfx-click"> is new and sounds over .* at 1-3s/),
    ])
  })

  it("fails a new <video> whose soundtrack plays over the speech, whatever data-has-audio doesn't say", () => {
    const w = fitted()
    w.edit(
      inBeat('outro', '<video id="b-roll" src="assets/clip.mp4" data-start="0" data-duration="2"></video>'),
    )
    expect(w.check()).toEqual([
      expect.stringMatching(/<video id="b-roll"> is new and sounds over .* at 6-11.5s/),
    ])
  })

  it('fails a replaced bus, and a copy of it played under another name', () => {
    const w = fitted()
    writeFileSync(join(w.video, NARRATION_SRC), wav(new Uint8Array(TARGET * 2)))
    expect(w.check()).toEqual([expect.stringMatching(/isn't the bus scripts\/narration.ts wrote/)])
    const copy = fitted()
    cpSync(join(copy.video, NARRATION_SRC), join(copy.video, 'assets/sfx/again.wav'))
    copy.edit(
      inBeat(
        'demo',
        '<audio id="again" src="assets/sfx/again.wav" data-start="0" data-duration="1"></audio>',
      ),
    )
    expect(copy.check()).toEqual([
      expect.stringMatching(/<audio id="again"> plays a copy of the narration bus/),
    ])
  })

  it('fails a removed narration element, and a second one', () => {
    const w = fitted()
    w.edit((s) => s.replace(/<audio id="va-narration"[^>]*><\/audio>/, ''))
    expect(w.check()).toContainEqual(expect.stringMatching(/<audio id="va-narration"> was removed/))
    const two = fitted()
    two.edit(inBeat('demo', `<audio id="vo2" data-va-audio="narration" src="${NARRATION_SRC}"></audio>`))
    expect(two.check()).toContainEqual(expect.stringMatching(/There are 2 narration elements/))
  })

  it('fails a playing AI voice: a fit replaces it', () => {
    const w = fitted()
    w.edit((s) =>
      s.replace(/<audio id="voice-intro"[^>]*>/, (t) =>
        t.replace(/ data-va-muted=""/, '').replace('data-volume="0"', 'data-volume="1"'),
      ),
    )
    expect(w.check()).toContainEqual(expect.stringMatching(/AI voice <audio id="voice-intro"> plays/))
  })

  it('fails beats that miss the target, and a frozen draft that was changed', () => {
    const w = fitted()
    const summary = JSON.parse(readFileSync(join(w.video, 'summary.json'), 'utf8')) as Summary
    w.edit((s) => applyEdits(s, summary, [{ op: 'retime', beat: 'outro', duration: 3.9 }]).html)
    expect(w.check()).toContainEqual(expect.stringMatching(/must last exactly 12s \(360 frames at 30 fps\)/))
    const f = fitted()
    writeFileSync(join(f.root, FROZEN_DIR, 'index.html'), '<div data-composition-id="x"></div>')
    expect(f.check()).toEqual([expect.stringMatching(/isn't the bundle this run restored/)])
  })

  it('fails a bus mixed at another length than the frozen target', () => {
    const w = fitted()
    const r = { ...w.receipt, target: { manifestSamples: TARGET, samples: 9 * S } }
    expect(w.check(r)).toContainEqual(expect.stringMatching(/not the frozen target of 12s/))
  })
})

describe('checkNarrationKept (a revision of a narrated version)', () => {
  /** A narrated v1 restored for a revision: its composition kept in FROZEN_DIR, its bus by reference. */
  function revised() {
    const root = mkdtempSync(join(tmpdir(), 'va-kept-'))
    dirs.push(root)
    const video = join(root, 'video')
    mkdirSync(join(video, 'assets/narration'), { recursive: true })
    const nine: NarrationOp = { ...op, clips: [{ ...op.clips[0]!, srcEnd: 7 * S }] }
    const summary = JSON.parse(vfx('summary.json')) as Summary
    const cue = { start: 1, end: 2, text: 'Meet webhooks.', narration: true as const, id: 'n1', words: [] }
    const narrated = { ...summary, captions: [...(summary.captions ?? []), cue] }
    const spans: Span[] = [[S, 3 * S]]
    writeFileSync(join(video, 'index.html'), applyBusNarration(vfx('index.html'), narrated, nine, spans).html)
    writeFileSync(join(video, 'summary.json'), JSON.stringify(narrated, null, 2))
    const bus = wav(new Uint8Array(9 * S * 2).map((_, i) => i % 3))
    writeFileSync(join(video, NARRATION_SRC), bus)
    cpSync(video, join(root, FROZEN_DIR), { recursive: true })
    const m: RunManifest = {
      v: 1,
      jobId: 'vid_1',
      attemptId: 'att_2',
      versionN: 2,
      kind: 'revision',
      source: {
        key: 'vid_1/v1/source.tar.gz',
        sha256: 'a'.repeat(64),
        parentN: 1,
        references: [
          { path: NARRATION_SRC, key: 'vid_1/v1/narration/bus.wav', sha256: sha(bus), bytes: bus.length },
        ],
      },
      bundle: null,
      media: null,
      feedback: null,
    }
    const index = join(video, 'index.html')
    const edit = (fn: (s: string) => string) => writeFileSync(index, fn(readFileSync(index, 'utf8')))
    return { video, edit, check: () => checkNarrationKept(join(root, FROZEN_DIR), video, m) }
  }

  it('passes a revision that changes only the visuals', () => {
    const w = revised()
    w.edit((s) => s.replace('Org webhooks', 'Org-wide webhooks'))
    expect(w.check()).toEqual([])
  })

  it('fails a changed narration, a new sound over its speech, another bus, a dropped cue or another length', () => {
    const level = revised()
    level.edit((s) => s.replace(narrationTag, (t) => t.replace('data-volume="1"', 'data-volume="2"')))
    expect(level.check()).toEqual([expect.stringMatching(/narration element changed \(data-volume\)/)])
    const sfx = revised()
    sfx.edit(
      inBeat('intro', '<audio id="boom" src="assets/sfx/boom.wav" data-start="1" data-duration="1"></audio>'),
    )
    expect(sfx.check()).toEqual([expect.stringMatching(/<audio id="boom"> is new and sounds over/)])
    const bus = revised()
    writeFileSync(join(bus.video, NARRATION_SRC), wav(new Uint8Array(9 * S * 2)))
    expect(bus.check()).toContainEqual(expect.stringMatching(/isn't the parent's narration bus/))
    const cues = revised()
    const path = join(cues.video, 'summary.json')
    const s = JSON.parse(readFileSync(path, 'utf8')) as Summary
    writeFileSync(path, JSON.stringify({ ...s, captions: s.captions?.filter((c) => !c.narration) }))
    expect(cues.check()).toEqual([expect.stringMatching(/narration captions aren't the ones transcribed/)])
    const longer = revised()
    longer.edit((h) => applyEdits(h, s, [{ op: 'retime', beat: 'outro', duration: 4 }]).html)
    expect(longer.check()).toContainEqual(expect.stringMatching(/this video must last exactly 9s/))
  })
})
