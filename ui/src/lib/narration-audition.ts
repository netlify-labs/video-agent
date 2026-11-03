// The narration audition (docs/plans/2026-11-02-record-your-own-voiceover.md §2.1 step 7, §5.4): right after a take,
// the person hears their narration against the composition preview without a render. The iframe plays the picture
// and the composition's own audio (levelled by the bridge's mix command, preview-mix.ts); this plays the narration in
// the parent page with Web Audio, scheduled to the preview's clock.
//
// The narration bus is rendered in CHUNK_SAMPLES pieces of composition time with the shared timeline.ts math (resolve,
// segments, envelope, dbToGain), so crossfades, declicks, user fades and clip gains match the run's mixer to the
// sample; each chunk is one AudioBufferSourceNode at 24 kHz, started back to back on exact sample boundaries. The
// track's volume and mute are a live GainNode, so moving them doesn't re-render. Only a sliding window around the
// playhead (WINDOW_BEHIND_SEC back, WINDOW_AHEAD_SEC ahead) is loaded and rendered, under one 200 MB budget with LRU
// eviction (narration-decode.ts). It plays raw: cleanup exists only in the run. An A/B toggle adds an approximate
// cleanup chain on the bus, labelled as such.
import {
  SAMPLE_RATE,
  clipEnd,
  dbToGain,
  segments,
  envelope,
  sourceSampleAt,
  type NarrationOp,
  type Segment,
  type Span,
} from '../../../src/lib/timeline'
import {
  DECODE_BUDGET_BYTES,
  LruBudget,
  browserDecoder,
  takeFromBytes,
  type BudgetStats,
  type Decoder,
  type TakeAudio,
} from './narration-decode'

/** What the UI shows next to the narration track while it plays unprocessed. */
export const RAW_LABEL = 'raw, before cleanup'
export const RAW_DESCRIPTION =
  'Your narration plays raw here, before cleanup. The render applies the cleanup you pick.'
/** The A/B toggle's label and its caveat: a browser approximation of the Light chain, not the run's ffmpeg. */
export const APPROX_CLEANUP_LABEL = 'Cleanup (approximate)'
export const APPROX_CLEANUP_DESCRIPTION = "Approximate: the render's cleanup is the real one."

/** Composition samples per rendered chunk (5 s, 480 KB as Float32). */
export const CHUNK_SAMPLES = 5 * SAMPLE_RATE
export const WINDOW_AHEAD_SEC = 30
export const WINDOW_BEHIND_SEC = 10
/** Source nodes are created this far ahead of the audio clock. */
export const SCHEDULE_AHEAD_SEC = 1.5
/** Headroom between creating a source and its start. */
export const START_LEAD_SEC = 0.05
/** A preview clock this far from ours is a seek or a stall: re-anchor at once. */
export const RESYNC_SEC = 0.25
/** A smoothed drift past one frame (30 fps) re-anchors too, so the audition stays within a frame of the picture. */
export const DRIFT_SEC = 1 / 30
const DRIFT_SMOOTHING = 0.2
const PUMP_MS = 200

// ---- pure scheduling math

/** Composition sample `sample` sounds at audio-context time `ctxTime`. */
export interface Anchor {
  sample: number
  ctxTime: number
}

/** The loaded window around a playhead, in composition samples. */
export function windowAround(
  playhead: number,
  behindSec = WINDOW_BEHIND_SEC,
  aheadSec = WINDOW_AHEAD_SEC,
): Span {
  return [Math.max(0, playhead - behindSec * SAMPLE_RATE), playhead + aheadSec * SAMPLE_RATE]
}

const chunkSpan = (k: number): Span => [k * CHUNK_SAMPLES, (k + 1) * CHUNK_SAMPLES]
const overlaps = (seg: Segment, [a, b]: Span) => seg.from < b && seg.to > a
const audible = (seg: Segment) => seg.clip.gainDb !== null

/** Chunks that overlap `span` and have audible narration in them, in order. */
export function audibleChunks(segs: readonly Segment[], span: Span): number[] {
  const out = new Set<number>()
  for (const seg of segs) {
    if (!audible(seg) || !overlaps(seg, span)) continue
    const a = Math.max(seg.from, span[0], 0)
    const b = Math.min(seg.to, span[1])
    for (let k = Math.floor(a / CHUNK_SAMPLES); k * CHUNK_SAMPLES < b; k++) out.add(k)
  }
  return [...out].sort((x, y) => x - y)
}

/** Source samples of each take that the audible segments in `span` read, per media id (unmerged). */
export function sourceRanges(segs: readonly Segment[], span: Span): Map<string, Span[]> {
  const out = new Map<string, Span[]>()
  for (const seg of segs) {
    if (!audible(seg) || !overlaps(seg, span)) continue
    const a = Math.max(seg.from, span[0])
    const b = Math.min(seg.to, span[1])
    const list = out.get(seg.clip.mediaId) ?? []
    list.push([sourceSampleAt(seg.clip, a), sourceSampleAt(seg.clip, b)])
    out.set(seg.clip.mediaId, list)
  }
  return out
}

/**
 * Chunk k of the narration bus: composition samples [k·CHUNK, (k+1)·CHUNK), each audible segment's source times its
 * clip gain and timeline envelope, summed (a crossfade's two sides overlap here). The same per-sample sum as
 * mixToBuffer over a window, so the audition and the run hear the same joins. Track volume is applied live, not here.
 */
export function renderChunk(
  segs: readonly Segment[],
  k: number,
  takes: ReadonlyMap<string, TakeAudio>,
): Float32Array {
  const [c0, c1] = chunkSpan(k)
  const out = new Float32Array(CHUNK_SAMPLES)
  for (const seg of segs) {
    const gain = dbToGain(seg.clip.gainDb)
    if (gain === 0 || !overlaps(seg, [c0, c1])) continue
    const take = takes.get(seg.clip.mediaId)
    if (!take) throw new Error(`renderChunk: take ${seg.clip.mediaId} isn't loaded`)
    const a = Math.max(seg.from, c0, 0)
    const b = Math.min(seg.to, c1)
    const src = take.read(sourceSampleAt(seg.clip, a), sourceSampleAt(seg.clip, b))
    for (let t = a; t < b; t++) {
      const v = src[t - a] ?? 0
      if (v !== 0) out[t - c0] = (out[t - c0] ?? 0) + v * gain * envelope(seg, t)
    }
  }
  return out
}

export interface ChunkStart {
  chunk: number
  /** Audio-context time to start the source. */
  when: number
  /** Samples into the chunk to start from (a chunk the playhead is already inside). */
  offsetSamples: number
}

/**
 * Which of `chunks` to start now and how: each chunk's ideal start follows from the anchor; one that has begun starts
 * at `now`, `offsetSamples` in (whole samples, so the join with the next chunk stays exact); one that has ended, or
 * starts after now + horizon, is left out.
 */
export function planChunks(
  anchor: Anchor,
  now: number,
  horizonSec: number,
  chunks: readonly number[],
): ChunkStart[] {
  const out: ChunkStart[] = []
  for (const k of chunks) {
    const ideal = anchor.ctxTime + (k * CHUNK_SAMPLES - anchor.sample) / SAMPLE_RATE
    if (ideal + CHUNK_SAMPLES / SAMPLE_RATE <= now || ideal > now + horizonSec) continue
    const offsetSamples = ideal >= now ? 0 : Math.ceil((now - ideal) * SAMPLE_RATE)
    if (offsetSamples >= CHUNK_SAMPLES) continue
    out.push({ chunk: k, when: ideal + offsetSamples / SAMPLE_RATE, offsetSamples })
  }
  return out
}

/** Where (and whether) each segment's first audible sample lands for an anchor: for tests and telemetry. */
export function segmentStarts(segs: readonly Segment[], anchor: Anchor) {
  return segs.map((seg) => ({
    id: seg.clip.id,
    when: anchor.ctxTime + (seg.from - anchor.sample) / SAMPLE_RATE,
    chunk: Math.floor(Math.max(0, seg.from) / CHUNK_SAMPLES),
    offsetInChunk: Math.max(0, seg.from) % CHUNK_SAMPLES,
    endsAt: clipEnd(seg.clip),
  }))
}

// ---- approximate cleanup

/**
 * A downward expander standing in for the Light chain's spectral gate: below -50 dBFS the level drops 2 dB per dB,
 * at most 18 dB, with a 5 ms attack and 80 ms release. A real spectral gate (FFT per block) is too heavy for an A/B
 * toggle on the main audio thread; this is the same "quiet room noise goes down" effect, and the API says approximate.
 */
export const APPROX_GATE_NAME = 'va-approx-gate'
const GATE_SOURCE = `
const T = -50, RATIO = 2, FLOOR = Math.pow(10, -18 / 20)
class VaApproxGate extends AudioWorkletProcessor {
  constructor() { super(); this.env = 0 }
  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0]
    if (!input || !input.length || !output) return true
    const att = Math.exp(-1 / (0.005 * sampleRate)), rel = Math.exp(-1 / (0.08 * sampleRate))
    for (let i = 0; i < input[0].length; i++) {
      let peak = 0
      for (let c = 0; c < input.length; c++) peak = Math.max(peak, Math.abs(input[c][i]))
      const k = peak > this.env ? att : rel
      this.env = k * this.env + (1 - k) * peak
      const db = 20 * Math.log10(this.env + 1e-9)
      const g = db >= T ? 1 : Math.max(FLOOR, Math.pow(10, ((db - T) * (RATIO - 1)) / 20))
      for (let c = 0; c < output.length; c++) output[c][i] = (input[c] ? input[c][i] : 0) * g
    }
    return true
  }
}
registerProcessor('${APPROX_GATE_NAME}', VaApproxGate)
`

/** The approximate Light chain's settings (high-pass, then a gentle compressor), for the UI and tests. */
export const APPROX_CLEANUP = {
  highpassHz: 80,
  compressor: { ratio: 2, threshold: -24, attack: 0.01, release: 0.12, knee: 4 },
} as const

interface CleanupChain {
  input: AudioNode
  output: AudioNode
}

/** High-pass 80 Hz → compressor 2:1 → the expander worklet (left out where AudioWorklet isn't available). */
async function cleanupChain(ctx: AudioContext): Promise<CleanupChain> {
  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = APPROX_CLEANUP.highpassHz
  const comp = ctx.createDynamicsCompressor()
  const c = APPROX_CLEANUP.compressor
  comp.ratio.value = c.ratio
  comp.threshold.value = c.threshold
  comp.attack.value = c.attack
  comp.release.value = c.release
  comp.knee.value = c.knee
  hp.connect(comp)
  let output: AudioNode = comp
  try {
    // Not in every context (an insecure origin, an old browser), whatever the types say.
    if (typeof AudioWorkletNode !== 'undefined' && (ctx.audioWorklet as AudioWorklet | undefined)) {
      const url = URL.createObjectURL(new Blob([GATE_SOURCE], { type: 'text/javascript' }))
      try {
        await ctx.audioWorklet.addModule(url)
      } finally {
        URL.revokeObjectURL(url)
      }
      const gate = new AudioWorkletNode(ctx, APPROX_GATE_NAME)
      comp.connect(gate)
      output = gate
    }
  } catch {
    // No worklet (old browser, blocked blob: module): high-pass and compressor only.
  }
  return { input: hp, output }
}

// ---- the engine

export interface AuditionStats extends BudgetStats {
  takes: number
  chunks: number
  fetches: number
  decodes: number
  /** Takes read in place as PCM16 WAV (no decodeAudioData). */
  slicedTakes: number
  scheduled: number
}

export interface AuditionOptions {
  /** A take's file bytes by media id (fetch its signed URL). Called again after the take is evicted. */
  loadTake: (mediaId: string) => Promise<ArrayBuffer>
  /** The audio context, created on the first play (that click is the user gesture). */
  createContext?: () => AudioContext
  decode?: Decoder
  budgetBytes?: number
  /** Structured events: one per load, decode, resync and failure. */
  log?: (event: string, fields: Record<string, unknown>) => void
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (id: unknown) => void
}

type Entry = { kind: 'take'; take: TakeAudio } | { kind: 'chunk'; pcm: Float32Array }

/**
 * Plays a NarrationOp against the composition preview's clock. Drive it from the preview: play/pause/seek when the
 * person does, clock() with every bridge `time` message. setOp() whenever the op changes (clips re-render, track
 * levels apply live).
 */
export class NarrationAudition {
  private ctx: AudioContext | null = null
  private bus: GainNode | null = null
  private cleanup: Promise<CleanupChain> | null = null
  private cleanupOn = false
  private op: NarrationOp | null = null
  private segs: Segment[] = []
  /** Bumped whenever the clips (or take lengths) change; rendered chunks are keyed by it. */
  private gen = 0
  private clipsKey = ''
  private readonly cache: LruBudget<Entry>
  private readonly loading = new Map<string, Promise<void>>()
  private readonly sources = new Map<number, AudioBufferSourceNode>()
  private playing = false
  private anchor: Anchor = { sample: 0, ctxTime: 0 }
  /** Composition seconds when paused (or before the context exists). */
  private position = 0
  private drift = 0
  /** Output latency in seconds: the picture is this far behind the sample being started. */
  private latency = 0
  private timer: unknown = null
  private counts = { fetches: 0, decodes: 0 }
  private disposed = false

  constructor(private readonly opts: AuditionOptions) {
    this.cache = new LruBudget<Entry>(opts.budgetBytes ?? DECODE_BUDGET_BYTES)
  }

  /** The op to play and each take's length in samples (as stored; crossfade handles depend on it). */
  setOp(op: NarrationOp | null, takeSamples: ReadonlyMap<string, number>) {
    this.op = op
    const key = op ? JSON.stringify([op.clips, [...takeSamples].sort()]) : ''
    if (key !== this.clipsKey) {
      this.clipsKey = key
      this.segs = op ? segments(op.clips, takeSamples) : []
      this.gen++
      const live = `chunk:${this.gen}:`
      this.cache.deleteWhere((k) => k.startsWith('chunk:') && !k.startsWith(live))
      this.stopSources()
      if (this.playing) this.pump()
      else this.prefetch(this.position)
    }
    this.applyLevel()
  }

  get approxCleanup() {
    return this.cleanupOn
  }

  /** The A/B toggle: route the bus through the approximate cleanup chain, or straight out (raw). */
  async setApproxCleanup(on: boolean) {
    this.cleanupOn = on
    await this.route()
  }

  /** Start playing at composition second `at`; call from the play click so the context may start. */
  async play(at: number) {
    const ctx = this.context()
    if (ctx.state === 'suspended') await ctx.resume()
    this.playing = true
    this.reanchor(at)
    this.timer ??= (this.opts.setInterval ?? setInterval)(() => {
      this.pump()
    }, PUMP_MS)
  }

  pause() {
    if (this.playing) this.position = this.now()
    this.playing = false
    this.stopSources()
    if (this.timer !== null) (this.opts.clearInterval ?? clearInterval)(this.timer as never)
    this.timer = null
  }

  seek(at: number) {
    this.position = Math.max(0, at)
    if (this.playing) this.reanchor(at)
    else this.prefetch(at)
  }

  /** The preview's reported time (bridge `time`): re-anchors on a seek, stall or drift past a frame. */
  clock(time: number) {
    if (!this.playing || !this.ctx) {
      this.position = time
      this.prefetch(time)
      return
    }
    const d = time - this.now()
    this.drift = this.drift * (1 - DRIFT_SMOOTHING) + d * DRIFT_SMOOTHING
    if (Math.abs(d) > RESYNC_SEC || Math.abs(this.drift) > DRIFT_SEC) {
      this.log('audition.resync', { time, driftMs: Math.round(d * 1000) })
      this.reanchor(time)
    } else this.pump()
  }

  /** Loads and renders the window around composition second `at`; resolves when it's playable. */
  async ready(at: number): Promise<void> {
    const span = windowAround(Math.round(at * SAMPLE_RATE))
    const pinned = this.pinnedFor(span)
    const ids = [...sourceRanges(this.segs, span).keys()]
    await Promise.all(ids.map((id) => this.loadTake(id, pinned)))
    if (this.disposed) return
    const gen = this.gen
    const takes = new Map<string, TakeAudio>()
    for (const id of ids) {
      const e = this.cache.get(`take:${id}`)
      if (e?.kind === 'take') takes.set(id, e.take)
    }
    // Ahead of the playhead first: that's what plays next.
    const playhead = Math.floor((at * SAMPLE_RATE) / CHUNK_SAMPLES)
    const chunks = audibleChunks(this.segs, span).sort(
      (x, y) => Number(x < playhead) - Number(y < playhead) || x - y,
    )
    for (const k of chunks) {
      const key = `chunk:${gen}:${k}`
      if (this.cache.has(key)) continue
      const needs = sourceRanges(this.segs, chunkSpan(k))
      if (![...needs.keys()].every((id) => takes.has(id))) continue
      const pcm = renderChunk(this.segs, k, takes)
      this.cache.set(key, { kind: 'chunk', pcm }, pcm.byteLength, pinned)
    }
    this.cache.trim(pinned)
  }

  stats(): AuditionStats {
    const keys = this.cache.keys()
    let sliced = 0
    for (const k of keys) {
      if (!k.startsWith('take:')) continue
      const e = this.cache.get(k)
      if (e?.kind === 'take' && e.take.kind === 'pcm16') sliced++
    }
    return {
      ...this.cache.stats(),
      takes: keys.filter((k) => k.startsWith('take:')).length,
      chunks: keys.filter((k) => k.startsWith('chunk:')).length,
      fetches: this.counts.fetches,
      decodes: this.counts.decodes,
      slicedTakes: sliced,
      scheduled: this.sources.size,
    }
  }

  dispose() {
    this.pause()
    this.disposed = true
    void this.ctx?.close()
    this.ctx = null
  }

  // ---- internals

  private context(): AudioContext {
    if (!this.ctx) {
      this.ctx = this.opts.createContext ? this.opts.createContext() : new AudioContext()
      this.bus = this.ctx.createGain()
      this.applyLevel()
      void this.route()
    }
    return this.ctx
  }

  /** Composition seconds now, from the audio clock while playing. */
  private now(): number {
    if (!this.playing || !this.ctx) return this.position
    const heard = this.anchor.sample / SAMPLE_RATE + (this.ctx.currentTime - this.anchor.ctxTime)
    return heard - this.latency
  }

  /**
   * The picture shows composition second `at` now, so START_LEAD_SEC from now it shows at + START_LEAD_SEC; the
   * sample started then is that time plus the output latency, so the sound leaves the speakers with the picture.
   */
  private reanchor(at: number) {
    const ctx = this.context()
    this.stopSources()
    this.drift = 0
    this.latency = ctx.outputLatency || ctx.baseLatency || 0
    this.anchor = {
      sample: Math.round((Math.max(0, at) + START_LEAD_SEC + this.latency) * SAMPLE_RATE),
      ctxTime: ctx.currentTime + START_LEAD_SEC,
    }
    this.pump()
  }

  /** Starts every rendered chunk due within SCHEDULE_AHEAD_SEC, and keeps the window loading. */
  private pump() {
    const ctx = this.ctx
    const bus = this.bus
    if (!this.playing || !ctx || !bus) return
    const at = this.now()
    this.prefetch(at)
    const due = audibleChunks(
      this.segs,
      windowAround(Math.round(at * SAMPLE_RATE), 0, SCHEDULE_AHEAD_SEC * 2),
    )
    const gen = this.gen
    // Nothing starts sooner than START_LEAD_SEC from now: the chunk already playing joins that far in.
    for (const s of planChunks(this.anchor, ctx.currentTime + START_LEAD_SEC, SCHEDULE_AHEAD_SEC, due)) {
      if (this.sources.has(s.chunk)) continue
      const e = this.cache.get(`chunk:${gen}:${s.chunk}`)
      if (e?.kind !== 'chunk') continue // still loading: it joins late, at an offset, on a later pump
      const buf = ctx.createBuffer(1, CHUNK_SAMPLES, SAMPLE_RATE)
      buf.copyToChannel(e.pcm as Float32Array<ArrayBuffer>, 0)
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(bus)
      src.start(s.when, s.offsetSamples / SAMPLE_RATE)
      src.onended = () => {
        if (this.sources.get(s.chunk) === src) this.sources.delete(s.chunk)
      }
      this.sources.set(s.chunk, src)
    }
  }

  /** ready() in the background; a take that fails to load is logged and retried on the next call. */
  private prefetch(at: number) {
    this.ready(at).catch((err: unknown) => {
      this.log('audition.load_failed', { at, error: String(err) })
    })
  }

  private stopSources() {
    for (const src of this.sources.values()) {
      src.onended = null
      try {
        src.stop()
      } catch {
        // never started
      }
      src.disconnect()
    }
    this.sources.clear()
  }

  /** Track volume and mute, live (solo is the preview mix's job: it silences the iframe). */
  private applyLevel() {
    if (!this.bus || !this.ctx) return
    const n = this.op?.tracks.narration
    const g = !n || n.muted ? 0 : dbToGain(n.volumeDb)
    this.bus.gain.setTargetAtTime(g, this.ctx.currentTime, 0.01)
  }

  private async route() {
    const ctx = this.ctx
    const bus = this.bus
    if (!ctx || !bus) return
    if (this.cleanupOn)
      this.cleanup ??= cleanupChain(ctx).then((c) => {
        c.output.connect(ctx.destination)
        return c
      })
    const chain = this.cleanupOn ? await this.cleanup : null
    if (this.cleanupOn !== !!chain) return // toggled again while the worklet loaded
    bus.disconnect()
    bus.connect(chain ? chain.input : ctx.destination)
  }

  private pinnedFor(span: Span): Set<string> {
    return new Set([
      ...[...sourceRanges(this.segs, span).keys()].map((id) => `take:${id}`),
      ...audibleChunks(this.segs, span).map((k) => `chunk:${this.gen}:${k}`),
    ])
  }

  private loadTake(id: string, pinned: ReadonlySet<string>): Promise<void> {
    const key = `take:${id}`
    if (this.cache.has(key)) {
      this.cache.get(key) // mark used
      return Promise.resolve()
    }
    const pending = this.loading.get(id)
    if (pending) return pending
    const started = Date.now()
    const p = (async () => {
      this.counts.fetches++
      const bytes = await this.opts.loadTake(id)
      let decoded = false
      const take = await takeFromBytes(bytes, async (b) => {
        decoded = true
        this.counts.decodes++
        return (this.opts.decode ?? browserDecoder)(b)
      })
      this.cache.set(key, { kind: 'take', take }, take.bytes, pinned)
      this.log('audition.take_loaded', {
        mediaId: id,
        kind: take.kind,
        decoded,
        bytes: take.bytes,
        ms: Date.now() - started,
      })
    })().finally(() => this.loading.delete(id))
    this.loading.set(id, p)
    return p
  }

  private log(event: string, fields: Record<string, unknown>) {
    this.opts.log?.(event, fields)
  }
}
