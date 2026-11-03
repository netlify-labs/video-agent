// The record flow (docs/plans/2026-11-02-record-your-own-voiceover.md §2.1 steps 4-6, §5.1, §5.3): one take from the
// Record click to a saved clip. The click is the gesture that makes and resumes the AudioContext; the mic captures
// through a 3-2-1 countdown (so the first word isn't clipped) while the picture rewinds and the monitor's stems load;
// then the picture plays from the start, its anchors fit the take, and the monitor follows it. Space stops and keeps,
// Esc discards, and any stop the picture clock raises (seek, stall, hidden tab, device change, track ended, context
// interrupted, residual or slope) keeps the clean part and says why. On stop the fit segments, the route's calibration
// and the manual Sync offset become the clips' placement (the countdown's pre-roll trimmed off), written to the take's
// recovery record, and the uploader takes it from there (take-upload.ts).
//
//   idle -> setup -> countdown -> recording -> stopping -> uploading -> saved
//             ^  \______ Esc / failure ____/        \__________________ failed (retry) ___/
//
// Framework-free: the editor (NarrationRecorder.tsx) supplies the parts (recorder, picture clock, monitor, uploader);
// the tests supply fakes.
import { placeTake, SAMPLE_RATE } from '../../../src/lib/timeline'
import { placeRecordedTake, STOP_MESSAGES, type FitSegment, type RecordedPlacement } from './clock'
import type { StopKind, StopReason } from './clock/fit'
import type { TakeRecord } from './store'
import type { TakeUploadState } from './take-upload'

export type FlowPhase =
  'idle' | 'setup' | 'countdown' | 'recording' | 'stopping' | 'uploading' | 'saved' | 'failed'

export interface FlowSnapshot {
  phase: FlowPhase
  /** The recording panel is open (setup, the picture and the prompter). */
  open: boolean
  /** 3, 2, 1 during the countdown; null once the picture plays. */
  count: number | null
  /** Why the last take stopped. */
  stop: StopReason | null
  /** What to tell the person about the last take: why it stopped early, or that it was discarded. */
  notice: string | null
  error: string | null
  recordingId: string | null
}

export const COUNTDOWN = 3

/** The recorder parts the flow drives (recorder.ts's Recorder satisfies it). */
export interface FlowRecorder {
  recordingId: string
  start(atContextTime?: number): void
  cancel(): Promise<void>
}

export interface RememberedTake {
  pieces: RecordedPlacement[]
  stop: StopKind | null
}

export interface RecordFlowParts<C, R extends FlowRecorder> {
  /** In the Record click, before anything else is awaited: a new AudioContext, resumed. */
  openContext(): Promise<C>
  /** Opens the mic and the capture chain in that context. */
  createRecorder(ctx: C): Promise<R>
  /** Rewinds the picture and loads the monitor's stems; resolves when both can play. */
  prepare(ctx: C): Promise<void>
  wait(ms: number): Promise<void>
  /** Arms the picture clock (and the monitor on it), gives it the take's first frame, and plays the picture. */
  roll(ctx: C, rec: R): Promise<void>
  /** Stops the picture clock (its stop listener may call stopped()), pauses the picture, stops the monitor. */
  halt(kind: StopKind, detail?: string): StopReason | null
  /** The take's fit segments: final after halt, so far while recording. */
  fit(): readonly FitSegment[]
  /** The route's calibration and the take's manual Sync offset (placeRecordedTake's arguments). */
  offsets(): { calibrationOffsetSamples: number; manualOffsetSamples: number }
  /** Writes the take's placement to its recovery record; best effort. */
  remember(recordingId: string, take: RememberedTake): Promise<void>
  upload: { recording(id: string): void; finish(rec: R): Promise<void>; reset(): void }
  /** Closes the context once the take is stopped or dropped (the recorder has released the mic). */
  release(ctx: C): void
  log?: (event: string, fields: Record<string, unknown>) => void
}

export interface RecordFlow {
  get(): FlowSnapshot
  open(): void
  close(): void
  /** The Record click. */
  record(): Promise<void>
  /** Space: stops and keeps (during the countdown nothing was recorded against the picture, so nothing is kept). */
  stop(kind?: StopKind, detail?: string, notice?: string): void
  /** The picture clock stopped the take (its onStop listener). */
  stopped(reason: StopReason): void
  /** Esc, or leaving: drops the take and its recovery copy, and releases the mic. */
  discard(notice?: string | null): Promise<void>
  /** Called while recording (every couple of seconds): the placement so far, for a reload mid-take. */
  checkpoint(): Promise<void>
  /** The uploader's state (useTakeUpload). */
  uploadChanged(state: TakeUploadState, error: string | null): void
  /** A stopped take's clips, for onTakeReady. */
  placementsFor(recordingId: string): RecordedPlacement[] | null
  dispose(): void
}

export const DISCARDED = 'Take discarded.'
export const TOO_EARLY = 'Stopped before the picture started, so nothing was kept.'

/** The take's clips: the fit placed with the offsets, then the countdown's pre-roll (before composition 0) cut off. */
export function takePlacements(
  segments: readonly FitSegment[],
  offsets: { calibrationOffsetSamples: number; manualOffsetSamples: number },
): RecordedPlacement[] {
  return trimPreRoll(
    placeRecordedTake(segments, offsets.calibrationOffsetSamples, offsets.manualOffsetSamples),
  )
}

/**
 * Pieces start at the first source sample that lands at or after composition 0: the mic was capturing through the
 * countdown, and that part (before the picture starts) isn't on the timeline. A piece wholly before 0 is dropped.
 */
export function trimPreRoll(pieces: readonly RecordedPlacement[]): RecordedPlacement[] {
  const out: RecordedPlacement[] = []
  for (const p of pieces) {
    if (p.start >= 0) {
      out.push(p)
      continue
    }
    const { a, b } = p.fit
    if (!(b > 0)) continue
    // Composition 0 is source sample (−offset/SR − a)/b; rounding can leave it a sample short.
    let s = Math.max(p.srcStart, Math.ceil((-p.offsetSamples / SAMPLE_RATE - a) / b))
    while (s < p.srcEnd && placeTake(p.fit, p.offsetSamples, s) < 0) s++
    if (s >= p.srcEnd) continue
    out.push({ ...p, srcStart: s, start: placeTake(p.fit, p.offsetSamples, s) })
  }
  return out
}

/** Pieces cut to the take's length (the uploaded file's samples); empty ones dropped. */
export function clampToTake(pieces: readonly RecordedPlacement[], samples: number): RecordedPlacement[] {
  return pieces
    .map((p) => ({ ...p, srcEnd: Math.min(p.srcEnd, Math.floor(samples)) }))
    .filter((p) => p.srcEnd > p.srcStart)
}

/** A recovered take's clips, from its record (null when it has none: it goes at the playhead like an upload). */
export function placementsFromRecord(record: TakeRecord | null | undefined): RecordedPlacement[] | null {
  const pieces = record?.placement?.pieces
  return pieces?.length ? pieces.map((p) => ({ ...p })) : null
}

/** What a key does while a take runs: Space keeps, Esc discards. */
export function flowKey(phase: FlowPhase, key: string): 'stop' | 'discard' | null {
  if (phase !== 'countdown' && phase !== 'recording') return null
  if (key === ' ' || key === 'Spacebar') return 'stop'
  if (key === 'Escape' || key === 'Esc') return 'discard'
  return null
}

/** Phases in which Record can be pressed. */
export const canRecord = (phase: FlowPhase) => phase === 'setup' || phase === 'saved' || phase === 'failed'
/** Phases in which a take is in the mic's hands: the setup is fixed and the panel stays open. */
export const isRunning = (phase: FlowPhase) =>
  phase === 'countdown' || phase === 'recording' || phase === 'stopping'

const message = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Something went wrong.')

const IDLE: FlowSnapshot = {
  phase: 'idle',
  open: false,
  count: null,
  stop: null,
  notice: null,
  error: null,
  recordingId: null,
}

export function createRecordFlow<C, R extends FlowRecorder>(
  parts: RecordFlowParts<C, R>,
  onChange: (s: FlowSnapshot) => void = () => undefined,
): RecordFlow {
  let snap = IDLE
  // The take being recorded: its context and recorder, and whether the picture has started.
  let cur: { ctx: C; rec: R; rolling: boolean; keeping: boolean } | null = null
  // Each Record click gets a generation; a discard makes the old one's later steps no-ops.
  let gen = 0
  const placed = new Map<string, RecordedPlacement[]>()
  const log = parts.log ?? (() => undefined)

  const set = (patch: Partial<FlowSnapshot>) => {
    snap = { ...snap, ...patch }
    onChange(snap)
  }
  /** Back to the open panel (or idle, if it was closed meanwhile). */
  const rest = (patch: Partial<FlowSnapshot>) =>
    set({ phase: snap.open ? 'setup' : 'idle', count: null, ...patch })

  const drop = async (take: typeof cur) => {
    if (!take) return
    try {
      await take.rec.cancel()
    } catch {
      // the recovery sweep clears it
    }
    parts.release(take.ctx)
  }

  const keep = async (reason: StopReason, notice?: string) => {
    const take = cur
    if (!take || take.keeping) return
    take.keeping = true
    const early = reason.kind !== 'user' && reason.kind !== 'ended'
    set({
      phase: 'stopping',
      count: null,
      stop: reason,
      notice: notice ?? (early ? STOP_MESSAGES[reason.kind] : null),
    })
    parts.halt(reason.kind, reason.detail)
    const pieces = takePlacements(parts.fit(), parts.offsets())
    placed.set(take.rec.recordingId, pieces)
    log('record.stop', {
      recordingId: take.rec.recordingId,
      kind: reason.kind,
      atSample: reason.atSample,
      pieces: pieces.length,
      start: pieces[0]?.start ?? null,
    })
    await parts.remember(take.rec.recordingId, { pieces, stop: reason.kind }).catch(() => undefined)
    try {
      await parts.upload.finish(take.rec)
    } finally {
      if (cur === take) cur = null
      parts.release(take.ctx)
    }
  }

  const flow: RecordFlow = {
    get: () => snap,
    open() {
      if (snap.open) return
      set({ open: true, ...(snap.phase === 'idle' ? { phase: 'setup' as const } : {}) })
    },
    close() {
      if (isRunning(snap.phase)) return
      const settled = snap.phase === 'setup' || snap.phase === 'saved' || snap.phase === 'failed'
      set({ open: false, ...(settled ? { phase: 'idle' as const, notice: null, error: null } : {}) })
    },
    async record() {
      if (!canRecord(snap.phase) || cur) return
      const my = ++gen
      const live = () => my === gen
      set({ phase: 'countdown', count: COUNTDOWN, stop: null, notice: null, error: null, recordingId: null })
      const t0 = Date.now()
      let ctx: C | null = null
      try {
        ctx = await parts.openContext()
        const rec = await parts.createRecorder(ctx)
        if (!live()) {
          await drop({ ctx, rec, rolling: false, keeping: false })
          return
        }
        const take = { ctx, rec, rolling: false, keeping: false }
        cur = take
        // The mic captures from here, through the countdown.
        rec.start()
        parts.upload.recording(rec.recordingId)
        set({ recordingId: rec.recordingId })
        log('record.armed', { recordingId: rec.recordingId, ms: Date.now() - t0 })
        const ready = parts.prepare(ctx)
        for (let n = COUNTDOWN; n > 0; n--) {
          set({ count: n })
          await parts.wait(1000)
          if (!live()) return
        }
        await ready
        if (!live()) return
        take.rolling = true
        set({ count: null })
        await parts.roll(ctx, rec)
        if (!live() || take.keeping) return
        set({ phase: 'recording' })
        log('record.rolling', { recordingId: rec.recordingId, ms: Date.now() - t0 })
      } catch (e) {
        if (!live()) {
          if (ctx && !cur) parts.release(ctx)
          return
        }
        log('record.failed', { error: message(e) })
        const take = cur
        cur = null
        if (take) await drop(take)
        else if (ctx) parts.release(ctx)
        parts.upload.reset()
        set({ phase: 'failed', count: null, error: message(e) })
      }
    },
    stop(kind = 'user', detail, notice) {
      const take = cur
      if (!take || take.keeping) return
      if (!take.rolling) {
        void flow.discard(TOO_EARLY)
        return
      }
      const reason = parts.halt(kind, detail) ?? {
        kind,
        atPerf: 0,
        atSample: null,
        ...(detail ? { detail } : {}),
      }
      void keep(reason, notice)
    },
    stopped(reason) {
      const take = cur
      if (!take?.rolling || take.keeping) return
      void keep(reason)
    },
    async discard(notice = DISCARDED) {
      const take = cur
      if (!take) {
        // Still opening the mic: the Record click's later steps see the new generation and drop what they made.
        if (snap.phase === 'countdown') {
          gen++
          rest({ stop: null, notice, error: null })
        }
        return
      }
      if (take.keeping) return
      gen++
      cur = null
      rest({ stop: null, notice, error: null })
      if (take.rolling) parts.halt('user')
      parts.upload.reset()
      log('record.discard', { recordingId: take.rec.recordingId, rolling: take.rolling })
      await drop(take)
    },
    async checkpoint() {
      const take = cur
      if (!take?.rolling || take.keeping) return
      const pieces = takePlacements(parts.fit(), parts.offsets())
      if (pieces.length)
        await parts.remember(take.rec.recordingId, { pieces, stop: null }).catch(() => undefined)
    },
    uploadChanged(state, error) {
      const p = snap.phase
      // A take being recorded owns the phase; the uploader only speaks once it has the take.
      if (p === 'countdown' || p === 'recording') return
      if (state === 'finalizing') set({ phase: 'stopping' })
      else if (state === 'uploading' || state === 'processing' || state === 'saving')
        set({ phase: 'uploading', error: null })
      else if (state === 'saved') set({ phase: 'saved', error: null })
      else if (state === 'failed') set({ phase: 'failed', error })
    },
    placementsFor: (id) => placed.get(id) ?? null,
    dispose() {
      void flow.discard(null)
    },
  }
  return flow
}
