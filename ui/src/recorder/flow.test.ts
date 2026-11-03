// The record flow (flow.ts) with fake parts: the phases from Record to saved, Space / Esc, every picture stop reason,
// failures, the placement (calibration, manual offset, pre-roll trimmed), and the recovery checkpoint.
import { describe, expect, it } from 'vitest'
import { placeTake, SAMPLE_RATE } from '../../../src/lib/timeline'
import { STOP_MESSAGES, type FitSegment, type StopKind, type StopReason } from './clock'
import {
  clampToTake,
  createRecordFlow,
  DISCARDED,
  flowKey,
  placementsFromRecord,
  TOO_EARLY,
  trimPreRoll,
  type FlowPhase,
  type FlowRecorder,
  type RecordFlowParts,
  type RememberedTake,
} from './flow'
import type { TakeRecord } from './store'
import type { TakeUploadState } from './take-upload'

const S = SAMPLE_RATE
// A take that started 3 s before the picture (the countdown): composition t = −3 + sample/S.
const SEGMENT: FitSegment = {
  fromSample: 0,
  toSample: 6 * S,
  a: -3,
  b: 1 / S,
  residualRms: 0.3,
  residualMax: 0.9,
  n: 90,
}

interface Ctx {
  closed: boolean
}

function harness(o: { failMic?: string; failUpload?: string; segments?: FitSegment[] } = {}) {
  const phases: FlowPhase[] = []
  const calls: string[] = []
  const remembered: RememberedTake[] = []
  let stopListener: ((r: StopReason) => void) | null = null
  let gate: (() => void) | null = null
  const rec: FlowRecorder & { started: boolean; cancelled: boolean } = {
    recordingId: 'rec_1',
    started: false,
    cancelled: false,
    start() {
      this.started = true
      calls.push('start')
    },
    async cancel() {
      this.cancelled = true
      calls.push('cancel')
    },
  }
  let picture: StopReason | null = null
  const ctx: Ctx = { closed: false }
  let uploadState: (s: TakeUploadState, e?: string) => void = () => undefined
  const parts: RecordFlowParts<Ctx, typeof rec> = {
    openContext: async () => {
      calls.push('context')
      return ctx
    },
    createRecorder: async () => {
      if (o.failMic) throw new Error(o.failMic)
      calls.push('recorder')
      return rec
    },
    prepare: async () => {
      calls.push('prepare')
    },
    // The countdown waits are released by the test (tick), one second each.
    wait: () =>
      new Promise<void>((r) => {
        gate = r
      }),
    roll: async () => {
      calls.push('roll')
    },
    // Like the real clock: the first stop wins, its listener hears it, and it's returned.
    halt: (kind, detail) => {
      calls.push(`halt:${kind}`)
      if (!picture) {
        picture = { kind, atPerf: 1, atSample: 5 * S, ...(detail ? { detail } : {}) }
        stopListener?.(picture)
      }
      return picture
    },
    fit: () => o.segments ?? [SEGMENT],
    offsets: () => ({ calibrationOffsetSamples: -960, manualOffsetSamples: 240 }),
    remember: async (_id, take) => {
      remembered.push(take)
    },
    upload: {
      recording: (id) => calls.push(`upload.recording:${id}`),
      finish: async () => {
        calls.push('upload.finish')
        uploadState('finalizing')
        uploadState('uploading')
        uploadState('processing')
        uploadState('saving')
        if (o.failUpload) uploadState('failed', o.failUpload)
        else uploadState('saved')
      },
      reset: () => calls.push('upload.reset'),
    },
    release: (c) => {
      c.closed = true
      calls.push('release')
    },
  }
  const flow = createRecordFlow(parts, (s) => {
    if (phases.at(-1) !== s.phase) phases.push(s.phase)
  })
  uploadState = (s, e) => flow.uploadChanged(s, e ?? null)
  stopListener = (r) => flow.stopped(r)
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const tick = async () => {
    await flush()
    gate?.()
    gate = null
    await flush()
  }
  /** Record, then the whole countdown: the picture is rolling. */
  const rolling = async () => {
    flow.open()
    const p = flow.record()
    for (let i = 0; i < 3; i++) await tick()
    await p
  }
  /** The picture clock raises a stop on its own. */
  const pictureStops = (kind: StopKind) => {
    picture = { kind, atPerf: 2, atSample: 2 * S }
    flow.stopped(picture)
  }
  return { flow, phases, calls, rec, ctx, remembered, tick, rolling, pictureStops, flush }
}

describe('the record flow', () => {
  it('goes idle -> setup -> countdown -> recording -> stopping -> uploading -> saved on Space', async () => {
    const h = harness()
    h.flow.open()
    expect(h.flow.get()).toMatchObject({ phase: 'setup', open: true })
    const p = h.flow.record()
    await h.flush()
    // The mic captures from the start of the countdown.
    expect(h.calls.slice(0, 4)).toEqual(['context', 'recorder', 'start', 'upload.recording:rec_1'])
    expect(h.flow.get()).toMatchObject({ phase: 'countdown', count: 3, recordingId: 'rec_1' })
    await h.tick()
    expect(h.flow.get().count).toBe(2)
    await h.tick()
    expect(h.flow.get().count).toBe(1)
    expect(h.calls).not.toContain('roll')
    await h.tick()
    await p
    expect(h.calls).toContain('roll')
    expect(h.flow.get()).toMatchObject({ phase: 'recording', count: null })

    h.flow.stop()
    await h.flush()
    expect(h.phases).toEqual(['setup', 'countdown', 'recording', 'stopping', 'uploading', 'saved'])
    expect(h.flow.get()).toMatchObject({ phase: 'saved', notice: null, stop: { kind: 'user' } })
    expect(h.calls.filter((c) => c.startsWith('halt'))).toEqual(['halt:user', 'halt:user'])
    expect(h.calls.at(-1)).toBe('release')
    expect(h.ctx.closed).toBe(true)
    expect(h.rec.cancelled).toBe(false)
  })

  it('places the take with calibration and manual offset, the countdown trimmed off', async () => {
    const h = harness()
    await h.rolling()
    h.flow.stop()
    await h.flush()
    const pieces = h.flow.placementsFor('rec_1')
    const offset = -960 + 240
    // Composition 0 is source sample 3 s minus the offset.
    expect(pieces).toHaveLength(1)
    expect(pieces?.[0]).toMatchObject({
      start: 0,
      srcStart: 3 * S - offset,
      srcEnd: 6 * S,
      offsetSamples: offset,
    })
    expect(h.remembered.at(-1)).toEqual({ pieces, stop: 'user' })
  })

  it.each([
    'seek',
    'stall',
    'hidden',
    'devicechange',
    'track-ended',
    'context-interrupted',
    'residual',
    'slope',
  ] as const)('a %s stop keeps the clean part and says why', async (kind) => {
    const h = harness()
    await h.rolling()
    h.pictureStops(kind)
    await h.flush()
    expect(h.flow.get()).toMatchObject({ phase: 'saved', notice: STOP_MESSAGES[kind], stop: { kind } })
    expect(h.calls).toContain('upload.finish')
    expect(h.rec.cancelled).toBe(false)
  })

  it('the video ending keeps the take without a warning', async () => {
    const h = harness()
    await h.rolling()
    h.pictureStops('ended')
    await h.flush()
    expect(h.flow.get()).toMatchObject({ phase: 'saved', notice: null })
  })

  it('Esc discards: the take is cancelled, nothing uploads, and Record is back', async () => {
    const h = harness()
    await h.rolling()
    await h.flow.discard()
    expect(h.flow.get()).toMatchObject({ phase: 'setup', notice: DISCARDED, stop: null })
    expect(h.rec.cancelled).toBe(true)
    expect(h.calls).not.toContain('upload.finish')
    expect(h.calls).toContain('upload.reset')
    expect(h.ctx.closed).toBe(true)
    // A picture stop after the discard is ignored.
    h.pictureStops('seek')
    await h.flush()
    expect(h.flow.get().phase).toBe('setup')
  })

  it('Space during the countdown keeps nothing; the countdown stops', async () => {
    const h = harness()
    h.flow.open()
    const p = h.flow.record()
    await h.tick()
    h.flow.stop()
    await h.flush()
    expect(h.flow.get()).toMatchObject({ phase: 'setup', notice: TOO_EARLY })
    expect(h.rec.cancelled).toBe(true)
    await h.tick()
    await h.tick()
    await p
    expect(h.calls).not.toContain('roll')
  })

  it('a mic that fails to open fails the flow with its reason, and Record works again', async () => {
    const h = harness({ failMic: 'Microphone access is blocked.' })
    h.flow.open()
    await h.flow.record()
    expect(h.flow.get()).toMatchObject({ phase: 'failed', error: 'Microphone access is blocked.' })
    expect(h.ctx.closed).toBe(true)
  })

  it('an upload or save failure ends in failed with the uploader error', async () => {
    const h = harness({ failUpload: "The draft couldn't be saved." })
    await h.rolling()
    h.flow.stop()
    await h.flush()
    expect(h.flow.get()).toMatchObject({ phase: 'failed', error: "The draft couldn't be saved." })
  })

  it('checkpoints the placement while recording (for a reload mid-take), not before the picture rolls', async () => {
    const h = harness()
    h.flow.open()
    const p = h.flow.record()
    await h.flush()
    await h.flow.checkpoint()
    expect(h.remembered).toHaveLength(0)
    for (let i = 0; i < 3; i++) await h.tick()
    await p
    await h.flow.checkpoint()
    expect(h.remembered).toHaveLength(1)
    expect(h.remembered[0]).toMatchObject({ stop: null, pieces: [{ start: 0, srcEnd: 6 * S }] })
  })

  it('a recovered take uploading in the background shows its progress, and close only works when nothing runs', async () => {
    const h = harness()
    h.flow.uploadChanged('uploading', null)
    expect(h.flow.get()).toMatchObject({ phase: 'uploading', open: false })
    h.flow.uploadChanged('saved', null)
    expect(h.flow.get().phase).toBe('saved')
    await h.rolling()
    h.flow.close()
    expect(h.flow.get()).toMatchObject({ open: true, phase: 'recording' })
    // The uploader's own states don't move a running take.
    h.flow.uploadChanged('idle', null)
    expect(h.flow.get().phase).toBe('recording')
    h.flow.dispose()
    await h.flush()
    expect(h.rec.cancelled).toBe(true)
  })
})

describe('placement helpers', () => {
  const piece = (srcStart: number, srcEnd: number, a: number, offsetSamples = 0) => {
    const fit = { a, b: 1 / S, residualMs: 1 }
    return { start: placeTake(fit, offsetSamples, srcStart), srcStart, srcEnd, fit, offsetSamples }
  }

  it('trimPreRoll starts each piece at composition 0 or later and drops pieces wholly before it', () => {
    const out = trimPreRoll([piece(0, 2 * S, -3), piece(2 * S, 4 * S, -3), piece(4 * S, 8 * S, -3 + 1 / 30)])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ srcStart: 3 * S, start: 0 })
    expect(out[1]?.srcStart).toBe(4 * S)
    expect(out[1]?.start).toBeGreaterThan(0)
    // A piece already on the timeline is untouched.
    expect(trimPreRoll([piece(0, S, 1)])).toEqual([piece(0, S, 1)])
  })

  it('clampToTake cuts pieces to the file and drops empty ones', () => {
    expect(clampToTake([piece(0, 2 * S, 0), piece(2 * S, 4 * S, 0)], 1.5 * S)).toEqual([
      { ...piece(0, 2 * S, 0), srcEnd: 1.5 * S },
    ])
  })

  it('placementsFromRecord reads the pieces a recovery record kept', () => {
    const pieces = [piece(3 * S, 6 * S, -3)]
    expect(
      placementsFromRecord({ placement: { start: -3 * S, offsetSamples: 0, pieces } } as TakeRecord),
    ).toEqual(pieces)
    expect(placementsFromRecord({ placement: null } as TakeRecord)).toBeNull()
    expect(placementsFromRecord(null)).toBeNull()
  })

  it('flowKey: Space keeps and Esc discards only while a take runs', () => {
    expect(flowKey('recording', ' ')).toBe('stop')
    expect(flowKey('countdown', 'Escape')).toBe('discard')
    expect(flowKey('setup', ' ')).toBeNull()
    expect(flowKey('recording', 'a')).toBeNull()
  })
})
