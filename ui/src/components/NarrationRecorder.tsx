// Record a take from the editor (docs/plans/2026-11-02-record-your-own-voiceover.md §2.1, §5.1, §5.3): the Narration
// section's recorder slot. Record voice-over opens the setup panel (mic, output, calibration, original audio) and the
// recording layout: the base version's MP4, muted, in this document on the left and the teleprompter on the right
// (stacked on narrow windows). Record is the gesture that makes the AudioContext; the record flow (recorder/flow.ts)
// runs the countdown, the picture clock, the stem monitor and the stop rules, and useTakeUpload takes the stopped take
// to a ready clip, which lands on the Narration track where it was recorded (one undo step) and is saved with the
// draft. Takes a reload or a failure left behind are offered again (RecoveryPrompt). Leaving the editor discards a
// running take and releases the mic.
// Punch in (§2.2): Punch in, or R outside a text field, re-records the ruler's selected range (or from the playhead
// until stop). The picture starts the pre-roll before the punch point (2 s, 0-5 s, remembered in this browser) with
// the existing narration in the monitor; from the punch point the monitor mutes it inside the range, and only the
// range's samples land on the track, laid over the older clips (one undo step).
// Review (owner, 2026-11-06): a stopped take doesn't go straight on the track. The panel plays it against the picture
// as Add would leave it (TakeReview), and Add (Enter), Record again, Keep recording from here or Discard (Esc) decide;
// the take uploads meanwhile, so it's never lost, and only the insert waits (onTakeReady awaits the decision).
import { Alert, Button, Card, Group, NumberInput, Progress, Stack, Text } from '@mantine/core'
import {
  IconArrowBarToRight,
  IconMicrophone,
  IconPlayerRecordFilled,
  IconPlayerStopFilled,
  IconX,
} from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { decodePeaks, type Peaks } from '../../../src/lib/peaks'
import { placeTake, SAMPLE_RATE, type NarrationTracks } from '../../../src/lib/timeline'
import { $api } from '../api/client'
import {
  AudioClock,
  CalibrationPanel,
  micClapListener,
  usePictureClock,
  type AudioRoute,
  type CalibrationOffsets,
  type ClapListener,
  type PictureClock,
} from '../recorder/clock'
import {
  canRecord,
  clampPreRoll,
  clampToTake,
  createRecordFlow,
  flowKey,
  isPunchKey,
  isRunning,
  MAX_PRE_ROLL_SEC,
  placementsFromRecord,
  prompterTime,
  punchAt,
  takeEnd,
  type FlowSnapshot,
  type Punch,
  type RecordFlowParts,
} from '../recorder/flow'
import { draftStemLoader, signedTakeLoader, useStemMonitor } from '../recorder/monitor'
import { createRecorder, micStream, type RecordedTake, type Recorder } from '../recorder/recorder'
import { RecoveryPrompt } from '../recorder/RecoveryPrompt'
import { reviewMediaId, reviewOp } from '../recorder/review'
import { TakeReview } from '../recorder/TakeReview'
import { takeBaseName, takeNumber } from '../lib/take-download'
import { TakeDownload } from './TakeDownload'
import { useRecordingRecovery } from '../recorder/recovery'
import { RecordingSetup } from '../recorder/setup/RecordingSetup'
import { micProblem, PROBLEM_COPY, browserOf } from '../recorder/setup/mic'
import {
  defaultSetup,
  monitorDbWhileRecording,
  setupFromTracks,
  setupToRecorderOptions,
  setupToTrackPatch,
  type RecordingSetupValue,
} from '../recorder/setup/setup'
import { recoveryStore } from '../recorder/store'
import { pictureTime, PrompterLayout, Teleprompter, isTextField } from '../recorder/teleprompter'
import { useTakeUpload } from '../recorder/use-take-upload'
import { log } from '../lib/log'
import { formatTime } from '../lib/timeline-view'
import { fileUrl } from './bits'
import type { NarrationTrackApi } from './NarrationSection'

const FPS = 30
const NO_OFFSETS = { calibrationOffsetSamples: 0, manualOffsetSamples: 0 }
/** How long the picture and the monitor's stems may take to be ready before the take goes on without the monitor. */
const READY_MS = 15_000
/** How often a running take's placement is written to its recovery record. */
const CHECKPOINT_MS = 2_000
/** Where this browser remembers the punch-in pre-roll. */
const PRE_ROLL_KEY = 'va.narration.preRollSec'

function storedPreRoll(): number {
  try {
    return clampPreRoll(localStorage.getItem(PRE_ROLL_KEY))
  } catch {
    return clampPreRoll(null)
  }
}

function storePreRoll(sec: number) {
  try {
    localStorage.setItem(PRE_ROLL_KEY, String(sec))
  } catch {
    // A private window: it's remembered for this visit only.
  }
}

const at = (samples: number) => formatTime(samples / SAMPLE_RATE, 0.1)
/** "0:02.0 to 0:04.0", or "from 0:02.0" with no end. */
export const punchText = (p: Punch) => (p.to === null ? `from ${at(p.from)}` : `${at(p.from)} to ${at(p.to)}`)

const INTERRUPTED: Record<string, string> = {
  quota: "Your browser's storage is full, so the take stopped there.",
  storage: "The take couldn't be saved in this browser any more, so it stopped there.",
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Resolves once `ok()` holds (checked every 50 ms), or false after `ms`. */
async function until(ok: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) return false
    await sleep(50)
  }
  return true
}

/**
 * The picture at composition second `time` (0 for a whole take, the pre-roll's start for a punch), paused, with enough
 * buffered to play (a seek while armed would stop the take).
 */
async function cue(video: HTMLVideoElement, time: number) {
  video.pause()
  if (Math.abs(video.currentTime - time) > 1e-3) {
    const seeked = new Promise((r) => video.addEventListener('seeked', r, { once: true }))
    video.currentTime = time
    await seeked
  }
  if (video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
    const ready = new Promise<boolean>((r) => {
      video.addEventListener('canplay', () => r(true), { once: true })
      setTimeout(() => r(false), READY_MS)
    })
    if (!(await ready)) throw new Error("The video didn't load. Check your connection and try again.")
  }
}

/** A clap listener on its own context and mic, opened when the calibration starts (that click is the gesture). */
function setupClapListener(setup: () => RecordingSetupValue): ClapListener {
  let open: { ctx: AudioContext; stream: MediaStream; inner: ClapListener } | null = null
  const close = () => {
    for (const t of open?.stream.getTracks() ?? []) t.stop()
    void open?.ctx.close().catch(() => undefined)
    open = null
  }
  return {
    async start() {
      close()
      const ctx = new AudioContext({ latencyHint: 'interactive' })
      await ctx.resume()
      const stream = await micStream(ctx, setupToRecorderOptions(setup()))
      const inner = micClapListener({ ctx, stream, audioClock: new AudioClock(ctx) })
      open = { ctx, stream, inner }
      await inner.start()
    },
    async stop() {
      const claps = (await open?.inner.stop()) ?? []
      close()
      return claps
    },
  }
}

/** The context rate a take on this device will record at (the route's third part). */
function deviceRate(): number {
  try {
    const c = new AudioContext()
    const rate = c.sampleRate
    void c.close().catch(() => undefined)
    return rate
  } catch {
    return 48_000
  }
}

const takeName = (at: number) =>
  `Recording ${new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`

function peaksOf(t: RecordedTake | undefined): Peaks | null {
  if (!t?.peaks.length) return null
  try {
    return decodePeaks(t.peaks)
  } catch {
    return null
  }
}

export interface NarrationRecorderProps {
  api: NarrationTrackApi
  videoId: string
  /** The base version: its MP4 is the picture. */
  versionN: number
  draft: { id: string; rev: number }
}

export function NarrationRecorder({ api, videoId, versionN, draft }: NarrationRecorderProps) {
  const me = $api.useQuery('get', '/api/v1/me')
  const userId = me.data?.id ?? ''
  const videoTitle =
    $api.useQuery('get', '/api/v1/videos/{id}', { params: { path: { id: videoId } } }).data?.title ?? 'video'
  const latest = useRef({ api, draft, userId })
  latest.current = { api, draft, userId }

  const [snap, setSnap] = useState<FlowSnapshot | null>(null)
  const [setup, setSetup] = useState<RecordingSetupValue>(() =>
    setupFromTracks(api.op.tracks, defaultSetup()),
  )
  const setupRef = useRef(setup)
  setupRef.current = setup
  const [rate, setRate] = useState<number | null>(null)
  const offsets = useRef<CalibrationOffsets | null>(null)
  const [level, setLevel] = useState(0)
  const [preRoll, setPreRoll] = useState(storedPreRoll)
  // Composition second the take's picture starts at, for what the monitor loads first.
  const [monitorFrom, setMonitorFrom] = useState(0)

  // The take's AudioContext and clock (made in the Record click), the picture, and the monitor on them.
  const [audio, setAudio] = useState<{ ctx: AudioContext; clock: AudioClock } | null>(null)
  const [video, setVideo] = useState<HTMLVideoElement | null>(null)
  const videoRef = useRef(video)
  videoRef.current = video
  const picture = usePictureClock(video, { fps: FPS })
  const pictureRef = useRef(picture)
  pictureRef.current = picture
  const clock = useRef<PictureClock | null>(null)
  const detach = useRef<(() => void) | null>(null)
  const stemLoader = useMemo(() => draftStemLoader(draft.id), [draft.id])
  const monitorAudio = useMemo(() => {
    const t = setupToTrackPatch(setup)
    return { aiVoice: t.aiVoice, muteAll: t.original.muteAll }
  }, [setup])
  const monitor = useStemMonitor({
    context: audio?.ctx ?? null,
    clock: audio?.clock ?? null,
    html: api.html,
    op: api.op,
    audio: monitorAudio,
    takeSamples: api.takeSamples,
    takeSpans: api.takeSpans,
    takeLoader: signedTakeLoader,
    stemLoader,
    outputMode: setup.outputMode,
    speakersLevelDb: monitorDbWhileRecording(setup),
    from: monitorFrom,
  })
  const monitorRef = useRef(monitor)
  monitorRef.current = monitor

  // Stopped takes by recording id, for their waveform when they land on the track (and the review's audio).
  const taken = useRef(new Map<string, RecordedTake>())
  const [finalized, setFinalized] = useState(0)
  const flowRef = useRef<ReturnType<typeof createRecordFlow> | null>(null)
  const upload = useTakeUpload({
    userId,
    scopeJobId: videoId,
    onTakeReady: async (mediaId, samples, speech, ready) => {
      // A reviewed take goes on the track only on Add; Discard and Record again leave it uploaded but unused.
      const decided = (await flowRef.current?.decide(ready.recordingId)) ?? 'add'
      if (decided === 'discard') {
        log('record.discarded_after_review', { recordingId: ready.recordingId, mediaId })
        return
      }
      const a = latest.current.api
      const pieces = flowRef.current?.placementsFor(ready.recordingId) ?? placementsFromRecord(ready.record)
      const punched = !!flowRef.current?.punchFor(ready.recordingId)
      const placed = pieces ? clampToTake(pieces, samples) : []
      let op = a.op
      // A retry after a failed save: the clip is already on the track.
      if (!op.clips.some((c) => c.mediaId === mediaId)) {
        const t = taken.current.get(ready.recordingId)
        const r = a.insertTake(
          {
            mediaId,
            samples,
            spans: speech,
            peaks: peaksOf(t),
            name: takeName(ready.record?.createdAt ?? Date.now()),
          },
          placed.length ? placed : {},
          // A punch-in keeps what it covers as the new clip's other takes (Takes in the clip menu).
          { keepTakes: punched },
        )
        if (!r.ok || !r.op) throw new Error(r.message || "The take couldn't be added to the Narration track.")
        op = r.op
      }
      await a.saveDraft(op)
      log('record.saved', { recordingId: ready.recordingId, mediaId, clips: placed.length || 1 })
    },
  })
  const uploadRef = useRef(upload)
  uploadRef.current = upload
  const recovery = useRecordingRecovery(userId || null, draft.id)

  const [flow] = useState(() => {
    // Each take's AudioClock, made with its context (and handed to the monitor through state).
    const clocks = new WeakMap<AudioContext, AudioClock>()
    const parts: RecordFlowParts<AudioContext, Recorder> = {
      async openContext() {
        // Made and resumed inside the Record click: the user gesture that lets it (and the picture) play.
        const ctx = new AudioContext({ latencyHint: 'interactive' })
        const resumed = ctx.resume()
        const audioClock = new AudioClock(ctx).start()
        clocks.set(ctx, audioClock)
        setAudio({ ctx, clock: audioClock })
        await resumed
        return ctx
      },
      async createRecorder(ctx) {
        const { draft: d, userId: u } = latest.current
        try {
          return await createRecorder({
            ...setupToRecorderOptions(setupRef.current),
            context: ctx,
            owner: { userId: u, draftId: d.id, expectedRev: d.rev, scopeJobId: videoId },
            onLevel: (l) => setLevel(l.peak),
            onInterrupted: (reason) => {
              flowRef.current?.stop('user', reason, INTERRUPTED[reason] ?? INTERRUPTED.storage)
            },
          })
        } catch (e) {
          const p = PROBLEM_COPY[micProblem(e)]
          throw new Error(
            `${p.title}. ${p.help(browserOf(navigator.userAgent), /Mac OS X/.test(navigator.userAgent))}`,
            { cause: e },
          )
        }
      },
      async prepare(_ctx, start) {
        // R with the panel closed opens it in the same click: the picture mounts a render later.
        await until(() => !!videoRef.current, READY_MS)
        const v = videoRef.current
        if (!v) throw new Error("The video isn't on the page.")
        await cue(v, start.pictureFrom / SAMPLE_RATE)
        // No composition yet (its preview is still loading): the take records without the monitor.
        const ok = await until(() => !latest.current.api.html || monitorRef.current.ready, READY_MS)
        if (!ok) log('record.monitor_not_ready', { ms: READY_MS })
      },
      wait: sleep,
      arm: (range) => monitorRef.current.setArmedRange(range),
      async roll(ctx, rec) {
        const v = videoRef.current
        const ck = monitorRef.current
        const c = pictureRef.current.start({
          audioClock: clocks.get(ctx) ?? null,
          context: ctx,
          track: rec.stream.getAudioTracks()[0] ?? null,
        })
        if (!v || !c) throw new Error("The video isn't ready.")
        clock.current = c
        detach.current = ck.ready ? ck.attach(c) : null
        const startFrame = await rec.started
        c.beginTake({ startFrame, contextRate: ctx.sampleRate })
        await v.play()
      },
      halt(kind, detail) {
        const c = clock.current
        c?.stop(kind, detail)
        videoRef.current?.pause()
        detach.current?.()
        detach.current = null
        monitorRef.current.stop()
        return c?.stopReason ?? null
      },
      fit: () => clock.current?.fitFor().segments ?? [],
      offsets: () => offsets.current ?? NO_OFFSETS,
      async remember(recordingId, take) {
        const store = await recoveryStore()
        // Only a take the recorder is keeping a copy of (patchTake would make a record otherwise).
        if (!(await store.getTake(recordingId))) return
        const first = take.pieces[0]
        await store.patchTake(recordingId, {
          // The anchors aren't kept: after a reload the clock maps that fitted them are gone. The pieces are the fit.
          clock: { anchors: [], fit: first?.fit ?? null },
          placement: first
            ? {
                start: placeTake(first.fit, first.offsetSamples, 0),
                offsetSamples: first.offsetSamples,
                pieces: take.pieces,
              }
            : null,
        })
      },
      upload: {
        recording: (id) => uploadRef.current.recording(id),
        finish: (rec) =>
          uploadRef.current.finish({
            ...rec,
            stop: async () => {
              const t = await rec.stop()
              taken.current.set(t.recordingId, t)
              setFinalized((n) => n + 1)
              return t
            },
          }),
        reset: () => uploadRef.current.reset(),
      },
      release(ctx) {
        clocks.get(ctx)?.stop()
        clocks.delete(ctx)
        setAudio((a) => (a?.ctx === ctx ? null : a))
        void ctx.close().catch(() => undefined)
        clock.current = null
        setLevel(0)
      },
      log,
    }
    const f = createRecordFlow(parts, setSnap)
    flowRef.current = f
    return f
  })
  useEffect(() => () => flow.dispose(), [flow])

  const s = snap ?? flow.get()
  const phase = s.phase
  const running = isRunning(phase)

  // The picture clock's own stops (seek, stall, hidden tab, devices, residual...) end the take.
  const { onStop } = picture
  useEffect(() => onStop((r) => flow.stopped(r)), [onStop, flow])
  useEffect(() => {
    flow.uploadChanged(upload.state, upload.error, upload.recordingId)
  }, [flow, upload.state, upload.error, upload.recordingId])
  useEffect(() => {
    if (phase !== 'recording') return
    const t = setInterval(() => void flow.checkpoint(), CHECKPOINT_MS)
    return () => clearInterval(t)
  }, [flow, phase])

  // Space stops and keeps, Esc discards; in review, Enter adds and Esc discards (not while typing in a field).
  useEffect(() => {
    if (phase !== 'countdown' && phase !== 'recording' && phase !== 'review') return
    const onKey = (e: KeyboardEvent) => {
      if (isTextField(e.target)) return
      const act = flowKey(phase, e.key)
      if (!act) return
      e.preventDefault()
      e.stopPropagation()
      if (e.type !== 'keydown' || e.repeat) return
      if (act === 'stop') flow.stop()
      else if (act === 'add') flow.add()
      else if (phase === 'review') flow.reject()
      else void flow.discard()
    }
    window.addEventListener('keydown', onKey, true)
    // A focused button would otherwise click on Space's keyup.
    window.addEventListener('keyup', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKey, true)
    }
  }, [flow, phase])

  /** Composition second the next take starts at (0, or its punch point): the prompter's line during the countdown. */
  const startsAt = useRef(0)
  const onRecord = (punch: Punch | null = null) => {
    startsAt.current = punch ? punch.from / SAMPLE_RATE : 0
    prompterPhase.current = 'countdown'
    // The setup's Original audio goes on the track the take is recorded for.
    const t = setupToTrackPatch(setupRef.current)
    latest.current.api.setTracks({
      aiVoice: t.aiVoice,
      original: t.original,
    } satisfies Partial<NarrationTracks>)
    ;(document.activeElement as HTMLElement | null)?.blur()
    setMonitorFrom(punch ? Math.max(0, punch.from / SAMPLE_RATE - preRoll) : 0)
    void flow.record(punch, preRoll)
  }
  const openPanel = () => {
    if (rate === null) setRate(deviceRate())
    flow.open()
  }

  const busyUpload =
    upload.state === 'uploading' || upload.state === 'processing' || upload.state === 'saving'
  const canStart = canRecord(phase) && api.canRecord && !!userId && !busyUpload
  const punch = punchAt(api.playhead, api.range)

  // R punches in at the playhead (or over the ruler's range), opening the panel if it's closed; not in text fields.
  const onPunchKey = useRef<() => void>(() => undefined)
  onPunchKey.current = () => {
    if (!api.canRecord || !userId || busyUpload || running) return
    if (!s.open) openPanel()
    if (!canRecord(flow.get().phase)) return
    onRecord(punch)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || isTextField(e.target) || !isPunchKey(e)) return
      e.preventDefault()
      onPunchKey.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const listener = useMemo(() => setupClapListener(() => setupRef.current), [])
  const route: AudioRoute | null = useMemo(
    () =>
      rate === null
        ? null
        : { inputDeviceId: setup.deviceId ?? 'default', outputDeviceId: 'default', sampleRate: rate },
    [setup.deviceId, rate],
  )
  const onOffsets = useCallback((o: CalibrationOffsets) => {
    offsets.current = o
  }, [])
  // The phase as the prompter's poll sees it: set in the Record click too, before the flow's own snapshot arrives.
  const prompterPhase = useRef(phase)
  prompterPhase.current = phase
  const getTime = useCallback(
    () =>
      prompterTime(prompterPhase.current, {
        startsAt: startsAt.current,
        pictureClock: pictureTime(pictureRef.current.anchors, performance.now()),
        videoTime: videoRef.current?.currentTime ?? null,
      }),
    [],
  )

  // The review's narration: the op with the take inserted as Add would, the take heard from its local WAV.
  const review = s.review
  const reviewTake = review ? taken.current.get(review.recordingId) : undefined
  const reviewTakeSamples = useMemo(
    () =>
      review && reviewTake
        ? new Map([...api.takeSamples, [reviewMediaId(review.recordingId), reviewTake.samples]])
        : api.takeSamples,
    [review, reviewTake, api.takeSamples],
  )
  const reviewNarration = useMemo(
    () =>
      review && reviewTake
        ? reviewOp(
            api.op,
            { mediaId: reviewMediaId(review.recordingId), samples: reviewTake.samples },
            clampToTake(review.pieces, reviewTake.samples),
            { fps: FPS, takeSamples: api.takeSamples, keepTakes: !!review.punch && !review.joined },
          )
        : null,
    // finalized: the take's WAV arrived (taken is a ref).
    [review, reviewTake, api.op, api.takeSamples, finalized],
  )
  const loadReviewTake = useCallback(async (mediaId: string) => {
    for (const [id, t] of taken.current) if (reviewMediaId(id) === mediaId) return t.wav.arrayBuffer()
    return signedTakeLoader(mediaId)
  }, [])
  const uploadNote =
    upload.state === 'uploading'
      ? `Uploading it${upload.progress?.total ? ` (${Math.round((upload.progress.sent / upload.progress.total) * 100)}%)` : ''}…`
      : upload.state === 'finalizing' || upload.state === 'processing'
        ? 'Uploading it…'
        : null
  const pictureEnd = video && Number.isFinite(video.duration) ? video.duration : null

  const status = statusText(s, upload.state, upload.progress)
  const recoverable = recovery.takes.filter((t) => t.id !== s.recordingId)

  return (
    <Stack gap="sm" data-testid="narration-recorder">
      {running || busyUpload ? null : (
        <RecoveryPrompt
          takes={recoverable}
          onRecover={async (t) => {
            const r = await recovery.recover(t.id)
            taken.current.set(r.take.recordingId, r.take)
            void upload.upload(r.take, r.record)
          }}
          onDiscard={(t) => recovery.discard(t.id)}
        />
      )}
      {!s.open ? (
        <Group gap="sm">
          <Button
            size="xs"
            leftSection={<IconMicrophone size={14} />}
            disabled={!api.canRecord || !userId}
            onClick={openPanel}
            data-testid="record-open"
          >
            Record voice-over
          </Button>
          {!api.canRecord ? (
            <Text size="xs" c="var(--va-faint)">
              Recording needs the narration lock.
            </Text>
          ) : null}
        </Group>
      ) : (
        <Card withBorder padding="sm" data-testid="record-panel">
          <Stack gap="sm">
            <Group justify="space-between" gap="sm">
              <Text fw={600}>Record a take</Text>
              <Button
                size="compact-xs"
                variant="subtle"
                color="gray"
                leftSection={<IconX size={12} />}
                disabled={running || phase === 'review' || phase === 'adding'}
                onClick={() => flow.close()}
              >
                Close
              </Button>
            </Group>
            <PrompterLayout
              picture={
                <div style={{ position: 'relative' }}>
                  <video
                    ref={setVideo}
                    src={fileUrl(videoId, versionN, 'video')}
                    muted
                    playsInline
                    preload="auto"
                    data-testid="record-picture"
                    style={{ display: 'block', width: '100%', background: '#000', borderRadius: 6 }}
                  />
                  {phase === 'countdown' && s.count !== null ? (
                    <div
                      data-testid="record-countdown"
                      aria-live="assertive"
                      style={{
                        position: 'absolute',
                        inset: 0,
                        display: 'grid',
                        placeItems: 'center',
                        fontSize: 96,
                        fontWeight: 700,
                        color: '#fff',
                        background: 'rgba(0, 0, 0, 0.45)',
                        borderRadius: 6,
                      }}
                    >
                      {s.count}
                    </div>
                  ) : null}
                </div>
              }
              prompter={<Teleprompter composition={api.html ?? ''} getTime={getTime} />}
            />
            {review && (phase === 'review' || phase === 'adding') ? (
              <TakeReview
                review={review}
                video={video}
                op={reviewNarration}
                takeSamples={reviewTakeSamples}
                takeSpans={api.takeSpans}
                loadTake={loadReviewTake}
                stopNotice={review.early ? s.notice : null}
                uploadNote={uploadNote}
                canRestart={upload.state === 'saving' && upload.recordingId === review.recordingId}
                pictureEnd={pictureEnd}
                adding={phase === 'adding'}
                onAdd={() => flow.add()}
                onAgain={() => {
                  ;(document.activeElement as HTMLElement | null)?.blur()
                  startsAt.current = review.punch ? review.punch.from / SAMPLE_RATE : 0
                  prompterPhase.current = 'countdown'
                  if (review.punch) setMonitorFrom(Math.max(0, review.punch.from / SAMPLE_RATE - preRoll))
                  flow.recordAgain(preRoll)
                }}
                onContinue={() => {
                  ;(document.activeElement as HTMLElement | null)?.blur()
                  startsAt.current = takeEnd(review.pieces) / SAMPLE_RATE
                  prompterPhase.current = 'countdown'
                  setMonitorFrom(0)
                  flow.keepRecording(preRoll)
                }}
                onDiscard={() => flow.reject()}
                download={
                  reviewTake ? (
                    <TakeDownload
                      base={takeBaseName(
                        videoTitle,
                        versionN,
                        takeNumber(
                          api.op.clips.map((c) => c.mediaId),
                          reviewMediaId(review.recordingId),
                        ),
                      )}
                      ext="wav"
                      load={async () => reviewTake.wav}
                      testId="review-download"
                    />
                  ) : null
                }
              />
            ) : (
              <Group gap="sm" align="center">
                {phase === 'countdown' || phase === 'recording' ? (
                  <>
                    <Button
                      size="xs"
                      color="red"
                      leftSection={<IconPlayerStopFilled size={14} />}
                      onClick={() => flow.stop()}
                      data-testid="record-stop"
                    >
                      Stop (Space)
                    </Button>
                    <Button size="xs" variant="default" onClick={() => void flow.discard()}>
                      Discard (Esc)
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      size="xs"
                      color="red"
                      leftSection={<IconPlayerRecordFilled size={14} />}
                      disabled={!canStart}
                      onClick={() => onRecord()}
                      data-testid="record-start"
                    >
                      Record
                    </Button>
                    <Button
                      size="xs"
                      variant="default"
                      leftSection={<IconArrowBarToRight size={14} />}
                      disabled={!canStart}
                      onClick={() => onRecord(punch)}
                      data-testid="record-punch"
                      data-from={punch.from}
                      data-to={punch.to ?? ''}
                    >
                      Punch in {punchText(punch)} (R)
                    </Button>
                    <NumberInput
                      size="xs"
                      w={110}
                      label="Pre-roll (s)"
                      min={0}
                      max={MAX_PRE_ROLL_SEC}
                      step={0.5}
                      decimalScale={1}
                      clampBehavior="strict"
                      value={preRoll}
                      onChange={(v) => {
                        // A half-typed value ('' or '1.') waits for the next keystroke.
                        if (typeof v !== 'number') return
                        const next = clampPreRoll(v)
                        setPreRoll(next)
                        storePreRoll(next)
                      }}
                      data-testid="punch-preroll"
                    />
                  </>
                )}
                {phase === 'recording' ? (
                  <Progress
                    w={120}
                    size="sm"
                    value={Math.min(100, level * 100)}
                    color={level >= 0.99 ? 'red' : 'teal'}
                    aria-label="Input level"
                  />
                ) : null}
              </Group>
            )}
            <Text size="sm" data-testid="record-status" data-phase={phase} aria-live="polite">
              {status}
            </Text>
            {s.notice && phase !== 'review' && phase !== 'adding' ? (
              <Alert
                color="yellow"
                variant="light"
                data-testid="record-notice"
                data-kind={s.stop?.kind ?? ''}
              >
                {s.notice}
              </Alert>
            ) : null}
            {(phase === 'failed' || phase === 'review') && s.error ? (
              <Group gap="xs">
                <Text size="sm" c="red" role="alert">
                  {s.error}
                </Text>
                {upload.state === 'failed' ? (
                  <Button size="compact-xs" variant="default" onClick={() => void upload.retry()}>
                    Retry
                  </Button>
                ) : null}
              </Group>
            ) : null}
            <RecordingSetup
              value={setup}
              onChange={(v) => setSetup(v)}
              locked={running}
              onUploadInstead={() => {
                flow.close()
                api.openUpload()
              }}
              calibrationSlot={
                route ? (
                  <CalibrationPanel route={route} listener={running ? null : listener} onChange={onOffsets} />
                ) : null
              }
            />
          </Stack>
        </Card>
      )}
      {!s.open && (busyUpload || phase === 'saved' || phase === 'failed') ? (
        <Group gap="xs">
          <Text size="sm" data-testid="record-status" data-phase={phase}>
            {phase === 'failed' ? s.error : status}
          </Text>
          {phase === 'failed' && upload.state === 'failed' ? (
            <Button size="compact-xs" variant="default" onClick={() => void upload.retry()}>
              Retry
            </Button>
          ) : null}
        </Group>
      ) : null}
    </Stack>
  )
}

function statusText(
  s: FlowSnapshot,
  upload: string,
  progress: { sent: number; total: number } | null,
): string {
  switch (s.phase) {
    case 'idle':
    case 'setup':
      return 'Record starts a 3-2-1 countdown, then the video plays from the start. Space stops and keeps the take; Esc discards it. To redo part of it, select a range on the ruler (or put the playhead there) and punch in.'
    case 'countdown':
      return s.count === null
        ? 'Starting the video…'
        : `${s.punch ? `Punching in ${punchText(s.punch)}` : 'Recording'} in ${s.count}…`
    case 'recording':
      return s.punch
        ? `Punching in ${punchText(s.punch)}: your narration there is muted from the punch point. Space stops and keeps the take; Esc discards it.`
        : 'Recording. Space stops and keeps the take; Esc discards it.'
    case 'stopping':
      return 'Finishing the take…'
    case 'review':
      return 'Play the take with the picture, then add it to the timeline, record it again or discard it. Enter adds; Esc discards.'
    case 'adding':
      return upload === 'saving'
        ? 'Adding the take to the Narration track…'
        : 'Adding the take once it has uploaded…'
    case 'uploading':
      return upload === 'uploading'
        ? `Uploading the take${progress?.total ? ` (${Math.round((progress.sent / progress.total) * 100)}%)` : ''}…`
        : upload === 'processing'
          ? 'Checking the take…'
          : 'Saving the draft…'
    case 'saved':
      return 'Saved: the take is on the Narration track.'
    case 'failed':
      return "The take didn't make it to the track."
  }
}
