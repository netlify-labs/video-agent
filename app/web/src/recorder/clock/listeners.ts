// What the calibration hears with (calibration.ts): a ClapListener turns the mic into clap times on performance.now().
// The take recorder (app/web/src/recorder) posts block frames but not samples, so calibration taps the armed stream with
// its own tiny worklet (the mic stream is the same one the take uses, so the route is the same). Onsets are detected
// as blocks arrive and mapped through the AudioClock's render map, like take samples. The loopback runner is
// candidate (a); the synthetic listener drives the mock build's demo and Playwright with no mic.
import type { AudioClock } from './audio-clock'
import { DEFAULT_CALIBRATION, loopbackCalibration, type CalibrationOutcome } from './calibration'
import { OnsetDetector } from './onsets'

export interface ClapListener {
  /** Starts listening (before the first flash). */
  start(): Promise<void>
  /** Told when each flash was shown (perf ms); only the synthetic listener uses it. */
  flash?(shownAt: number): void
  /** Stops listening; the claps it heard, perf ms. */
  stop(): Promise<number[]>
}

// The tap posts each 128-frame quantum with its context frame. Its output goes through a 0-gain node so the graph
// pulls it on every engine.
const TAP_SOURCE = `registerProcessor('va-clock-tap', class extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) this.port.postMessage({ frame: currentFrame, block: ch.slice(0) })
    return true
  }
})`

const loaded = new WeakSet<BaseAudioContext>()

/** Taps `stream` into blocks (Float32 at the context rate) with their first context frame. Returns the untap. */
export async function tapStream(
  ctx: AudioContext,
  stream: MediaStream,
  onBlock: (block: Float32Array, frame: number) => void,
): Promise<() => void> {
  if (!loaded.has(ctx)) {
    const url = URL.createObjectURL(new Blob([TAP_SOURCE], { type: 'text/javascript' }))
    try {
      await ctx.audioWorklet.addModule(url)
      loaded.add(ctx)
    } finally {
      URL.revokeObjectURL(url)
    }
  }
  const src = ctx.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(ctx, 'va-clock-tap', { numberOfInputs: 1, numberOfOutputs: 1 })
  const mute = ctx.createGain()
  mute.gain.value = 0
  src.connect(node).connect(mute).connect(ctx.destination)
  node.port.onmessage = (e: MessageEvent<{ frame: number; block: Float32Array }>) =>
    onBlock(e.data.block, e.data.frame)
  return () => {
    node.port.onmessage = null
    src.disconnect()
    node.disconnect()
    mute.disconnect()
  }
}

/**
 * Hears claps on the armed mic stream. Sample positions come from the first block's frame plus the count since (S10:
 * Chromium's worklet currentFrame glitches by a quantum now and then while the data stays continuous).
 */
export function micClapListener(o: {
  ctx: AudioContext
  stream: MediaStream
  audioClock: AudioClock
}): ClapListener {
  let untap: (() => void) | null = null
  let first = -1
  const det = new OnsetDetector({ sampleRate: o.ctx.sampleRate, refractoryMs: 250 })
  return {
    async start() {
      o.audioClock.start()
      untap = await tapStream(o.ctx, o.stream, (block, frame) => {
        if (first < 0) first = frame
        det.push(block)
      })
    },
    async stop() {
      untap?.()
      untap = null
      det.push(new Float32Array(Math.round(0.02 * o.ctx.sampleRate)))
      return first < 0 ? [] : det.onsets.map((on) => o.audioClock.frameToPerf(first + on.sample))
    },
  }
}

/**
 * (a) Speaker loopback: `clicks` 2 kHz clicks through the speakers, `intervalMs` apart; latency = render-map perf of
 * each captured onset − output-map (getOutputTimestamp) perf of its click.
 */
export async function runLoopback(o: {
  ctx: AudioContext
  stream: MediaStream
  audioClock: AudioClock
  clicks?: number
  intervalMs?: number
}): Promise<CalibrationOutcome> {
  const n = o.clicks ?? DEFAULT_CALIBRATION.clicks
  const gap = (o.intervalMs ?? DEFAULT_CALIBRATION.clickIntervalMs) / 1000
  const listener = micClapListener(o)
  await listener.start()
  const t = o.ctx.currentTime + 0.5
  const at: number[] = []
  for (let k = 0; k < n; k++) {
    const when = t + k * gap
    const osc = o.ctx.createOscillator()
    osc.frequency.value = 2000
    const g = o.ctx.createGain()
    g.gain.setValueAtTime(0, 0)
    g.gain.setValueAtTime(0.5, when)
    g.gain.setValueAtTime(0, when + 0.03)
    osc.connect(g).connect(o.ctx.destination)
    osc.start(when)
    osc.stop(when + 0.05)
    at.push(when)
  }
  await new Promise((r) => setTimeout(r, (t + n * gap - o.ctx.currentTime) * 1000 + 600))
  const onsets = await listener.stop()
  return loopbackCalibration(
    at.map((c) => o.audioClock.outputContextToPerf(c)),
    onsets,
  )
}

/**
 * The mock build's listener: a "clap" `latencyMs` after each flash with deterministic jitter, one far outlier and
 * optional misses, so the panel's whole flow runs without a mic.
 */
export function syntheticClapListener(o: {
  latencyMs: number
  jitterMs?: number
  outlierMs?: number
  miss?: number[]
}): ClapListener {
  let claps: number[] = []
  let k = 0
  return {
    async start() {
      claps = []
      k = 0
    },
    flash(shownAt) {
      const i = k++
      if (o.miss?.includes(i)) return
      const jitter = (((i * 7919) % 11) / 10 - 0.5) * 2 * (o.jitterMs ?? 3)
      claps.push(shownAt + o.latencyMs + jitter + (i === 2 ? (o.outlierMs ?? 300) : 0))
    },
    async stop() {
      return claps
    },
  }
}
