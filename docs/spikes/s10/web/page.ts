// Spike S10: the instrumented page (plan §5.1, §5.3, §5.4). Everything is exposed on window.__s10 for Playwright.
//
// Clocks. Three maps, all on this document's performance.now():
//   picture  rVFC (mediaTime, expectedDisplayTime): composition time m is on screen at perf E.
//   render   (ctx.currentTime, performance.now()) at the first observation of each new currentTime: when the audio
//            thread rendered/captured context time ct. Input samples are mapped through THIS map.
//   output   ctx.getOutputTimestamp() (contextTime, performanceTime): when context time ct is HEARD. The monitor is
//            scheduled through this map. Never with outputLatency added on top (it already includes it). Without
//            getOutputTimestamp the fallback is render + (baseLatency + outputLatency), labelled as such.
// Fit: each anchor gives (take sample x, composition time m), x from E through the render map. t = a + b·x by least
// squares (b ≈ 1/24000). Placement then subtracts the input-latency calibration L (mic hears at perf P, the worklet
// sees it at render-map perf P + L), which is route-specific to the INPUT only, so (a) can be measured once on
// speakers and reused with headphones, while the monitor's output latency comes from getOutputTimestamp.
import { computePeaks, decodePeaks } from '../../../../app/server/lib/peaks.js'
import {
  fitLine,
  mean,
  median,
  OnlineLine,
  residuals,
  robustMean,
  type Line,
  type RobustMean,
} from '../lib/fit.js'
import { detectOnsets } from '../lib/onsets.js'
import { pcm16ToFloat, wavHeader } from '../lib/wav.js'
import { all, chunksOf, clearAll, get, openDb, putMany, type TakeRecord } from './idb.js'

const OUT_RATE = 24_000
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const logEl = $('log')
function log(...a: unknown[]) {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  logEl.textContent = `${(performance.now() / 1000).toFixed(2)} ${line}\n${logEl.textContent ?? ''}`.slice(
    0,
    20_000,
  )
  console.log('[s10]', line)
}
const status = (s: string) => ($('status').textContent = s)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- media manifest

interface MediaInfo {
  video: string
  stem: string
  duration: number
  fps: number
  flashes: number[]
}
interface Manifest {
  media: Record<string, MediaInfo>
  fake: { firstBeep: number; period: number; duration: number }
}
let manifestP: Promise<Manifest> | null = null
const manifest = () =>
  (manifestP ??= fetch('/media/manifest.json').then((r) => r.json() as Promise<Manifest>))

// ---------------------------------------------------------------- engine + API matrix

type Engine = 'chromium' | 'firefox' | 'webkit' | 'unknown'
const engine = (): Engine => {
  const ua = navigator.userAgent
  if (/Firefox\//.test(ua)) return 'firefox'
  if (/Chrome\//.test(ua)) return 'chromium'
  if (/Safari\//.test(ua)) return 'webkit'
  return 'unknown'
}

interface PerfMemory {
  usedJSHeapSize: number
  totalJSHeapSize: number
}
type UaMemory = () => Promise<{ bytes: number }>
const perfMemory = () => (performance as unknown as { memory?: PerfMemory }).memory
const uaMemory = () =>
  (performance as unknown as { measureUserAgentSpecificMemory?: UaMemory }).measureUserAgentSpecificMemory

const MR_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm;codecs=pcm',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4;codecs=opus',
  'audio/mp4',
  'audio/wav',
]

async function apiMatrix() {
  const ctx = await ensureCtx()
  await sleep(400)
  const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null
  let moduleWorker = false
  try {
    const w = new Worker('/web/probe.js', { type: 'module' })
    moduleWorker = await new Promise<boolean>((r) => {
      w.onmessage = () => r(true)
      w.onerror = () => r(false)
      setTimeout(() => r(false), 2000)
    })
    w.terminate()
  } catch {
    moduleWorker = false
  }
  let est: StorageEstimate | null = null
  try {
    est = await navigator.storage.estimate()
  } catch {
    est = null
  }
  const m = {
    userAgent: navigator.userAgent,
    engine: engine(),
    requestVideoFrameCallback: 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
    getOutputTimestamp: typeof ctx.getOutputTimestamp === 'function',
    outputTimestampSample: ts ? { contextTime: ts.contextTime, performanceTime: ts.performanceTime } : null,
    outputLatency: 'outputLatency' in ctx ? ctx.outputLatency : null,
    baseLatency: 'baseLatency' in ctx ? ctx.baseLatency : null,
    sampleRate: ctx.sampleRate,
    contextState: ctx.state,
    audioWorklet:
      typeof AudioWorkletNode === 'function' && !!(ctx as { audioWorklet?: unknown }).audioWorklet,
    mediaRecorder: typeof MediaRecorder === 'function',
    mediaRecorderTypes: Object.fromEntries(
      MR_TYPES.map((t) => [t, typeof MediaRecorder === 'function' && MediaRecorder.isTypeSupported(t)]),
    ),
    measureUserAgentSpecificMemory: typeof uaMemory() === 'function',
    crossOriginIsolated: self.crossOriginIsolated,
    performanceMemory: !!perfMemory(),
    setSinkId: 'setSinkId' in AudioContext.prototype,
    moduleWorker,
    indexedDB: typeof indexedDB === 'object',
    storageQuotaMB: est?.quota ? Math.round(est.quota / 2 ** 20) : null,
    supportedConstraints: navigator.mediaDevices.getSupportedConstraints() as Record<string, boolean>,
  }
  renderMatrix(m)
  return m
}

function renderMatrix(m: Record<string, unknown>) {
  const rows = Object.entries(m)
    .filter(([k]) => k !== 'supportedConstraints')
    .map(
      ([k, v]) =>
        `<tr><th>${k}</th><td>${escapeHtml(typeof v === 'object' ? JSON.stringify(v) : String(v))}</td></tr>`,
    )
  $('matrix').innerHTML =
    `<h3>API matrix (${String(m.engine)})</h3><table id="matrixTable">${rows.join('')}</table>`
}
const escapeHtml = (s: string) =>
  s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c)

// ---------------------------------------------------------------- audio context + clocks

let ctxP: Promise<AudioContext> | null = null
let clock: Clock | null = null
function ensureCtx(): Promise<AudioContext> {
  ctxP ??= (async () => {
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    await ctx.audioWorklet.addModule('/web/worklet.js')
    if (ctx.state !== 'running') await Promise.race([ctx.resume(), sleep(1500)])
    clock = new Clock(ctx)
    return ctx
  })()
  return ctxP
}

interface Pair {
  ct: number
  pt: number
}

class Clock {
  render = new OnlineLine()
  out = new OnlineLine()
  renderPairs: Pair[] = []
  outPairs: Pair[] = []
  private lastCt = -1
  private lastOutCt = -1
  private timer: ReturnType<typeof setInterval>
  outSource: 'getOutputTimestamp' | 'fallback-render+latency' = 'fallback-render+latency'

  constructor(readonly ctx: AudioContext) {
    this.timer = setInterval(() => this.sample(), 5)
    const loop = () => {
      this.sample()
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  }

  reset() {
    this.render = new OnlineLine()
    this.out = new OnlineLine()
    this.renderPairs = []
    this.outPairs = []
  }

  sample() {
    const now = performance.now()
    const ct = this.ctx.currentTime
    if (ct !== this.lastCt && ct > 0) {
      this.lastCt = ct
      this.render.add(ct, now)
      // every 10th pair is kept for the report and residuals; the fit itself uses all of them
      if (this.render.count % 10 === 1) this.renderPairs.push({ ct, pt: now })
    }
    const ts = typeof this.ctx.getOutputTimestamp === 'function' ? this.ctx.getOutputTimestamp() : null
    if (
      ts?.performanceTime &&
      ts.contextTime &&
      ts.performanceTime > 0 &&
      ts.contextTime !== this.lastOutCt
    ) {
      this.lastOutCt = ts.contextTime
      this.out.add(ts.contextTime, ts.performanceTime)
      if (this.out.count % 10 === 1) this.outPairs.push({ ct: ts.contextTime, pt: ts.performanceTime })
      this.outSource = 'getOutputTimestamp'
    }
  }

  renderLine(): Line {
    return this.render.line() ?? { a: performance.now() - this.ctx.currentTime * 1000, b: 1000, n: 0 }
  }
  outLine(): Line {
    const o = this.out.line()
    if (o && o.n > 20) return o
    const r = this.renderLine()
    const lat =
      ((this.ctx.baseLatency || 0) + ((this.ctx as { outputLatency?: number }).outputLatency ?? 0)) * 1000
    return { a: r.a + lat, b: r.b, n: 0 }
  }
  ctToPerfRender = (ct: number) => {
    const l = this.renderLine()
    return l.a + l.b * ct
  }
  perfToCtRender = (p: number) => {
    const l = this.renderLine()
    return (p - l.a) / l.b
  }
  ctToPerfOut = (ct: number) => {
    const l = this.outLine()
    return l.a + l.b * ct
  }
  perfToCtOut = (p: number) => {
    const l = this.outLine()
    return (p - l.a) / l.b
  }

  stop() {
    clearInterval(this.timer)
  }
}

// ---------------------------------------------------------------- capture pipeline (worklet -> worker)

interface DoneMsg {
  type: 'done'
  takeId: string
  startFrame: number
  ctxRate: number
  inFrames: number
  worklet: { frames: number; gaps: { at: number; missing: number }[]; noInput: number; blocks: number }
  padded: number
  samples: number
  expectedSamples: number
  chunks: number
  pcmSha256: string
  fileSha256: string | null
  fileHashMs: number
  flushMs: number
  peaks: { levels: { samplesPerBin: number; bins: number }[]; bytes: Uint8Array }
  onsets: { sample: number; peak: number }[]
  idb: Record<string, unknown>
}

interface Capture {
  takeId: string
  stream: MediaStream
  track: MediaStreamTrack
  settings: MediaTrackSettings
  startFrame: Promise<number>
  liveOnsets: number[]
  progress: { samples: number; chunks: number }
  stop(): Promise<DoneMsg>
}

interface CaptureOpts {
  mic: 'device' | 'synthetic'
  ec: boolean
  ns: boolean
  agc: boolean
  deviceId: string
  persist: boolean
  meta?: unknown
}

/**
 * mic 'synthetic' (automation only): media/fake-mic.wav looped through a MediaStreamAudioDestinationNode, so the
 * capture path from MediaStreamAudioSourceNode on (and MediaRecorder) is the same as with a device. Used because
 * Chromium's --use-fake-device-for-media-stream getUserMedia never resolves on the macOS agent host (the browser log
 * shows the fake device opened; the renderer promise hangs). mic 'device' is the real path.
 */
async function micStream(
  ctx: AudioContext,
  o: CaptureOpts,
): Promise<{ stream: MediaStream; stopSource: () => void }> {
  if (o.mic === 'synthetic') {
    const buf = await ctx.decodeAudioData(await (await fetch('/media/fake-mic.wav')).arrayBuffer())
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = true
    const dest = ctx.createMediaStreamDestination()
    dest.channelCount = 1
    src.connect(dest)
    src.start()
    return { stream: dest.stream, stopSource: () => src.stop() }
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(o.deviceId ? { deviceId: { exact: o.deviceId } } : {}),
      channelCount: 1,
      echoCancellation: o.ec,
      noiseSuppression: o.ns,
      autoGainControl: o.agc,
    },
  })
  return { stream, stopSource: () => undefined }
}

async function startCapture(ctx: AudioContext, o: CaptureOpts): Promise<Capture> {
  const { stream, stopSource } = await micStream(ctx, o)
  const track = stream.getAudioTracks()[0]
  if (!track) throw new Error('no audio track')
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
  const worker = new Worker('/web/worker.js', { type: 'module' })
  const ch = new MessageChannel()
  const takeId = `take-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`
  const liveOnsets: number[] = []
  const progress = { samples: 0, chunks: 0 }
  let resolveDone: (d: DoneMsg) => void = () => undefined
  let rejectDone: (e: Error) => void = () => undefined
  const doneP = new Promise<DoneMsg>((res, rej) => {
    resolveDone = res
    rejectDone = rej
  })
  const ready = new Promise<void>((res) => {
    worker.onmessage = (e: MessageEvent<{ type: string; [k: string]: unknown }>) => {
      const m = e.data
      if (m.type === 'ready') res()
      else if (m.type === 'progress') {
        progress.samples = m.samples as number
        progress.chunks = m.chunks as number
        liveOnsets.push(...(m.onsets as number[]))
      } else if (m.type === 'done') resolveDone(m as unknown as DoneMsg)
      else if (m.type === 'error') rejectDone(new Error(String(m.error)))
    }
  })
  worker.onerror = (e) => rejectDone(new Error(e.message))
  node.port.postMessage({ type: 'port', port: ch.port1 }, [ch.port1])
  worker.postMessage(
    { type: 'init', takeId, ctxRate: ctx.sampleRate, port: ch.port2, persist: o.persist, meta: o.meta },
    [ch.port2],
  )
  await ready
  const startFrame = new Promise<number>((res) => {
    node.port.onmessage = (e: MessageEvent<{ type: string; frame?: number }>) => {
      if (e.data.type === 'started') res(e.data.frame ?? 0)
    }
  })
  node.port.postMessage({ type: 'start' })
  return {
    takeId,
    stream,
    track,
    settings: track.getSettings(),
    startFrame,
    liveOnsets,
    progress,
    async stop() {
      node.port.postMessage({ type: 'stop' })
      const d = await doneP
      src.disconnect()
      node.disconnect()
      for (const t of stream.getTracks()) t.stop()
      stopSource()
      worker.terminate()
      return d
    },
  }
}

// ---------------------------------------------------------------- picture

const video = $('video') as HTMLVideoElement
interface Anchor {
  m: number
  e: number
  now: number
  pf: number
}

async function loadVideo(info: MediaInfo) {
  const url = `/media/${info.video}`
  if (!video.src.endsWith(url)) {
    video.src = url
    await new Promise<void>((res, rej) => {
      video.onloadeddata = () => res()
      video.onerror = () => rej(new Error(`video: ${video.error?.message ?? 'error'}`))
    })
  }
  video.muted = true
  video.pause()
  video.currentTime = 0
  await new Promise((r) => setTimeout(r, 100))
}

const stems = new Map<string, Promise<AudioBuffer>>()
function stem(ctx: AudioContext, info: MediaInfo) {
  let p = stems.get(info.stem)
  if (!p) {
    p = fetch(`/media/${info.stem}`)
      .then((r) => r.arrayBuffer())
      .then((b) => ctx.decodeAudioData(b))
    stems.set(info.stem, p)
  }
  return p
}

// ---------------------------------------------------------------- the take

export interface TakeOpts {
  media: number
  mode: 'loopback' | 'headphones' | 'fake'
  mic: 'device' | 'synthetic'
  label: string
  ec: boolean
  ns: boolean
  agc: boolean
  deviceId: string
  thresholdMs: number
  /** Consecutive anchors over the threshold before the take stops. */
  residualRun: number
  slopePpm: number
  mediaRecorder: boolean
  persist: boolean
  monitor: boolean
  kind: 'take' | 'calib-b'
  /** Stop after this many seconds (default: the media's end). */
  maxSeconds?: number
  upload: boolean
}

let current: { stop: (reason: string) => void; track: MediaStreamTrack } | null = null
let lastReport: Record<string, unknown> | null = null

function defaults(): TakeOpts {
  return {
    media: 30,
    mode: ($('mode') as HTMLSelectElement).value as TakeOpts['mode'],
    mic: new URLSearchParams(location.search).get('mic') === 'synthetic' ? 'synthetic' : 'device',
    label: ($('label') as HTMLInputElement).value || `${engine()} / unlabelled`,
    ec: ($('ec') as HTMLInputElement).checked,
    ns: ($('ns') as HTMLInputElement).checked,
    agc: ($('agc') as HTMLInputElement).checked,
    deviceId: ($('device') as HTMLSelectElement).value,
    thresholdMs: Number(($('threshold') as HTMLInputElement).value) || 10,
    residualRun: 3,
    slopePpm: Number(($('slope') as HTMLInputElement).value) || 1000,
    mediaRecorder: ($('mr') as HTMLInputElement).checked,
    persist: true,
    monitor: true,
    kind: 'take',
    upload: true,
  }
}

async function runTake(partial: Partial<TakeOpts> = {}) {
  if (current) throw new Error('a take is running')
  const o: TakeOpts = { ...defaults(), ...partial }
  const mf = await manifest()
  const info = mf.media[String(o.media)]
  if (!info) throw new Error(`no media for ${o.media}s: run make-media.sh`)
  const ctx = await ensureCtx()
  const ck = clock
  if (!ck) throw new Error('no clock')
  status(`${o.kind}: preparing`)
  const [buffer] = await Promise.all([stem(ctx, info), loadVideo(info)])
  const mem: { t: number; heapMB: number | null; uaMB?: number | null }[] = []
  ck.reset()
  const cap = await startCapture(ctx, { ...o, meta: { label: o.label, media: o.media } })
  const t0 = performance.now()

  // MediaRecorder comparison on the same stream
  let mr: MrState | null = null
  if (o.mediaRecorder && typeof MediaRecorder === 'function') mr = startMr(cap.stream)

  const anchors: Anchor[] = []
  const online = new OnlineLine()
  const monitorErr: { m: number; errMs: number }[] = []
  const mon: { node: AudioBufferSourceNode | null; at: { ct: number; comp: number } | null } = {
    node: null,
    at: null,
  }
  let resyncs = 0
  let stopReason = ''
  let stopAt = 0
  let firstResidualBreach: { m: number; residualMs: number } | null = null
  const outliers: { m: number; residualMs: number }[] = []
  let breachRun = 0
  const startFrame = await cap.startFrame
  const sr = ctx.sampleRate
  const takeSample = (perf: number) => (ck.perfToCtRender(perf) * sr - startFrame) * (OUT_RATE / sr)

  let stopResolve: () => void = () => undefined
  const stopped = new Promise<void>((r) => (stopResolve = r))
  const stop = (reason: string) => {
    if (stopReason) return
    stopReason = reason
    stopAt = performance.now()
    log('stop:', reason)
    stopResolve()
  }
  current = { stop, track: cap.track }

  const schedule = () => {
    // picture position at perf P = P/1000 + median(m - E/1000) over the last 10 anchors (the first frames after
    // play() are presented late, so one early anchor biases the monitor by about a frame)
    const recent = anchors.slice(-10)
    if (!recent.length || !o.monitor) return
    mon.node?.stop()
    const lead = ctx.currentTime + 0.25
    const heard = ck.ctToPerfOut(lead)
    const comp = heard / 1000 + median(recent.map((x) => x.m - x.e / 1000))
    const n = ctx.createBufferSource()
    n.buffer = buffer
    n.connect(ctx.destination)
    n.start(lead, Math.max(0, comp))
    mon.node = n
    mon.at = { ct: lead, comp }
  }

  // stop conditions
  const onSeek = () => stop('seek')
  const onWaiting = () => stop('stall')
  const onEnded = () => stop('ended')
  const onHidden = () => {
    if (document.visibilityState === 'hidden') stop('hidden')
  }
  const onDevice = () => stop('devicechange')
  const onTrackEnded = () => stop('track-ended')
  video.addEventListener('seeking', onSeek)
  video.addEventListener('waiting', onWaiting)
  video.addEventListener('ended', onEnded)
  document.addEventListener('visibilitychange', onHidden)
  navigator.mediaDevices.addEventListener('devicechange', onDevice)
  cap.track.addEventListener('ended', onTrackEnded)

  const hasRvfc = 'requestVideoFrameCallback' in video
  const onFrame = (now: number, md: VideoFrameCallbackMetadata) => {
    if (stopReason) return
    ck.sample()
    const a = { m: md.mediaTime, e: md.expectedDisplayTime, now, pf: md.presentedFrames }
    anchors.push(a)
    if (anchors.length === 15) schedule()
    const x = takeSample(a.e)
    online.add(x, a.m)
    const line = online.line()
    if (line && online.count > 60) {
      const r = (a.m - (line.a + line.b * x)) * 1000
      // One late or repeated frame gives a single one-frame residual (seen in a 10-minute headless run), so the
      // take stops only when residualRun consecutive anchors breach; single outliers are counted.
      if (Math.abs(r) > o.thresholdMs) {
        outliers.push({ m: a.m, residualMs: r })
        if (++breachRun >= o.residualRun && !firstResidualBreach) {
          firstResidualBreach = { m: a.m, residualMs: r }
          stop('residual')
        }
      } else breachRun = 0
      const ppm = (line.b * OUT_RATE - 1) * 1e6
      if (online.count > 300 && Math.abs(ppm) > o.slopePpm) stop('slope')
    }
    if (mon.at) {
      const pos = mon.at.comp + (ck.perfToCtOut(a.e) - mon.at.ct)
      const err = (pos - a.m) * 1000
      monitorErr.push({ m: a.m, errMs: err })
      if (Math.abs(err) > 1000 / info.fps && anchors.length > 30) {
        resyncs++
        schedule()
      }
    }
    video.requestVideoFrameCallback(onFrame)
  }
  if (hasRvfc) video.requestVideoFrameCallback(onFrame)

  const watchdog = setInterval(() => {
    const last = anchors.at(-1)
    if (last && performance.now() - last.now > 300 && !video.paused) stop('stall')
    if (o.maxSeconds && video.currentTime >= o.maxSeconds) stop('max-seconds')
  }, 100)
  const memTimer = setInterval(() => {
    const pm = perfMemory()
    mem.push({ t: (performance.now() - t0) / 1000, heapMB: pm ? pm.usedJSHeapSize / 2 ** 20 : null })
  }, 5000)
  const uaTimer = setInterval(() => void sampleUa(mem, t0), 30_000)
  const clockTimer = setInterval(() => void saveClock(cap.takeId, anchors, online), 2000)

  status(`${o.kind}: recording (${cap.takeId})`)
  await video.play()
  if (!hasRvfc) log('no requestVideoFrameCallback: no anchors')
  await stopped

  // ---- stop -> flush -> hash
  clearInterval(watchdog)
  clearInterval(memTimer)
  clearInterval(uaTimer)
  clearInterval(clockTimer)
  video.pause()
  mon.node?.stop()
  video.removeEventListener('seeking', onSeek)
  video.removeEventListener('waiting', onWaiting)
  video.removeEventListener('ended', onEnded)
  document.removeEventListener('visibilitychange', onHidden)
  navigator.mediaDevices.removeEventListener('devicechange', onDevice)
  cap.track.removeEventListener('ended', onTrackEnded)
  const tStop = performance.now()
  const mrStopped = mr ? stopMr(mr) : null
  const done = await cap.stop()
  const tDone = performance.now()
  current = null
  status(`${o.kind}: analysing`)

  // ---- final fit with the final render map
  const xs = anchors.map((a) => takeSample(a.e))
  const ms = anchors.map((a) => a.m)
  const fit = fitLine(xs, ms)
  const res = fit ? residuals(fit, xs, ms) : null
  const rl = ck.renderLine()
  const rRes = residuals(
    rl,
    ck.renderPairs.map((p) => p.ct),
    ck.renderPairs.map((p) => p.pt),
  )
  const ol = ck.out.line()
  const impliedOut = ol ? mean(ck.outPairs.slice(-200).map((p) => p.pt - ck.ctToPerfRender(p.ct))) : null
  const overRuns: { fromM: number; toM: number; n: number; meanMs: number }[] = []
  if (fit) {
    let run: { fromM: number; toM: number; n: number; sum: number } | null = null
    xs.forEach((x, i) => {
      const m = ms[i] ?? 0
      const r = (m - (fit.a + fit.b * x)) * 1000
      if (Math.abs(r) > o.thresholdMs) {
        run ??= { fromM: m, toM: m, n: 0, sum: 0 }
        run.toM = m
        run.n++
        run.sum += r
      } else if (run) {
        overRuns.push({ fromM: run.fromM, toM: run.toM, n: run.n, meanMs: run.sum / run.n })
        run = null
      }
    })
    const last = run as { fromM: number; toM: number; n: number; sum: number } | null
    if (last) overRuns.push({ fromM: last.fromM, toM: last.toM, n: last.n, meanMs: last.sum / last.n })
  }
  const stopSample = takeSample(stopAt)
  const tAt = (s: number) => (fit ? fit.a + fit.b * s : NaN)

  const flashes = info.flashes
  const matched = done.onsets
    .map((on) => {
      const t = tAt(on.sample)
      const T = flashes.reduce((best, f) => (Math.abs(f - t) < Math.abs(best - t) ? f : best), Infinity)
      return { sample: on.sample, t, flash: T, errRawMs: (t - T) * 1000, peak: on.peak }
    })
    .filter((m) => Math.abs(m.errRawMs) < 500)

  const cal = calibrations(o.label)
  const groups = groupErrors(matched)
  const offsets: Record<string, number | null> = {
    raw: 0,
    a: cal.a?.ms ?? null,
    b: cal.b?.ms ?? null,
    c: cal.c,
  }
  const corrected = Object.fromEntries(
    Object.entries(offsets).map(([k, off]) => [
      k,
      off === null
        ? null
        : {
            start: groups.start - off,
            middle: groups.middle - off,
            end: groups.end - off,
            driftMs: groups.end - groups.start,
          },
    ]),
  )

  // fake mic: pipeline self-consistency (beeps every period s in the file)
  let fake: Record<string, unknown> | null = null
  if (o.mode === 'fake') {
    const period = mf.fake.period * OUT_RATE
    const iv = done.onsets.slice(1).map((on, i) => on.sample - (done.onsets[i]?.sample ?? 0))
    const good = iv.filter((d) => Math.abs(d - period) < 0.1 * period)
    const errs = good.map((d) => d - period)
    const ppm = good.length ? (mean(good) / period - 1) * 1e6 : null
    fake = {
      beepsDetected: done.onsets.length,
      intervals: iv.length,
      intervalsWithinTenPercent: good.length,
      intervalErrorSamples: {
        mean: mean(errs),
        median: median(errs),
        maxAbs: Math.max(0, ...errs.map(Math.abs)),
      },
      intervalErrorMs: {
        mean: (mean(errs) / OUT_RATE) * 1000,
        maxAbs: (Math.max(0, ...errs.map(Math.abs)) / OUT_RATE) * 1000,
      },
      rateErrorPpm: ppm,
      firstBeepSample: done.onsets[0]?.sample ?? null,
    }
  }

  // ---- verification + upload simulation
  const verify = o.persist ? await verifyTake(done) : null
  let upload: Record<string, unknown> | null = null
  if (o.persist && o.upload) {
    const u0 = performance.now()
    const blob = await assembleWav(done.takeId)
    const u1 = performance.now()
    const r = await fetch('/upload', { method: 'POST', body: blob })
    const j = (await r.json()) as { bytes: number; sha256: string; serverMs: number }
    const u2 = performance.now()
    upload = {
      bytes: j.bytes,
      serverSha256: j.sha256,
      matchesWorkerFileHash: j.sha256 === done.fileSha256,
      assembleMs: u1 - u0,
      uploadMs: u2 - u1,
      // stop -> worker done (flush, writes, file hash) -> assemble from IndexedDB -> POST; excludes the checks above
      stopToUploadedMs: tDone - tStop + (u2 - u0),
    }
    await markUploaded(done.takeId)
  }
  await sampleUa(mem, t0)
  const mrReport = mrStopped ? await analyseMr(ctx, await mrStopped, done, ck, startFrame) : null

  const report = {
    kind: o.kind,
    ts: new Date().toISOString(),
    setup: {
      label: o.label,
      engine: engine(),
      userAgent: navigator.userAgent,
      mode: o.mode,
      mic: o.mic,
      constraints: { echoCancellation: o.ec, noiseSuppression: o.ns, autoGainControl: o.agc },
      inputLabel: cap.track.label,
      trackSettings: cap.settings,
      sampleRate: ctx.sampleRate,
      baseLatency: ctx.baseLatency,
      outputLatency: (ctx as { outputLatency?: number }).outputLatency ?? null,
    },
    media: { seconds: info.duration, fps: info.fps, flashes: info.flashes.length },
    stop: {
      reason: stopReason,
      atSeconds: (stopAt - t0) / 1000,
      cleanSamples: Math.max(0, Math.min(done.samples, Math.floor(stopSample))),
      firstResidualBreach,
      residualRun: o.residualRun,
      singleOutliers: outliers.length,
      outliers: outliers.slice(0, 500),
    },
    capture: {
      takeId: done.takeId,
      samples: done.samples,
      expectedSamples: done.expectedSamples,
      samplesMatch: done.samples === done.expectedSamples,
      ctxFrames: done.inFrames,
      workletFrames: done.worklet.frames,
      workletGaps: done.worklet.gaps,
      noInputQuanta: done.worklet.noInput,
      paddedFrames: done.padded,
      chunks: done.chunks,
      pcmSha256: done.pcmSha256,
      fileSha256: done.fileSha256,
      idb: done.idb,
    },
    timings: {
      stopToDoneMs: tDone - tStop,
      flushAndWritesMs: done.flushMs,
      fileHashMs: done.fileHashMs,
      ...(verify ? { oneShotFileHashMs: verify.oneShotMs } : {}),
    },
    verify,
    upload,
    peaks: { levels: done.peaks.levels, check: verify?.peaks ?? null },
    fit: fit &&
      res && {
        a: fit.a,
        b: fit.b,
        n: fit.n,
        slopePpm: (fit.b * OUT_RATE - 1) * 1e6,
        residualRmsMs: res.rms * 1000,
        residualMaxMs: res.max * 1000,
        thresholdMs: o.thresholdMs,
        anchorsOverThreshold: overRuns.reduce((p, r) => p + r.n, 0),
        // contiguous runs of anchors over the threshold against the final fit (a step vs a transient)
        overRuns: overRuns.slice(0, 200),
      },
    clocks: {
      renderMap: { slopeMsPerS: rl.b, residualRmsMs: rRes.rms, residualMaxMs: rRes.max, n: rl.n },
      outputSource: ck.outSource,
      outputMap: ol ? { slopeMsPerS: ol.b, n: ol.n } : null,
      impliedOutputLatencyMs: impliedOut,
      reportedOutputPlusBaseMs:
        (((ctx as { outputLatency?: number }).outputLatency ?? 0) + (ctx.baseLatency || 0)) * 1000,
    },
    monitor: o.monitor
      ? {
          scheduled: !!mon.at,
          resyncs,
          errorMs: summary(monitorErr.map((x) => x.errMs)),
          driftMs:
            monitorErr.length > 60
              ? mean(monitorErr.slice(-30).map((x) => x.errMs)) -
                mean(monitorErr.slice(10, 40).map((x) => x.errMs))
              : null,
        }
      : null,
    loopback: { matched: matched.length, groups, corrected, perFlash: matched },
    calibration: cal,
    fake,
    mediaRecorder: mrReport,
    memory: mem,
    anchors: { count: anchors.length, first: anchors.slice(0, 5), sample: decimate(anchors, 400) },
    clockPairs: { render: decimate(ck.renderPairs, 400), output: decimate(ck.outPairs, 400) },
  }
  lastReport = report
  await postReport(report)
  status(`${o.kind}: done (${stopReason})`)
  log(o.kind, 'done', {
    reason: stopReason,
    samples: done.samples,
    fit: report.fit,
    groups,
    fake,
  })
  return report
}

function summary(v: number[]) {
  if (!v.length) return null
  const abs = v.map(Math.abs)
  return {
    n: v.length,
    mean: mean(v),
    median: median(v),
    maxAbs: Math.max(...abs),
    first: v[0],
    last: v.at(-1),
  }
}

function decimate<T>(v: T[], n: number): T[] {
  if (v.length <= n) return v
  const step = v.length / n
  return Array.from({ length: n }, (_, i) => v[Math.floor(i * step)] as T)
}

function groupErrors(m: { flash: number; errRawMs: number }[]) {
  const pick = (xs: typeof m) => mean(xs.map((x) => x.errRawMs))
  if (!m.length) return { start: NaN, middle: NaN, end: NaN, n: 0 }
  const mid = Math.floor(m.length / 2)
  return {
    start: pick(m.slice(0, 3)),
    middle: pick(m.slice(Math.max(0, mid - 1), mid + 2)),
    end: pick(m.slice(-3)),
    n: m.length,
  }
}

async function sampleUa(mem: { t: number; heapMB: number | null; uaMB?: number | null }[], t0: number) {
  const f = uaMemory()
  if (!f || !self.crossOriginIsolated) return
  try {
    const r = await Promise.race([f.call(performance), sleep(20_000).then(() => null)])
    const pm = perfMemory()
    mem.push({
      t: (performance.now() - t0) / 1000,
      heapMB: pm ? pm.usedJSHeapSize / 2 ** 20 : null,
      uaMB: r ? r.bytes / 2 ** 20 : null,
    })
  } catch {
    /* not available here */
  }
}

async function saveClock(take: string, anchors: Anchor[], online: OnlineLine) {
  try {
    const db = await openDb()
    await putMany(db, [
      {
        store: 'clock',
        value: {
          take,
          updatedAt: Date.now(),
          anchors: anchors.length,
          last: anchors.slice(-30),
          fit: online.line(),
        },
      },
    ])
    db.close()
  } catch {
    /* best effort */
  }
}

async function postReport(report: Record<string, unknown>) {
  try {
    const r = await fetch('/report', { method: 'POST', body: JSON.stringify(report) })
    const j = (await r.json()) as { file: string }
    log('report saved:', j.file)
    report.savedAs = j.file
  } catch (e) {
    log('report not saved:', String(e))
  }
}

// ---------------------------------------------------------------- IndexedDB: verify, assemble, recover

async function readPcm(db: IDBDatabase, take: TakeRecord): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Uint8Array(take.samples * 2)
  let at = 0
  for await (const c of chunksOf(db, take.id, take.chunks)) {
    out.set(new Uint8Array(c.pcm), at)
    at += c.pcm.byteLength
  }
  return out.subarray(0, at)
}

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('')

async function verifyTake(done: DoneMsg) {
  const db = await openDb()
  const take = await get<TakeRecord>(db, 'takes', done.takeId)
  if (!take) throw new Error('take record missing')
  const pcm = await readPcm(db, take)
  db.close()
  const t0 = performance.now()
  const wav = new Uint8Array(44 + pcm.length)
  wav.set(wavHeader(pcm.length / 2, OUT_RATE))
  wav.set(pcm, 44)
  const oneShotFile = hex(await crypto.subtle.digest('SHA-256', wav))
  const oneShotMs = performance.now() - t0
  const oneShotPcm = hex(await crypto.subtle.digest('SHA-256', pcm))
  const decoded = pcm16ToFloat(pcm)
  const ref = computePeaks(decoded)
  const got = decodePeaks(done.peaks.bytes)
  let maxDiff = 0
  for (let l = 0; l < Math.min(ref.levels.length, got.levels.length); l++) {
    const a = ref.levels[l]?.data
    const b = got.levels[l]?.data
    if (!a || !b) continue
    for (let i = 0; i < Math.min(a.length, b.length); i++)
      maxDiff = Math.max(maxDiff, Math.abs((a[i] ?? 0) - (b[i] ?? 0)))
  }
  const dimsOk =
    got.samples === done.samples &&
    got.levels.length === ref.levels.length &&
    got.levels.every((l, i) => l.data.length === ref.levels[i]?.data.length) &&
    (got.levels[0]?.data.length ?? 0) / 2 === Math.ceil(done.samples / 1024)
  // the 24 kHz take decodes as the browser sees it
  let decodable: boolean | string = false
  try {
    const c = new OfflineAudioContext(1, 1, OUT_RATE)
    const b = await c.decodeAudioData(wav.slice().buffer)
    decodable = b.length === done.samples || `length ${b.length}`
  } catch (e) {
    decodable = String(e)
  }
  return {
    samplesInIdb: pcm.length / 2,
    workerFileSha256: done.fileSha256,
    oneShotFileSha256: oneShotFile,
    fileHashMatch: oneShotFile === done.fileSha256,
    workerPcmSha256: done.pcmSha256,
    oneShotPcmSha256: oneShotPcm,
    pcmHashMatch: oneShotPcm === done.pcmSha256,
    runningHashInRecord: take.pcmSha256 === done.pcmSha256,
    oneShotMs,
    decodable,
    peaks: {
      dimsOk,
      maxDiffVsRecomputed: maxDiff,
      levels: got.levels.length,
      bins0: (got.levels[0]?.data.length ?? 0) / 2,
    },
  }
}

async function assembleWav(takeId: string): Promise<Blob> {
  const db = await openDb()
  const take = await get<TakeRecord>(db, 'takes', takeId)
  if (!take) throw new Error('take record missing')
  const parts: BlobPart[] = [wavHeader(take.samples, OUT_RATE)]
  for await (const c of chunksOf(db, takeId, take.chunks)) parts.push(c.pcm)
  db.close()
  return new Blob(parts, { type: 'audio/wav' })
}

async function markUploaded(takeId: string) {
  const db = await openDb()
  const take = await get<TakeRecord>(db, 'takes', takeId)
  if (take)
    await putMany(db, [{ store: 'takes', value: { ...take, status: 'uploaded', updatedAt: Date.now() } }])
  db.close()
}

async function recoverable() {
  const db = await openDb()
  const takes = (await all<TakeRecord>(db, 'takes')).filter((t) => t.status !== 'uploaded')
  db.close()
  return takes.map((t) => ({
    id: t.id,
    status: t.status,
    samples: t.samples,
    chunks: t.chunks,
    seconds: t.samples / OUT_RATE,
  }))
}

async function recover(id: string) {
  const t0 = performance.now()
  const db = await openDb()
  const take = await get<TakeRecord>(db, 'takes', id)
  if (!take) throw new Error('no such take')
  const pcm = await readPcm(db, take)
  const clockRec = await get<{ anchors: number; fit: Line | null }>(db, 'clock', id)
  db.close()
  const sha = hex(await crypto.subtle.digest('SHA-256', pcm))
  const wav = new Blob([wavHeader(pcm.length / 2, OUT_RATE), pcm.slice().buffer], { type: 'audio/wav' })
  const r = {
    kind: 'recovery',
    ts: new Date().toISOString(),
    setup: { engine: engine(), userAgent: navigator.userAgent },
    id,
    status: take.status,
    samples: pcm.length / 2,
    recordSamples: take.samples,
    chunks: take.chunks,
    runningHashOk: sha === take.pcmSha256,
    wavBytes: wav.size,
    clockAnchorsSaved: clockRec?.anchors ?? 0,
    fitSaved: !!clockRec?.fit,
    recoverMs: performance.now() - t0,
  }
  lastReport = r
  await postReport(r)
  log('recovered', r)
  return r
}

// ---------------------------------------------------------------- MediaRecorder comparison

interface MrState {
  rec: MediaRecorder
  mime: string
  callAt: number
  startAt: number | null
  firstDataAt: number | null
  parts: Blob[]
  bytes: number
  heapAtStart: number | null
}

function startMr(stream: MediaStream): MrState {
  const mime = MR_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? ''
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : {})
  const pm = perfMemory()
  const s: MrState = {
    rec,
    mime: rec.mimeType || mime,
    callAt: performance.now(),
    startAt: null,
    firstDataAt: null,
    parts: [],
    bytes: 0,
    heapAtStart: pm ? pm.usedJSHeapSize : null,
  }
  rec.onstart = () => (s.startAt = performance.now())
  rec.ondataavailable = (e) => {
    s.firstDataAt ??= performance.now()
    s.parts.push(e.data)
    s.bytes += e.data.size
  }
  rec.start(1000)
  return s
}

function stopMr(s: MrState): Promise<MrState> {
  return new Promise((res) => {
    s.rec.onstop = () => res(s)
    s.rec.stop()
  })
}

async function analyseMr(ctx: AudioContext, s: MrState, done: DoneMsg, ck: Clock, startFrame: number) {
  const blob = new Blob(s.parts, { type: s.mime })
  let decodedSeconds: number | null = null
  let offsets: number[] = []
  let mrFirstSampleAfterCallMs: number | null = null
  let error: string | null = null
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer())
    decodedSeconds = buf.duration
    const on = detectOnsets(buf.getChannelData(0), { sampleRate: buf.sampleRate })
    // Align MR's first sample to the take without trusting its 'start' event: both end at stop, so the duration
    // difference is the coarse offset (beeps repeat, so it resolves the ambiguity); matched onsets refine it.
    const coarse = done.samples / OUT_RATE - buf.duration
    const wk = done.onsets.map((o) => o.sample / OUT_RATE)
    offsets = on
      .map((o) => {
        const t = o.sample / buf.sampleRate + coarse
        const near = wk.reduce((b, w) => (Math.abs(w - t) < Math.abs(b - t) ? w : b), Infinity)
        return (near - o.sample / buf.sampleRate) * 1000
      })
      .filter((d) => Math.abs(d - coarse * 1000) < 250)
    const firstSamplePerf = ck.ctToPerfRender(startFrame / ctx.sampleRate) + median(offsets)
    mrFirstSampleAfterCallMs = firstSamplePerf - s.callAt
  } catch (e) {
    error = String(e)
  }
  return {
    mime: s.mime,
    startDelayMs: s.startAt === null ? null : s.startAt - s.callAt,
    firstDataMs: s.firstDataAt === null ? null : s.firstDataAt - s.callAt,
    bytes: s.bytes,
    kbps: decodedSeconds ? (s.bytes * 8) / 1000 / decodedSeconds : null,
    decodedSeconds,
    workletSeconds: done.samples / OUT_RATE,
    // where MR's decoded sample 0 sits on the take's timeline (start delay + codec priming as seen after decode)
    firstSampleVsTakeStartMs: offsets.length
      ? { n: offsets.length, median: median(offsets), min: Math.min(...offsets), max: Math.max(...offsets) }
      : null,
    firstSampleAfterStartCallMs: mrFirstSampleAfterCallMs,
    decodeError: error,
  }
}

// ---------------------------------------------------------------- calibration

interface Calib {
  ms: number
  sd: number
  n: number
  at: string
}
interface Calibrations {
  a: Calib | null
  b: Calib | null
  c: number
}
function calibrations(label: string): Calibrations {
  let stored: Partial<Calibrations> = {}
  try {
    stored = JSON.parse(localStorage.getItem(`s10-cal:${label}`) ?? '{}') as Partial<Calibrations>
  } catch {
    stored = {}
  }
  return { a: stored.a ?? null, b: stored.b ?? null, c: Number(($('manual') as HTMLInputElement).value) }
}
function saveCalibration(label: string, which: 'a' | 'b', r: RobustMean) {
  const cur = calibrations(label)
  cur[which] = { ms: r.mean, sd: r.sd, n: r.kept, at: new Date().toISOString() }
  try {
    localStorage.setItem(`s10-cal:${label}`, JSON.stringify(cur))
  } catch {
    /* private mode */
  }
  showCalibration(label)
}
function showCalibration(label: string) {
  const c = calibrations(label)
  const f = (x: Calib | null) => (x ? `${x.ms.toFixed(1)} ms (sd ${x.sd.toFixed(1)}, n ${x.n})` : 'not run')
  $('calib').innerHTML =
    `<b>${escapeHtml(label)}</b><br>(a) loopback: ${f(c.a)}<br>(b) clap: ${f(c.b)}<br>(c) manual: ${c.c} ms`
}

/** (a) Speakers -> mic: 8 scheduled 2 kHz clicks; L = render-map perf of the captured onset − output-map perf of the click. */
async function calibrateLoopback(partial: Partial<TakeOpts> = {}) {
  const o: TakeOpts = { ...defaults(), ...partial }
  const ctx = await ensureCtx()
  const ck = clock
  if (!ck) throw new Error('no clock')
  ck.reset()
  status('calibration (a): listening')
  const cap = await startCapture(ctx, { ...o, persist: false })
  const startFrame = await cap.startFrame
  await sleep(700)
  const clicks: number[] = []
  const t = ctx.currentTime + 0.3
  for (let k = 0; k < 8; k++) {
    const at = t + k * 0.6
    const osc = ctx.createOscillator()
    osc.frequency.value = 2000
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, 0)
    g.gain.setValueAtTime(0.5, at)
    g.gain.setValueAtTime(0, at + 0.03)
    osc.connect(g).connect(ctx.destination)
    osc.start(at)
    osc.stop(at + 0.05)
    clicks.push(at)
  }
  await sleep((t + 8 * 0.6 - ctx.currentTime) * 1000 + 600)
  const done = await cap.stop()
  const inPerf = done.onsets.map((on) =>
    ck.ctToPerfRender((startFrame + (on.sample * ctx.sampleRate) / OUT_RATE) / ctx.sampleRate),
  )
  const lat: number[] = []
  for (const c of clicks) {
    const out = ck.ctToPerfOut(c)
    const hit = inPerf.find((p) => p - out > -50 && p - out < 600)
    if (hit !== undefined) lat.push(hit - out)
  }
  const r = robustMean(lat, 2)
  if (lat.length >= 4) saveCalibration(o.label, 'a', r)
  const report = {
    kind: 'calib-a',
    ts: new Date().toISOString(),
    setup: {
      label: o.label,
      engine: engine(),
      userAgent: navigator.userAgent,
      mode: o.mode,
      mic: o.mic,
      inputLabel: cap.track.label,
      sampleRate: ctx.sampleRate,
    },
    clicks: clicks.length,
    detected: lat.length,
    result: r,
    outputSource: ck.outSource,
    impliedOutputLatencyMs: mean(ck.outPairs.slice(-50).map((p) => p.pt - ck.ctToPerfRender(p.ct))),
    reportedOutputPlusBaseMs:
      (((ctx as { outputLatency?: number }).outputLatency ?? 0) + (ctx.baseLatency || 0)) * 1000,
  }
  lastReport = report
  await postReport(report)
  status(`calibration (a): ${lat.length}/8 clicks, ${r.mean.toFixed(1)} ms`)
  log('calib-a', report)
  return report
}

/** (b) Clap on each of the 30 s picture's 8 flashes, monitor off. L = robust mean of (fit time of clap − flash). */
async function calibrateClap(partial: Partial<TakeOpts> = {}) {
  const r = await runTake({
    media: 30,
    monitor: false,
    persist: false,
    upload: false,
    mediaRecorder: false,
    kind: 'calib-b',
    ...partial,
  })
  const label = r.setup.label
  const errs = r.loopback.perFlash.map((m) => m.errRawMs)
  const rm = robustMean(errs, 15)
  if (errs.length >= 4) saveCalibration(label, 'b', rm)
  const report = {
    kind: 'calib-b-result',
    ts: new Date().toISOString(),
    setup: r.setup,
    claps: errs.length,
    result: rm,
    fit: r.fit,
  }
  lastReport = report
  await postReport(report)
  status(`calibration (b): ${errs.length} claps, ${rm.mean.toFixed(1)} ms`)
  return report
}

// ---------------------------------------------------------------- multi-take audition memory (sliding window + LRU)

async function audition(
  o: {
    takes?: number
    active?: number
    seconds?: number
    budgetMB?: number
    windowSec?: number
    ahead?: number
    behind?: number
  } = {},
) {
  const takes = o.takes ?? 32
  const active = o.active ?? 8
  const seconds = o.seconds ?? 600
  const budget = (o.budgetMB ?? 200) * 2 ** 20
  const windowSec = o.windowSec ?? 10
  const ahead = o.ahead ?? 30
  const behind = o.behind ?? 5
  const ctx = await ensureCtx()
  status('audition: running')
  const winSamples = windowSec * OUT_RATE
  const cache = new Map<string, { buf: AudioBuffer; bytes: number }>()
  let bytes = 0
  let peak = 0
  let misses = 0
  let hits = 0
  let evictions = 0
  let decodeMs = 0
  const heap: { t: number; heapMB: number | null; cacheMB: number }[] = []
  const pcm = new Uint8Array(winSamples * 2)
  const dv = new DataView(pcm.buffer)
  const ensure = (take: number, w: number, needed: Set<string>) => {
    const key = `${take}:${w}`
    const hit = cache.get(key)
    if (hit) {
      hits++
      cache.delete(key)
      cache.set(key, hit)
      return
    }
    misses++
    const d0 = performance.now()
    // stand-in for reading PCM16 for this window from IndexedDB / a Range request: a per-take tone
    const f = 200 + take * 10
    for (let i = 0; i < winSamples; i++)
      dv.setInt16(
        2 * i,
        Math.round(8000 * Math.sin((2 * Math.PI * f * (w * winSamples + i)) / OUT_RATE)),
        true,
      )
    const buf = ctx.createBuffer(1, winSamples, OUT_RATE)
    buf.copyToChannel(pcm16ToFloat(pcm), 0)
    decodeMs += performance.now() - d0
    const b = winSamples * 4
    cache.set(key, { buf, bytes: b })
    bytes += b
    for (const [k, v] of cache) {
      if (bytes <= budget) break
      if (needed.has(k)) continue
      cache.delete(k)
      bytes -= v.bytes
      evictions++
    }
    peak = Math.max(peak, bytes)
  }
  const t0 = performance.now()
  for (let t = 0; t < seconds; t += 1) {
    const needed = new Set<string>()
    const set: number[] = []
    for (let j = 0; j < active; j++) set.push((Math.floor(t / 20) + j * Math.floor(takes / active)) % takes)
    const w0 = Math.max(0, Math.floor((t - behind) / windowSec))
    const w1 = Math.min(Math.ceil(seconds / windowSec) - 1, Math.floor((t + ahead) / windowSec))
    for (const k of set) for (let w = w0; w <= w1; w++) needed.add(`${k}:${w}`)
    for (const k of set) for (let w = w0; w <= w1; w++) ensure(k, w, needed)
    if (t % 60 === 0) {
      const pm = perfMemory()
      heap.push({ t, heapMB: pm ? pm.usedJSHeapSize / 2 ** 20 : null, cacheMB: bytes / 2 ** 20 })
      await sleep(0)
    }
  }
  const mem: { t: number; heapMB: number | null; uaMB?: number | null }[] = []
  await sampleUa(mem, t0)
  const report = {
    kind: 'audition',
    ts: new Date().toISOString(),
    setup: { engine: engine(), userAgent: navigator.userAgent, label: defaults().label },
    params: { takes, active, seconds, budgetMB: budget / 2 ** 20, windowSec, ahead, behind },
    naiveDecodeAllMB: (takes * seconds * OUT_RATE * 4) / 2 ** 20,
    peakCacheMB: peak / 2 ** 20,
    withinBudget: peak <= budget,
    windowMB: (winSamples * 4) / 2 ** 20,
    misses,
    hits,
    evictions,
    decodeMsTotal: decodeMs,
    decodeMsPerWindow: decodeMs / Math.max(1, misses),
    wallMs: performance.now() - t0,
    heap,
    uaMemory: mem,
  }
  cache.clear()
  lastReport = report
  await postReport(report)
  status(`audition: peak ${report.peakCacheMB.toFixed(0)} MB, ${misses} decodes`)
  log('audition', report)
  return report
}

// ---------------------------------------------------------------- wiring

async function matrixAndPost() {
  const m = await apiMatrix()
  const r = {
    kind: 'matrix',
    ts: new Date().toISOString(),
    setup: { engine: m.engine, userAgent: m.userAgent, label: defaults().label },
    matrix: m,
  }
  lastReport = r
  await postReport(r)
  log('matrix', m)
  return m
}

async function listDevices() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices()
    const sel = $('device') as HTMLSelectElement
    for (const d of devs.filter((x) => x.kind === 'audioinput' && x.deviceId)) {
      if ([...sel.options].some((o) => o.value === d.deviceId)) continue
      sel.add(new Option(d.label || d.deviceId.slice(0, 8), d.deviceId))
    }
  } catch {
    /* no permission yet */
  }
}

function download() {
  if (!lastReport) return
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([JSON.stringify(lastReport, null, 1)], { type: 'application/json' }))
  a.download = `s10-${String(lastReport.kind)}-${Date.now()}.json`
  a.click()
}

const wrap = (f: () => Promise<unknown>) => () => {
  f()
    .then(() => listDevices())
    .catch((e: unknown) => {
      status(`error: ${String(e)}`)
      log('error', String(e))
    })
}
$('bMatrix').onclick = wrap(matrixAndPost)
$('bTake30').onclick = wrap(() => runTake({ media: 30 }))
$('bTake600').onclick = wrap(() => runTake({ media: 600 }))
$('bStop').onclick = () => current?.stop('user')
$('bCalA').onclick = wrap(() => calibrateLoopback())
$('bCalB').onclick = wrap(() => calibrateClap())
$('bAudition').onclick = wrap(() => audition())
$('bRecover').onclick = wrap(async () => {
  const list = await recoverable()
  log('recoverable', list)
  for (const t of list) await recover(t.id)
})
$('bClear').onclick = wrap(async () => {
  const db = await openDb()
  await clearAll(db)
  db.close()
  log('IndexedDB cleared')
})
$('bDownload').onclick = download
$('manual').oninput = () => {
  $('manualOut').textContent = ($('manual') as HTMLInputElement).value
  showCalibration(defaults().label)
}
$('label').onchange = () => showCalibration(defaults().label)
const q = new URLSearchParams(location.search)
if (q.get('mode')) ($('mode') as HTMLSelectElement).value = q.get('mode') ?? 'loopback'
if (q.get('label')) ($('label') as HTMLInputElement).value = q.get('label') ?? ''
showCalibration(defaults().label)
void listDevices()

const api = {
  matrix: matrixAndPost,
  take: runTake,
  stop: (reason = 'user') => current?.stop(reason),
  calibrateLoopback,
  calibrateClap,
  audition,
  recoverable,
  recover,
  clear: async () => {
    const db = await openDb()
    await clearAll(db)
    db.close()
  },
  running: () => !!current,
  endTrack: () => current?.track.dispatchEvent(new Event('ended')),
  lastReport: () => lastReport,
}
;(window as unknown as { __s10: typeof api }).__s10 = api
log('ready', { engine: engine(), crossOriginIsolated: self.crossOriginIsolated })
