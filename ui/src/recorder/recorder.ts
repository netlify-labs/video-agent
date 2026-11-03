// The browser recorder (plan 2026-11-02 §5.1): mic -> MediaStreamAudioSourceNode -> AudioWorkletNode('va-recorder')
// (worklet.ts, silent output) -> transferable Float32 blocks with their context frame -> a module Worker (worker.ts)
// that resamples to 24 kHz PCM16, streams the PCM hash, builds peaks and speech spans, and writes every chunk to the
// recovery store (store.ts) from the first one. stop() resolves with the finalized WAV, its file hash, peaks and
// speech, so the uploader never reads the file whole. The mic tracks are stopped on stop() and cancel().
//
// Mock builds only: window.__vaTestMic(context, constraints) can supply the input stream (Playwright: Chromium's fake
// capture device never resolves getUserMedia on the macOS agent host, S10), so everything from the source node on is
// real. It gets the audio constraints getUserMedia would have, and can throw to stand in for a denied mic.
import type { Span } from '../../../src/lib/timeline'
import type { DeviceRoute, TakeRecord } from './store'
import { recoveryStore } from './store'
import type { FinalTake, TakeProgress } from './take-writer'
import type { WorkerInit } from './worker'
// Vite builds the worklet like a worker (transpiled and bundled into one file) and gives its URL. `new URL('./x.ts',
// import.meta.url)` would copy the TypeScript as an asset, which addModule can't run.
import workletUrl from './worklet.ts?worker&url'

export interface Level {
  /** Linear RMS and peak of about the last 2048 frames (43 ms at 48 kHz). */
  rms: number
  peak: number
}

export interface RecorderOptions {
  /** The chosen input; omitted for the default device. */
  deviceId?: string
  /** On in speakers mode (§2.1), off with headphones. */
  echoCancellation: boolean
  /** The context to record in: the record flow's, shared with the monitor mix. One is made (and closed) otherwise. */
  context?: AudioContext
  /** Who and what the take is for; without it the take is kept in memory only and can't be recovered. */
  owner?: { userId: string; draftId: string | null; expectedRev: number | null; scopeJobId: string | null }
  onLevel?: (l: Level) => void
  /** Every worklet block as it is captured: its first context frame and length (for the sync clock, §5.3). */
  onBlock?: (b: { frame: number; length: number }) => void
  onProgress?: (p: TakeProgress) => void
  /** The take stopped itself ('quota', 'storage'): stop() resolves with what was saved. */
  onInterrupted?: (reason: string) => void
}

export interface RecordedTake {
  recordingId: string
  wav: Blob
  /** SHA-256 of the WAV file. */
  sha256: string
  /** 24 kHz samples. */
  samples: number
  peaks: Uint8Array
  speech: Span[]
  /** Context time of the take's first sample. */
  firstSampleContextTime: number
  stopReason: string | null
  /** false when the take couldn't be written to IndexedDB (no recovery copy). */
  persisted: boolean
}

export interface Recorder {
  recordingId: string
  context: AudioContext
  stream: MediaStream
  route: DeviceRoute
  /** Starts capture at `atContextTime` (exactly, when it's in the future) or at once. */
  start(atContextTime?: number): void
  /** Resolves with the take's first context frame once the worklet has captured it. */
  readonly started: Promise<number>
  stop(): Promise<RecordedTake>
  /** Drops the take (and its recovery copy) and releases the mic. */
  cancel(): Promise<void>
}

declare global {
  interface Window {
    /** Mock builds only: a stand-in mic for Playwright. */
    __vaTestMic?: (context: AudioContext, audio: MediaTrackConstraints) => MediaStream | Promise<MediaStream>
  }
}

const loaded = new WeakSet<BaseAudioContext>()
async function loadWorklet(ctx: AudioContext) {
  if (loaded.has(ctx)) return
  await ctx.audioWorklet.addModule(workletUrl)
  loaded.add(ctx)
}

/** The mic constraints for a take (§5.1); the setup panel's meter opens the same ones. */
export function micConstraints(
  o: Pick<RecorderOptions, 'deviceId' | 'echoCancellation'>,
): MediaTrackConstraints {
  return {
    ...(o.deviceId ? { deviceId: { exact: o.deviceId } } : {}),
    channelCount: 1,
    echoCancellation: o.echoCancellation,
    noiseSuppression: false,
    autoGainControl: false,
  }
}

export async function micStream(
  ctx: AudioContext,
  o: Pick<RecorderOptions, 'deviceId' | 'echoCancellation'>,
): Promise<MediaStream> {
  const audio = micConstraints(o)
  if (import.meta.env.VITE_MOCK && window.__vaTestMic) return window.__vaTestMic(ctx, audio)
  return navigator.mediaDevices.getUserMedia({ audio })
}

type FromWorker =
  | { type: 'ready'; persisted: boolean }
  | { type: 'progress'; samples: number; chunks: number }
  | { type: 'interrupted'; reason: string }
  | { type: 'done'; take: FinalTake }
  | { type: 'error'; error: string }
type FromWorklet =
  | { type: 'started'; frame: number }
  | { type: 'level'; rms: number; peak: number }
  | { type: 'block'; frame: number; length: number }
  | { type: 'end' }

/** Opens the mic and the capture chain; resolves once the worker is ready, before anything is recorded. */
export async function createRecorder(o: RecorderOptions): Promise<Recorder> {
  const ownsContext = !o.context
  const ctx = o.context ?? new AudioContext({ latencyHint: 'interactive' })
  let stream: MediaStream | null = null
  let worker: Worker | null = null
  const release = () => {
    for (const t of stream?.getTracks() ?? []) t.stop()
    worker?.terminate()
    if (ownsContext) void ctx.close().catch(() => undefined)
  }
  try {
    stream = await micStream(ctx, o)
    await loadWorklet(ctx)
  } catch (e) {
    release()
    throw e
  }
  const track = stream.getAudioTracks()[0]
  if (!track) {
    release()
    throw new Error('The microphone gave no audio track.')
  }
  const settings = track.getSettings()
  const sinkId = (ctx as AudioContext & { sinkId?: unknown }).sinkId
  const route: DeviceRoute = {
    inputDeviceId: settings.deviceId ?? o.deviceId ?? '',
    inputLabel: track.label,
    groupId: settings.groupId ?? '',
    outputDeviceId: typeof sinkId === 'string' ? sinkId : null,
    sampleRate: ctx.sampleRate,
    echoCancellation: o.echoCancellation,
  }
  const recordingId = crypto.randomUUID()
  const now = Date.now()
  const record: TakeRecord = {
    id: recordingId,
    userId: o.owner?.userId ?? '',
    draftId: o.owner?.draftId ?? null,
    expectedRev: o.owner?.expectedRev ?? null,
    scopeJobId: o.owner?.scopeJobId ?? null,
    status: 'recording',
    createdAt: now,
    updatedAt: now,
    ctxRate: ctx.sampleRate,
    startFrame: -1,
    samples: 0,
    chunks: 0,
    pcmSha256: '',
    fileSha256: null,
    route,
    clock: null,
    placement: null,
    upload: { state: 'pending', mediaId: null, error: null },
    stopReason: null,
  }

  const src = ctx.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(ctx, 'va-recorder', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
  })
  const silent = ctx.createGain()
  silent.gain.value = 0
  src.connect(node)
  node.connect(silent).connect(ctx.destination)

  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  const w = worker
  let persisted = false
  let resolveDone: (t: FinalTake) => void = () => undefined
  let rejectDone: (e: Error) => void = () => undefined
  const done = new Promise<FinalTake>((res, rej) => {
    resolveDone = res
    rejectDone = rej
  })
  let resolveStarted: (frame: number) => void = () => undefined
  const started = new Promise<number>((res) => {
    resolveStarted = res
  })
  let isStarted = false
  let finished = false
  const stopWorklet = () => {
    node.port.postMessage({ type: 'stop' })
  }
  const ready = new Promise<void>((res, rej) => {
    w.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data
      if (m.type === 'ready') {
        persisted = m.persisted
        res()
      } else if (m.type === 'progress') o.onProgress?.({ samples: m.samples, chunks: m.chunks })
      else if (m.type === 'interrupted') {
        stopWorklet()
        o.onInterrupted?.(m.reason)
      } else if (m.type === 'done') resolveDone(m.take)
      else {
        const err = new Error(m.error)
        rej(err)
        rejectDone(err)
      }
    }
    w.onerror = (e) => {
      const err = new Error(e.message || 'The recorder worker failed.')
      rej(err)
      rejectDone(err)
    }
  })
  node.port.onmessage = (e: MessageEvent<FromWorklet>) => {
    const m = e.data
    if (m.type === 'started') resolveStarted(m.frame)
    else if (m.type === 'level') o.onLevel?.({ rms: m.rms, peak: m.peak })
    else if (m.type === 'block') o.onBlock?.({ frame: m.frame, length: m.length })
  }
  node.port.postMessage({ type: 'observe', levels: !!o.onLevel, blocks: !!o.onBlock })
  const ch = new MessageChannel()
  node.port.postMessage({ type: 'port', port: ch.port1 }, [ch.port1])
  const init: WorkerInit = { type: 'init', record, port: ch.port2, persist: !!o.owner }
  w.postMessage(init, [ch.port2])

  const teardown = () => {
    finished = true
    src.disconnect()
    node.disconnect()
    silent.disconnect()
    release()
  }
  try {
    await ready
  } catch (e) {
    teardown()
    throw e
  }
  const cancel = async () => {
    if (finished) return
    teardown()
    if (persisted) await (await recoveryStore()).deleteTake(recordingId)
  }

  return {
    recordingId,
    context: ctx,
    stream,
    route,
    started,
    start(atContextTime) {
      if (isStarted || finished) return
      isStarted = true
      const atFrame = atContextTime === undefined ? 0 : Math.round(atContextTime * ctx.sampleRate)
      node.port.postMessage({ type: 'start', atFrame })
    },
    async stop() {
      if (finished) throw new Error('This take has already stopped.')
      if (!isStarted) {
        await cancel()
        throw new Error('Nothing was recorded.')
      }
      stopWorklet()
      try {
        const t = await done
        return {
          recordingId,
          wav: t.wav,
          sha256: t.sha256,
          samples: t.samples,
          peaks: t.peaks,
          speech: t.speech,
          firstSampleContextTime: t.startFrame / t.ctxRate,
          stopReason: t.stopReason,
          persisted,
        }
      } finally {
        teardown()
      }
    },
    cancel,
  }
}
