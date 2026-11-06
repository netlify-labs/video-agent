// The record flow (docs/plans/2026-11-02-record-your-own-voiceover.md §2.1 steps 4-6, §5.1, §5.3): one take from the
// Record click to a saved clip. The click is the gesture that makes and resumes the AudioContext; the mic captures
// through a 3-2-1 countdown (so the first word isn't clipped) while the picture rewinds and the monitor's stems load;
// then the picture plays from the start, its anchors fit the take, and the monitor follows it. Space stops and keeps,
// Esc discards, and any stop the picture clock raises (seek, stall, hidden tab, device change, track ended, context
// interrupted, residual or slope) keeps the clean part and says why. On stop the fit segments, the route's calibration
// and the manual Sync offset become the clips' placement (the countdown's pre-roll trimmed off), written to the take's
// recovery record, and the uploader takes it from there (take-upload.ts).
//
//   idle -> setup -> countdown -> recording -> stopping -> review -> adding -> saved
//             ^  \______ Esc / failure ____/                  |  \___ failed (retry) ___/
//             \____________ Discard / Record again ____________/
//
// Review (owner, 2026-11-06): a stopped take waits in the panel to be heard against the picture before it goes on the
// timeline. Its upload runs as before (so it's never lost); only the insert waits for the decision: Add (Enter) puts it
// on the track, Discard (Esc) drops it, Record again drops it and records the same take again, and Keep recording from
// here adds it and punches in from where it stopped to the end, then reviews the joined result.
//
// Framework-free: the editor (NarrationRecorder.tsx) supplies the parts (recorder, picture clock, monitor, uploader);
// the tests supply fakes.
//
// A punch-in (§2.2) is the same flow with a range: the picture starts the pre-roll before the punch point, the monitor
// mutes the existing narration inside the range from the punch point on, and only the samples placed inside the
// range (or from the punch point until stop) become the clip; the whole capture is still the take's source.
import { placeTake, SAMPLE_RATE, type Span } from '../../../src/lib/timeline'
import { placeRecordedTake, type FitSegment, type RecordedPlacement } from './clock'
import { stopMessage } from './clock/fit'
import type { StopKind, StopReason } from './clock/fit'
import type { TakeRecord } from './store'
import type { TakeUploadState } from './take-upload'

export type FlowPhase =
  | 'idle'
  | 'setup'
  | 'countdown'
  | 'recording'
  | 'stopping'
  | 'review'
  | 'adding'
  | 'uploading'
  | 'saved'
  | 'failed'

/** A stopped take waiting for Add, Discard, Record again or Keep recording. */
export interface Review {
  recordingId: string
  /** Its clips as Add would put them on the track. */
  pieces: RecordedPlacement[]
  punch: Punch | null
  /** It stopped on its own (seek, stall, sync...), not on Space or at the end. */
  early: boolean
  /** Composition sample the review plays from: the picture's start (a punch's pre-roll), or 0 for a joined take. */
  from: number
  /** A Keep recording from here: the take before it is already on the track, and the review plays both. */
  joined: boolean
}

export type ReviewDecision = 'add' | 'discard'

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
  /** The punch-in being recorded (or last recorded); null for a whole take. */
  punch: Punch | null
  /** The take being reviewed (phase review, adding), else null. */
  review: Review | null
}

export const COUNTDOWN = 3

/** A punch-in (§2.2): re-record composition samples [from, to), or from `from` until stop when `to` is null. */
export interface Punch {
  from: number
  to: number | null
}

/** Where a take's picture starts and what it records into. */
export interface TakeStart {
  /** Composition sample the picture starts at: 0 for a whole take, the punch point less the pre-roll for a punch. */
  pictureFrom: number
  punch: Punch | null
}

/** Pre-roll before a punch point, in seconds: 2 by default, 0 to 5 (§2.2 step 2). */
export const PRE_ROLL_SEC = 2
export const MAX_PRE_ROLL_SEC = 5

/** A pre-roll setting held to 0..MAX_PRE_ROLL_SEC (the default when it isn't a number). */
export function clampPreRoll(sec: unknown): number {
  const v = typeof sec === 'string' && sec.trim() !== '' ? Number(sec) : sec
  if (typeof v !== 'number' || !Number.isFinite(v)) return PRE_ROLL_SEC
  return Math.min(MAX_PRE_ROLL_SEC, Math.max(0, v))
}

/** Where the picture starts for a take: a punch plays its pre-roll first (never before composition 0). */
export function takeStart(punch: Punch | null, preRollSec = PRE_ROLL_SEC): TakeStart {
  if (!punch) return { pictureFrom: 0, punch: null }
  const pictureFrom = Math.max(0, punch.from - Math.round(clampPreRoll(preRollSec) * SAMPLE_RATE))
  return { pictureFrom, punch }
}

/** The composition range the monitor mutes the existing narration in for a punch (`to` Infinity until stop). */
export const armedRange = (punch: Punch): Span => [punch.from, punch.to ?? Infinity]

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
  /** Cues the picture at the take's start and loads the monitor's stems; resolves when both can play. */
  prepare(ctx: C, start: TakeStart): Promise<void>
  wait(ms: number): Promise<void>
  /** Mutes the existing narration in the monitor inside `range` (a punch's), or unmutes it (null). */
  arm(range: Span | null): void
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
  /**
   * The Record click; with `punch`, a punch-in over that range after `preRollSec` of pre-roll. `joined`: a Keep
   * recording from here, whose review plays from 0 with the take before it.
   */
  record(punch?: Punch | null, preRollSec?: number, opts?: { joined?: boolean }): Promise<void>
  /** Space: stops and keeps (during the countdown nothing was recorded against the picture, so nothing is kept). */
  stop(kind?: StopKind, detail?: string, notice?: string): void
  /** The picture clock stopped the take (its onStop listener). */
  stopped(reason: StopReason): void
  /** Esc, or leaving: drops the take and its recovery copy, and releases the mic. */
  discard(notice?: string | null): Promise<void>
  /** Called while recording (every couple of seconds): the placement so far, for a reload mid-take. */
  checkpoint(): Promise<void>
  /** The uploader's state (useTakeUpload), for the take `recordingId` when known. */
  uploadChanged(state: TakeUploadState, error: string | null, recordingId?: string | null): void
  /** What to do with a stopped take once it's uploaded: waits for Add or Discard (a take never reviewed is added). */
  decide(recordingId: string): Promise<ReviewDecision>
  /** Review: Add to timeline (Enter). */
  add(): void
  /** Review: Discard (Esc). The upload finishes; the take just doesn't go on the track. */
  reject(notice?: string): void
  /** Review: drops this take and records it again (the same punch). Call it in the click. */
  recordAgain(preRollSec?: number): void
  /** Review: adds this take and punches in from where it ended to the end. Call it in the click. */
  keepRecording(preRollSec?: number): void
  /** A stopped take's clips, for onTakeReady. */
  placementsFor(recordingId: string): RecordedPlacement[] | null
  /** The punch-in a stopped take was recorded for (null for a whole take). */
  punchFor(recordingId: string): Punch | null
  dispose(): void
}

export const DISCARDED = 'Take discarded.'
export const TOO_EARLY = 'Stopped before the picture started, so nothing was kept.'
export const BEFORE_PUNCH = 'Stopped before the punch point, so nothing was kept.'

/**
 * The take's clips: the fit placed with the offsets, then cut to what goes on the timeline. A whole take loses the
 * countdown (before composition 0); a punch keeps only its range (or from the punch point on, with no end).
 */
export function takePlacements(
  segments: readonly FitSegment[],
  offsets: { calibrationOffsetSamples: number; manualOffsetSamples: number },
  punch: Punch | null = null,
): RecordedPlacement[] {
  const pieces = placeRecordedTake(segments, offsets.calibrationOffsetSamples, offsets.manualOffsetSamples)
  return punch ? sliceToRange(pieces, punch.from, punch.to ?? Infinity) : trimPreRoll(pieces)
}

/**
 * Pieces cut to composition [from, to). A piece starts at its first source sample placed at or after `from` (by its
 * own fit and offset), and ends where it reaches `to` (the clip plays its source sample by sample from there, so its
 * end is exact). Pieces wholly outside the range are dropped; one already inside it is untouched.
 */
export function sliceToRange(
  pieces: readonly RecordedPlacement[],
  from: number,
  to = Infinity,
): RecordedPlacement[] {
  const out: RecordedPlacement[] = []
  for (const p of pieces) {
    let s = p.srcStart
    let start = p.start
    if (start < from) {
      const { a, b } = p.fit
      if (!(b > 0)) continue
      // `from` is source sample ((from − offset)/SR − a)/b; rounding can leave the estimate a sample either side.
      s = Math.max(p.srcStart, Math.ceil(((from - p.offsetSamples) / SAMPLE_RATE - a) / b))
      while (s > p.srcStart && placeTake(p.fit, p.offsetSamples, s - 1) >= from) s--
      while (s < p.srcEnd && placeTake(p.fit, p.offsetSamples, s) < from) s++
      if (s >= p.srcEnd) continue
      start = placeTake(p.fit, p.offsetSamples, s)
    }
    const srcEnd = Number.isFinite(to) ? Math.min(p.srcEnd, s + (to - start)) : p.srcEnd
    if (srcEnd <= s) continue
    out.push(s === p.srcStart && srcEnd === p.srcEnd ? p : { ...p, srcStart: s, srcEnd, start })
  }
  return out
}

/**
 * Pieces start at the first source sample that lands at or after composition 0: the mic was capturing through the
 * countdown, and that part (before the picture starts) isn't on the timeline. A piece wholly before 0 is dropped.
 */
export const trimPreRoll = (pieces: readonly RecordedPlacement[]): RecordedPlacement[] =>
  sliceToRange(pieces, 0)

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

/** What a key does: while a take runs, Space keeps and Esc discards; in review, Enter adds and Esc discards. */
export function flowKey(phase: FlowPhase, key: string): 'stop' | 'discard' | 'add' | null {
  if (phase === 'review') {
    if (key === 'Enter') return 'add'
    if (key === 'Escape' || key === 'Esc') return 'discard'
    return null
  }
  if (phase !== 'countdown' && phase !== 'recording') return null
  if (key === ' ' || key === 'Spacebar') return 'stop'
  if (key === 'Escape' || key === 'Esc') return 'discard'
  return null
}

/** R with no modifier punches in (at the playhead, or over the selected range); the caller skips text fields. */
export const isPunchKey = (e: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean }) =>
  (e.key === 'r' || e.key === 'R') && !e.altKey && !e.ctrlKey && !e.metaKey

/** The punch the editor's playhead and ruler selection mean: the range if there is one, else from the playhead on. */
export const punchAt = (playhead: number, range: Span | null): Punch =>
  range && range[1] > range[0] ? { from: range[0], to: range[1] } : { from: Math.max(0, playhead), to: null }

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
  punch: null,
  review: null,
}

/**
 * The second the teleprompter shows. From the Record click through the 3-2-1, the take's start (its first line, or a
 * punch point's): the picture clock still holds the last take's anchors and the picture sits wherever it was left
 * until the new take cues it. In review the picture plays on its own, so its time; otherwise the picture clock's.
 */
export function prompterTime(
  phase: FlowPhase,
  o: { startsAt: number; pictureClock: number | null; videoTime: number | null },
): number {
  if (phase === 'countdown') return o.startsAt
  if (phase === 'review' || phase === 'adding') return o.videoTime ?? o.pictureClock ?? 0
  return o.pictureClock ?? o.videoTime ?? 0
}

/** Where a take's clips end on the composition (samples): what Keep recording from here punches in from. */
export function takeEnd(pieces: readonly RecordedPlacement[]): number {
  return Math.max(0, ...pieces.map((p) => placeTake(p.fit, p.offsetSamples, p.srcEnd)))
}

export function createRecordFlow<C, R extends FlowRecorder>(
  parts: RecordFlowParts<C, R>,
  onChange: (s: FlowSnapshot) => void = () => undefined,
): RecordFlow {
  let snap = IDLE
  // The take being recorded: its context and recorder, whether the picture has started, and its punch range.
  let cur: {
    ctx: C
    rec: R
    rolling: boolean
    keeping: boolean
    punch: Punch | null
    from: number
    joined: boolean
  } | null = null
  // Each Record click gets a generation; a discard makes the old one's later steps no-ops.
  let gen = 0
  const placed = new Map<string, RecordedPlacement[]>()
  const punches = new Map<string, Punch>()
  const log = parts.log ?? (() => undefined)
  // Each reviewed take's decision, awaited by the uploader's onTakeReady (decide) and given by the review's buttons.
  interface Pending {
    promise: Promise<ReviewDecision>
    resolve: (d: ReviewDecision) => void
    value: ReviewDecision | null
  }
  const decisions = new Map<string, Pending>()
  const decision = (id: string) => {
    let d = decisions.get(id)
    if (!d) {
      let settle: (v: ReviewDecision) => void = () => undefined
      const promise = new Promise<ReviewDecision>((r) => (settle = r))
      const entry: Pending = {
        promise,
        value: null,
        // The first decision wins (Keep recording's add, then a stray Enter, decide nothing more).
        resolve: (v: ReviewDecision) => {
          if (entry.value) return
          entry.value = v
          settle(v)
        },
      }
      d = entry
      decisions.set(id, d)
    }
    return d
  }
  // The reviewed take is stopped and uploading: a new take may start now (its upload settles on its own and releases
  // the old context).
  const letGo = (recordingId: string) => {
    if (cur?.rec.recordingId === recordingId) cur = null
  }
  // Takes discarded in review: their upload still finishes, and says nothing.
  const discarded = new Set<string>()
  let lastUpload: { state: TakeUploadState; error: string | null } = { state: 'idle', error: null }

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
      notice: notice ?? (early ? stopMessage(reason) : null),
    })
    parts.halt(reason.kind, reason.detail)
    if (take.punch) parts.arm(null)
    const pieces = takePlacements(parts.fit(), parts.offsets(), take.punch)
    log('record.stop', {
      recordingId: take.rec.recordingId,
      kind: reason.kind,
      early,
      atSample: reason.atSample,
      pieces: pieces.length,
      start: pieces[0]?.start ?? null,
      ...(take.punch ? { punch: [take.punch.from, take.punch.to] } : {}),
    })
    // Every early stop, with its kind and the clock's detail, so a take that stops short can be explained.
    if (early)
      log('record.stop_early', {
        recordingId: take.rec.recordingId,
        kind: reason.kind,
        detail: reason.detail ?? null,
        atSample: reason.atSample,
        keptSec: pieces.length
          ? Math.round(((takeEnd(pieces) - (pieces[0]?.start ?? 0)) / SAMPLE_RATE) * 10) / 10
          : 0,
      })
    if (take.punch && !pieces.length) {
      // Stopped in the pre-roll: nothing landed in the range, so there's no clip to keep.
      if (cur === take) cur = null
      gen++
      parts.upload.reset()
      rest({ stop: reason, notice: BEFORE_PUNCH, error: null })
      await drop(take)
      return
    }
    placed.set(take.rec.recordingId, pieces)
    if (take.punch) punches.set(take.rec.recordingId, take.punch)
    decision(take.rec.recordingId)
    await parts.remember(take.rec.recordingId, { pieces, stop: reason.kind }).catch(() => undefined)
    if (cur === take && !discarded.has(take.rec.recordingId)) {
      const review: Review = {
        recordingId: take.rec.recordingId,
        pieces,
        punch: take.punch,
        early,
        from: take.joined ? 0 : take.from,
        joined: take.joined,
      }
      set({ phase: 'review', review })
      log('record.review', {
        recordingId: review.recordingId,
        from: review.from,
        end: takeEnd(pieces),
        early,
      })
    }
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
      if (isRunning(snap.phase) || snap.phase === 'review' || snap.phase === 'adding') return
      const settled = snap.phase === 'setup' || snap.phase === 'saved' || snap.phase === 'failed'
      set({ open: false, ...(settled ? { phase: 'idle' as const, notice: null, error: null } : {}) })
    },
    async record(punch = null, preRollSec = PRE_ROLL_SEC, opts = {}) {
      if (!canRecord(snap.phase) || cur) return
      const joined = opts.joined === true
      const my = ++gen
      const live = () => my === gen
      const start = takeStart(punch, preRollSec)
      set({
        phase: 'countdown',
        count: COUNTDOWN,
        stop: null,
        notice: null,
        error: null,
        recordingId: null,
        punch,
        review: null,
      })
      const t0 = Date.now()
      let ctx: C | null = null
      try {
        ctx = await parts.openContext()
        const rec = await parts.createRecorder(ctx)
        const from = start.pictureFrom
        if (!live()) {
          await drop({ ctx, rec, rolling: false, keeping: false, punch, from, joined })
          return
        }
        const take = { ctx, rec, rolling: false, keeping: false, punch, from, joined }
        cur = take
        // The mic captures from here, through the countdown.
        rec.start()
        parts.upload.recording(rec.recordingId)
        set({ recordingId: rec.recordingId })
        log('record.armed', {
          recordingId: rec.recordingId,
          ms: Date.now() - t0,
          pictureFrom: start.pictureFrom,
          ...(punch ? { punch: [punch.from, punch.to] } : {}),
        })
        const ready = parts.prepare(ctx, start)
        for (let n = COUNTDOWN; n > 0; n--) {
          set({ count: n })
          await parts.wait(1000)
          if (!live()) return
        }
        await ready
        if (!live()) return
        take.rolling = true
        set({ count: null })
        // The monitor plays the existing narration through the pre-roll and mutes it from the punch point.
        if (punch) parts.arm(armedRange(punch))
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
        if (punch) parts.arm(null)
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
      if (take.punch) parts.arm(null)
      parts.upload.reset()
      log('record.discard', { recordingId: take.rec.recordingId, rolling: take.rolling })
      await drop(take)
    },
    async checkpoint() {
      const take = cur
      if (!take?.rolling || take.keeping) return
      const pieces = takePlacements(parts.fit(), parts.offsets(), take.punch)
      if (pieces.length)
        await parts.remember(take.rec.recordingId, { pieces, stop: null }).catch(() => undefined)
    },
    uploadChanged(state, error, recordingId) {
      if (recordingId && discarded.has(recordingId)) return
      lastUpload = { state, error }
      const p = snap.phase
      // A take being recorded owns the phase; the uploader only speaks once it has the take.
      if (p === 'countdown' || p === 'recording') return
      // In review the take uploads quietly; a failure shows (with Retry) but the review stays.
      if (p === 'review') {
        if (state === 'failed') set({ error })
        else if (snap.error && state !== 'idle') set({ error: null })
        return
      }
      if (p === 'adding') {
        if (state === 'saved') set({ phase: 'saved', error: null, review: null })
        else if (state === 'failed') set({ phase: 'failed', error })
        return
      }
      if (state === 'finalizing') set({ phase: 'stopping' })
      else if (state === 'uploading' || state === 'processing' || state === 'saving')
        set({ phase: 'uploading', error: null })
      else if (state === 'saved') set({ phase: 'saved', error: null })
      else if (state === 'failed') set({ phase: 'failed', error })
    },
    decide(recordingId) {
      // A take that was never reviewed (a recovered one) goes on the track as before.
      if (!placed.has(recordingId) && !decisions.has(recordingId)) return Promise.resolve('add')
      return decision(recordingId).promise
    },
    add() {
      const r = snap.review
      if (snap.phase !== 'review' || !r) return
      decision(r.recordingId).resolve('add')
      log('record.review_add', { recordingId: r.recordingId })
      if (lastUpload.state === 'failed') set({ phase: 'failed', error: lastUpload.error })
      else set({ phase: 'adding', notice: null })
    },
    reject(notice = DISCARDED) {
      const r = snap.review
      if (snap.phase !== 'review' || !r) return
      discarded.add(r.recordingId)
      decision(r.recordingId).resolve('discard')
      log('record.review_discard', { recordingId: r.recordingId })
      rest({ stop: null, notice, error: null, review: null })
    },
    recordAgain(preRollSec = PRE_ROLL_SEC) {
      const r = snap.review
      if (snap.phase !== 'review' || !r) return
      discarded.add(r.recordingId)
      decision(r.recordingId).resolve('discard')
      log('record.review_again', { recordingId: r.recordingId })
      letGo(r.recordingId)
      rest({ stop: null, notice: null, error: null, review: null })
      void flow.record(r.punch, preRollSec, { joined: r.joined })
    },
    keepRecording(preRollSec = PRE_ROLL_SEC) {
      const r = snap.review
      if (snap.phase !== 'review' || !r) return
      decision(r.recordingId).resolve('add')
      const from = takeEnd(r.pieces)
      log('record.review_continue', { recordingId: r.recordingId, from })
      letGo(r.recordingId)
      rest({ stop: null, notice: null, error: null, review: null })
      void flow.record({ from, to: null }, preRollSec, { joined: true })
    },
    placementsFor: (id) => placed.get(id) ?? null,
    punchFor: (id) => punches.get(id) ?? null,
    dispose() {
      void flow.discard(null)
    },
  }
  return flow
}
