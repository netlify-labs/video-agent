// A take from stop to saved (plan 2026-11-02 §5.1, "Upload" and "On stop"): the recorder's worker has finalized the
// WAV and its file hash, so the uploader never reads it whole; the take goes up in a 'narration-take' session with
// its peaks and speech spans, waits until the media is ready, and only then is the clip added to the narration op and
// the draft saved (by the caller, in onTakeReady). The recovery copy is cleared only after that save succeeds: a take
// is durable once its media is ready and a saved draft references it.
//
// onTakeReady may wait: the record flow's review holds the insert until Add or Discard (the upload doesn't wait).
//
//   idle -> recording -> finalizing -> uploading -> processing -> saving -> saved
//                                   \______________ failed (retry() resumes at the step that failed) ____/
//
// Each step is written to the recovery record, so a reload resumes where it stopped: a take whose media id is known
// skips the upload, and an interrupted upload resumes its session (uploadFile remembers it per user, role and video;
// the recovered WAV is byte-identical). Framework-free; useTakeUpload (use-take-upload.ts) wraps it for React.
import { VAD_VERSION } from '../../../server/lib/peaks'
import type { Span } from '../../../server/lib/timeline'
import type { UploadOptions, UploadProgress } from '../lib/upload'
import type { RecordedTake, Recorder } from './recorder'
import type { RecoveryStore, TakeRecord, UploadState } from './store'

export type TakeUploadState =
  'idle' | 'recording' | 'finalizing' | 'uploading' | 'processing' | 'saving' | 'saved' | 'failed'

export interface TakeUploadSnapshot {
  state: TakeUploadState
  recordingId: string | null
  mediaId: string | null
  /** Upload bytes, while uploading. */
  progress: UploadProgress | null
  /** What people can act on, when failed. */
  error: string | null
  /** The step that failed: retry() starts there. */
  failedAt: 'finalizing' | 'uploading' | 'processing' | 'saving' | null
}

/** What the caller needs to place the clip (firstSampleContextTime and the record's placement, for the record flow). */
export interface ReadyTake {
  recordingId: string
  firstSampleContextTime: number
  record: TakeRecord | null
}

export interface TakeUploadDeps {
  uploadFile: (f: File, opts: UploadOptions) => Promise<string>
  waitReady: (mediaId: string, opts: { signal?: AbortSignal }) => Promise<unknown>
  store: () => Promise<RecoveryStore>
}

export interface TakeUploadConfig {
  userId: string
  /** The video the take is for. */
  scopeJobId: string
  /** Adds the clip to the NarrationOp and saves the draft; throw when the save fails (the recovery copy is kept). */
  onTakeReady: (mediaId: string, samples: number, speech: Span[], take: ReadyTake) => Promise<void>
}

export interface TakeUpload {
  get: () => TakeUploadSnapshot
  /** The record flow started a take. */
  recording: (recordingId: string) => void
  /** Stops the recorder (finalizing) and uploads the take. */
  finish: (recorder: Recorder) => Promise<void>
  /** Uploads a take: just recorded, or recovered (pass its record so a known media id skips the upload). */
  upload: (take: RecordedTake, record?: TakeRecord | null) => Promise<void>
  /** Runs the failed step again, and the rest. */
  retry: () => Promise<void>
  /** Back to idle; stops waiting on the server. */
  reset: () => void
}

const IDLE: TakeUploadSnapshot = {
  state: 'idle',
  recordingId: null,
  mediaId: null,
  progress: null,
  error: null,
  failedAt: null,
}

const reason = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Something went wrong.')

export function createTakeUpload(
  deps: TakeUploadDeps,
  config: () => TakeUploadConfig,
  onChange: (s: TakeUploadSnapshot) => void = () => undefined,
): TakeUpload {
  let snap = IDLE
  let take: RecordedTake | null = null
  let record: TakeRecord | null = null
  let file: File | null = null
  let ready = false
  let abort = new AbortController()
  // Each run gets a generation; a reset() mid-run makes the old run's later steps no-ops.
  let gen = 0

  const set = (patch: Partial<TakeUploadSnapshot>) => {
    snap = { ...snap, ...patch }
    onChange(snap)
  }
  const persist = async (state: UploadState, error: string | null = null) => {
    if (!take?.persisted) return
    try {
      const s = await deps.store()
      const next = await s.patchTake(take.recordingId, {
        upload: { state, mediaId: snap.mediaId, error },
      })
      if (next) record = next
    } catch {
      // the recovery copy is best effort; the upload goes on
    }
  }

  const run = async (from: 'uploading' | 'processing' | 'saving') => {
    const t = take
    if (!t) return
    const my = ++gen
    const live = () => my === gen
    const cfg = config()
    let step: NonNullable<TakeUploadSnapshot['failedAt']> = from
    try {
      if (from === 'uploading') {
        set({ state: 'uploading', error: null, failedAt: null, progress: null })
        await persist('uploading')
        // A fixed name and lastModified, so a retry (or a reload's recovered copy) resumes the same session.
        file ??= new File([t.wav], `take-${t.recordingId}.wav`, {
          type: 'audio/wav',
          lastModified: record?.createdAt ?? Date.now(),
        })
        const mediaId = await deps.uploadFile(file, {
          sha256: t.sha256,
          role: 'narration-take',
          scopeJobId: cfg.scopeJobId,
          userId: cfg.userId,
          extra: { peaks: t.peaks, speech: { version: VAD_VERSION, spans: t.speech, samples: t.samples } },
          onProgress: (p) => {
            if (live()) set({ progress: p })
          },
        })
        if (!live()) return
        set({ mediaId, progress: null })
      }
      const mediaId = snap.mediaId
      if (!mediaId) throw new Error('The upload gave no media id.')
      if (!ready) {
        step = 'processing'
        set({ state: 'processing', error: null, failedAt: null })
        await persist('processing')
        await deps.waitReady(mediaId, { signal: abort.signal })
        if (!live()) return
        ready = true
        await persist('ready')
      }
      step = 'saving'
      set({ state: 'saving', error: null, failedAt: null })
      await cfg.onTakeReady(mediaId, t.samples, t.speech, {
        recordingId: t.recordingId,
        firstSampleContextTime: t.firstSampleContextTime,
        record,
      })
      // Saved (or, reviewed, discarded on purpose): the local copy can go. Even when a newer take has started meanwhile
      // (Keep recording from here starts one while this one is added), since this one is settled.
      if (t.persisted)
        try {
          await (await deps.store()).deleteTake(t.recordingId)
        } catch {
          // swept after 7 days anyway
        }
      if (!live()) return
      set({ state: 'saved' })
    } catch (e) {
      if (!live()) return
      set({ state: 'failed', error: reason(e), failedAt: step, progress: null })
      await persist('failed', reason(e))
    }
  }

  const upload = async (t: RecordedTake, rec: TakeRecord | null = null) => {
    take = t
    record = rec
    if (!record && t.persisted)
      try {
        record = (await (await deps.store()).getTake(t.recordingId)) ?? null
      } catch {
        // no record: the upload just can't resume after a reload
      }
    file = null
    ready = false
    abort = new AbortController()
    const known = record?.upload.mediaId ?? null
    snap = { ...IDLE, state: known ? 'processing' : 'uploading', recordingId: t.recordingId, mediaId: known }
    onChange(snap)
    await run(known ? 'processing' : 'uploading')
  }

  return {
    get: () => snap,
    recording(recordingId) {
      gen++
      take = null
      record = null
      file = null
      ready = false
      snap = { ...IDLE, state: 'recording', recordingId }
      onChange(snap)
    },
    async finish(recorder) {
      set({ state: 'finalizing', recordingId: recorder.recordingId, error: null, failedAt: null })
      try {
        const t = await recorder.stop()
        await upload(t)
      } catch (e) {
        if (!take) set({ state: 'failed', error: reason(e), failedAt: 'finalizing' })
        else throw e
      }
    },
    upload,
    async retry() {
      if (snap.state !== 'failed' || !take) return
      abort = new AbortController()
      await run(snap.mediaId ? (ready ? 'saving' : 'processing') : 'uploading')
    },
    reset() {
      gen++
      abort.abort()
      take = null
      record = null
      file = null
      ready = false
      snap = IDLE
      onChange(snap)
    },
  }
}
