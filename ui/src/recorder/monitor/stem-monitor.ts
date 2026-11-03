// The stem monitor (docs/plans/2026-11-02-record-your-own-voiceover.md §5.3 Monitor mix, §2.2 step 2): what the
// person hears while recording. The MP4 is one mixed track, so the monitor is built from the draft's separate stems
// in the SAME AudioContext as the capture, positioned from the picture anchors:
//
//   music      at the draft's level with its pre-ducked lane (stems.ts; never reacting to the mic, decision 14)
//   AI voice   per beat in keep and under modes, none in replace
//   effects    at their level (muted with the rest by "Mute all original audio")
//   narration  the existing clips, rendered in chunks with the audition's timeline math (narration-audition.ts
//              renderChunk: the same joins, fades and gains as the run), muted inside an armed punch range
//
// Scheduling: start(anchors) plans from the median of ~10 picture anchors (monitor-schedule.ts planMonitorStart) and
// starts every stem at its offset; resync(anchors) feeds each new anchor to MonitorSync and restarts everything at a
// fresh plan when the monitor has drifted (old sources stop exactly when the new ones start). Speakers mode ducks the
// whole monitor to −30 dB, or mutes it (§2.1). Stems decode whole with decodeAudioData on this context (an
// AudioBufferSourceNode needs the buffer); takes are read in place and held under the audition's LRU budget.
import {
  SAMPLE_RATE,
  segments,
  type NarrationOp,
  type Segment,
  type Span,
} from '../../../../src/lib/timeline'
import {
  CHUNK_SAMPLES,
  SCHEDULE_AHEAD_SEC,
  audibleChunks,
  planChunks,
  renderChunk,
  sourceRanges,
  windowAround,
} from '../../lib/narration-audition'
import {
  DECODE_BUDGET_BYTES,
  LruBudget,
  browserDecoder,
  takeFromBytes,
  type BudgetStats,
  type Decoder,
  type TakeAudio,
} from '../../lib/narration-decode'
import {
  MONITOR_ANCHORS,
  MonitorSync,
  planMonitorStart,
  type MonitorPlan,
  type MonitorSyncOptions,
  type OutputMap,
  type ResyncCheck,
} from '../clock/monitor-schedule'
import type { Anchor } from '../clock/picture'
import {
  armedRangeEvents,
  monitorLevel,
  monitorStems,
  monitorTracks,
  narrationLevel,
  stemGainEvents,
  stemStart,
  type GainEvent,
  type MonitorAudio,
  type MonitorStem,
  type OutputMode,
} from './stems'

const PUMP_MS = 200

export interface StemMonitorOptions {
  /** The capture's context (the record flow's): the monitor never makes or closes one. */
  context: AudioContext
  /** The context's output map (the take's AudioClock): when a context time is heard. */
  clock: OutputMap
  /** The draft's composition (index.html). */
  html: string
  /** The existing narration, or null before the first take. */
  op: NarrationOp | null
  /** The take's Original audio choice (setup panel); the op's tracks when left out. */
  audio?: MonitorAudio
  /** Each existing take's length in samples, as stored (crossfade handles depend on it). */
  takeSamples: ReadonlyMap<string, number>
  /** Each existing take's speech summary in source samples, for the music's pre-ducked lane. */
  takeSpans?: ReadonlyMap<string, readonly Span[]>
  /** A take's file bytes by media id (its signed link). */
  takeLoader: (mediaId: string) => Promise<ArrayBuffer>
  /** A stem's file bytes by its composition src (assets/…), from the draft bundle. */
  stemLoader: (src: string) => Promise<ArrayBuffer>
  outputMode: OutputMode
  /** Speakers mode's level in dB; null mutes the monitor. Default −30. */
  speakersLevelDb?: number | null
  /** Where the monitor plays; the context's destination by default. */
  destination?: AudioNode
  /** Anchors the first plan needs (MONITOR_ANCHORS). */
  minAnchors?: number
  sync?: Partial<MonitorSyncOptions>
  decode?: Decoder
  budgetBytes?: number
  /** Structured events: one per start, resync, load and failure. */
  log?: (event: string, fields: Record<string, unknown>) => void
  now?: () => number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (id: unknown) => void
}

export interface StemMonitorStats extends BudgetStats {
  running: boolean
  plan: MonitorPlan | null
  resyncs: number
  /** The last anchor's median drift in ms. */
  driftMs: number | null
  stems: { id: string; role: MonitorStem['role']; loaded: boolean }[]
  stemBytes: number
  /** Stem and chunk sources started on the current plan. */
  scheduled: number
  chunks: number
  armedRange: Span | null
  level: number
  failures: number
}

export interface StemMonitor {
  /** The monitor's master gain (connected to the destination). */
  readonly output: GainNode
  readonly stems: readonly MonitorStem[]
  /** Loads every stem and the existing narration around composition second `at`; resolves when it's playable. */
  prepare(at?: number): Promise<void>
  /** Starts the monitor from the picture anchors; null (nothing started) with too few anchors. */
  start(anchors: readonly Anchor[]): MonitorPlan | null
  /** Measures the newest anchor and restarts on drift; null before start or for an anchor already seen. */
  resync(anchors: readonly Anchor[]): ResyncCheck | null
  /** Mutes existing narration in [from, to) composition samples (to may be Infinity); null unmutes. */
  setArmedRange(range: Span | null): void
  /** Stops every source now; start() may run again. */
  stop(): void
  stats(): StemMonitorStats
  /** stop() and disconnect. The context stays open: it's the capture's. */
  dispose(): void
}

type Entry = { kind: 'take'; take: TakeAudio } | { kind: 'chunk'; pcm: Float32Array }

function apply(param: AudioParam, events: readonly GainEvent[]) {
  for (const e of events) {
    if (e.kind === 'set') param.setValueAtTime(e.value, e.at)
    else param.linearRampToValueAtTime(e.value, e.at)
  }
}

export function createStemMonitor(o: StemMonitorOptions): StemMonitor {
  const ctx = o.context
  const log = (event: string, fields: Record<string, unknown> = {}) => o.log?.(event, fields)
  const now = o.now ?? (() => performance.now())
  const tracks = monitorTracks(o.op, o.audio)
  const stems = o.html ? monitorStems(o.html, o.op, o.audio, o.takeSpans) : []
  const segs: Segment[] = o.op && narrationLevel(tracks) > 0 ? segments(o.op.clips, o.takeSamples) : []
  const level = monitorLevel(o.outputMode, o.speakersLevelDb)
  const minAnchors = o.minAnchors ?? MONITOR_ANCHORS

  const output = ctx.createGain()
  output.gain.value = level
  output.connect(o.destination ?? ctx.destination)
  const bus = ctx.createGain()
  bus.gain.value = narrationLevel(tracks)
  const arm = ctx.createGain()
  arm.gain.value = 1
  bus.connect(arm).connect(output)

  const buffers = new Map<string, AudioBuffer>()
  const loading = new Map<string, Promise<void>>()
  const cache = new LruBudget<Entry>(o.budgetBytes ?? DECODE_BUDGET_BYTES)
  const takesLoading = new Map<string, Promise<void>>()
  let sync = new MonitorSync(o.sync)
  let plan: MonitorPlan | null = null
  let lastAnchor: Anchor | null = null
  let driftMs: number | null = null
  let armed: Span | null = null
  let failures = 0
  let timer: unknown = null
  let disposed = false
  /** Sources on the current plan: stems by id, chunks by `c<k>`. */
  let sources = new Map<string, { src: AudioBufferSourceNode; gain?: GainNode }>()

  const decode = (bytes: ArrayBuffer) => ctx.decodeAudioData(bytes)

  function loadStem(src: string): Promise<void> {
    if (buffers.has(src)) return Promise.resolve()
    let p = loading.get(src)
    if (!p) {
      const t0 = now()
      p = o
        .stemLoader(src)
        .then(decode)
        .then((buf) => {
          buffers.set(src, buf)
          log('monitor.stem_loaded', {
            src,
            seconds: Math.round(buf.duration * 1000) / 1000,
            ms: Math.round(now() - t0),
          })
          if (plan) pump()
        })
        .catch((err: unknown) => {
          failures++
          log('monitor.load_failed', { src, error: String(err) })
        })
        .finally(() => loading.delete(src))
      loading.set(src, p)
    }
    return p
  }

  function loadTake(id: string, pinned: ReadonlySet<string>): Promise<void> {
    if (cache.has(`take:${id}`)) return Promise.resolve()
    let p = takesLoading.get(id)
    if (!p) {
      p = o
        .takeLoader(id)
        .then((bytes) => takeFromBytes(bytes, o.decode ?? browserDecoder))
        .then((take) => {
          cache.set(`take:${id}`, { kind: 'take', take }, take.bytes, pinned)
        })
        .finally(() => takesLoading.delete(id))
      takesLoading.set(id, p)
    }
    return p
  }

  /** Loads the takes around composition second `at` and renders their chunks (as the audition's ready()). */
  async function readyNarration(at: number) {
    if (!segs.length) return
    const span = windowAround(Math.round(at * SAMPLE_RATE))
    const ranges = sourceRanges(segs, span)
    const pinned = new Set([...ranges.keys()].map((id) => `take:${id}`))
    await Promise.all([...ranges.keys()].map((id) => loadTake(id, pinned)))
    if (disposed) return
    const takes = new Map<string, TakeAudio>()
    for (const id of ranges.keys()) {
      const e = cache.get(`take:${id}`)
      if (e?.kind === 'take') takes.set(id, e.take)
    }
    for (const k of audibleChunks(segs, span)) {
      const key = `chunk:${k}`
      if (cache.has(key)) continue
      const needs = sourceRanges(segs, [k * CHUNK_SAMPLES, (k + 1) * CHUNK_SAMPLES])
      if (![...needs.keys()].every((id) => takes.has(id))) continue
      const pcm = renderChunk(segs, k, takes)
      cache.set(key, { kind: 'chunk', pcm }, pcm.byteLength, pinned)
    }
  }

  function prefetch(at: number) {
    readyNarration(at).catch((err: unknown) => {
      failures++
      log('monitor.load_failed', { at, error: String(err) })
    })
  }

  /** Composition seconds being rendered now on the current plan. */
  const position = () => (plan ? plan.offset + (ctx.currentTime - plan.when) : 0)

  function startStem(stem: MonitorStem, p: MonitorPlan) {
    if (sources.has(stem.id)) return
    const buf = buffers.get(stem.src)
    const s = stemStart(stem, p)
    if (!buf || !s) return
    // Loaded late: it joins at the time it would have reached by now.
    const late = Math.max(0, ctx.currentTime + 0.02 - s.when)
    if (s.duration !== null && late >= s.duration) return
    const gain = ctx.createGain()
    gain.gain.value = 0
    apply(gain.gain, stemGainEvents(stem, p))
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(gain).connect(output)
    const offset = s.offset + late
    if (offset >= buf.duration) return
    if (s.duration === null) src.start(s.when + late, offset)
    else src.start(s.when + late, offset, s.duration - late)
    sources.set(stem.id, { src, gain })
  }

  function startChunks(p: MonitorPlan) {
    if (!segs.length) return
    const anchor = { sample: p.offset * SAMPLE_RATE, ctxTime: p.when }
    const at = Math.max(p.offset, position())
    const due = audibleChunks(segs, windowAround(Math.round(at * SAMPLE_RATE), 0, SCHEDULE_AHEAD_SEC * 2))
    for (const s of planChunks(anchor, Math.max(ctx.currentTime + 0.02, p.when), SCHEDULE_AHEAD_SEC, due)) {
      const key = `c${s.chunk}`
      if (sources.has(key)) continue
      const e = cache.get(`chunk:${s.chunk}`)
      if (e?.kind !== 'chunk') continue
      const buf = ctx.createBuffer(1, CHUNK_SAMPLES, SAMPLE_RATE)
      buf.copyToChannel(e.pcm as Float32Array<ArrayBuffer>, 0)
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(bus)
      src.start(s.when, s.offsetSamples / SAMPLE_RATE)
      sources.set(key, { src })
    }
  }

  function pump() {
    const p = plan
    if (!p || disposed) return
    for (const stem of stems) startStem(stem, p)
    prefetch(position())
    startChunks(p)
  }

  /** Stops the current plan's sources at context time `at` (a restart's start, so nothing overlaps or gaps). */
  function stopSources(at?: number) {
    const old = sources
    sources = new Map()
    for (const { src, gain } of old.values()) {
      src.onended = () => {
        src.disconnect()
        gain?.disconnect()
      }
      try {
        src.stop(at)
      } catch {
        // never started
      }
    }
  }

  function applyArmed() {
    const g = arm.gain
    g.cancelScheduledValues(0)
    if (!plan) {
      g.setValueAtTime(armed ? 0 : 1, ctx.currentTime)
      return
    }
    apply(g, armedRangeEvents(armed, plan, ctx.currentTime))
  }

  function begin(anchors: readonly Anchor[], why: string, check?: ResyncCheck): MonitorPlan | null {
    const next = planMonitorStart(anchors, o.clock, ctx.currentTime, { n: minAnchors })
    if (!next) return null
    stopSources(next.when)
    plan = next
    sync.started(next, now())
    lastAnchor = anchors[anchors.length - 1] ?? null
    applyArmed()
    pump()
    timer ??= (o.setInterval ?? setInterval)(pump, PUMP_MS)
    log(why === 'start' ? 'monitor.start' : 'monitor.resync', {
      why,
      when: next.when,
      offset: Math.round(next.offset * 1e6) / 1e6,
      stems: stems.length,
      scheduled: sources.size,
      ...(check ? { driftMs: Math.round(check.driftMs * 100) / 100 } : {}),
      output: o.outputMode,
      aiVoice: tracks.aiVoice.mode,
    })
    return next
  }

  return {
    output,
    stems,
    async prepare(at = 0) {
      await Promise.all([...new Set(stems.map((s) => s.src))].map(loadStem))
      await readyNarration(at).catch((err: unknown) => {
        failures++
        log('monitor.load_failed', { at, error: String(err) })
      })
    },
    start(anchors) {
      if (disposed) return null
      return begin(anchors, 'start')
    },
    resync(anchors) {
      const a = anchors[anchors.length - 1]
      if (!plan || !a || a === lastAnchor) return null
      lastAnchor = a
      const check = sync.observe(a, o.clock)
      if (!check) return null
      driftMs = check.driftMs
      if (check.resync && check.why) begin(anchors, check.why, check)
      return check
    },
    setArmedRange(range) {
      armed = range ? [range[0], range[1]] : null
      applyArmed()
      log('monitor.armed', { range: armed ? [armed[0], Number.isFinite(armed[1]) ? armed[1] : null] : null })
    },
    stop() {
      if (timer !== null) (o.clearInterval ?? clearInterval)(timer as never)
      timer = null
      stopSources()
      if (plan) log('monitor.stop', { resyncs: sync.resyncs, failures })
      plan = null
      lastAnchor = null
      sync = new MonitorSync(o.sync)
    },
    stats() {
      const keys = cache.keys()
      return {
        ...cache.stats(),
        running: plan !== null,
        plan,
        resyncs: sync.resyncs,
        driftMs,
        stems: stems.map((s) => ({ id: s.id, role: s.role, loaded: buffers.has(s.src) })),
        stemBytes: [...buffers.values()].reduce((n, b) => n + b.length * b.numberOfChannels * 4, 0),
        scheduled: sources.size,
        chunks: keys.filter((k) => k.startsWith('chunk:')).length,
        armedRange: armed,
        level,
        failures,
      }
    },
    dispose() {
      this.stop()
      disposed = true
      output.disconnect()
      bus.disconnect()
      arm.disconnect()
    },
  }
}
