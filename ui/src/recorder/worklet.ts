// The 'va-recorder' AudioWorkletProcessor (plan 2026-11-02 §5.1; from spike S10). Self-contained: a worklet loads as
// its own module, with no imports. It collects mono input in BLOCK-frame blocks and posts each one as a transferable
// Float32Array, with the context frame of its first sample, straight to the recorder worker over a MessagePort (never
// through the main thread). Recording starts at the first quantum at or after `atFrame` (trimming that quantum, so
// the first sample is exactly atFrame when it is in the future) and stops at the 'stop' message.
// To the main thread it posts 'started' (the first frame), and when asked, block metadata (for the sync clock) and
// RMS/peak levels (for a meter); levels are measured whether or not a take is recording.
// Output is silent; the node is connected through a 0-gain node only so the graph pulls it.

declare const currentFrame: number
declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void

const BLOCK = 2048

type Control =
  | { type: 'port'; port: MessagePort }
  | { type: 'start'; atFrame?: number }
  | { type: 'stop' }
  | { type: 'observe'; levels: boolean; blocks: boolean }

class Recorder extends AudioWorkletProcessor {
  private out: MessagePort | null = null
  private recording = false
  private stopped = false
  private atFrame = 0
  private block = new Float32Array(BLOCK)
  private filled = 0
  private blockFrame = 0
  private startFrame = -1
  private frames = 0
  private blocks = 0
  private noInput = 0
  private levels = false
  private blockEvents = false
  private levelSum = 0
  private levelPeak = 0
  private levelFrames = 0

  constructor() {
    super()
    this.port.onmessage = (e: MessageEvent<Control>) => {
      const m = e.data
      if (m.type === 'port') this.out = m.port
      else if (m.type === 'observe') {
        this.levels = m.levels
        this.blockEvents = m.blocks
      } else if (m.type === 'start') {
        if (this.recording || this.stopped) return
        this.recording = true
        this.atFrame = m.atFrame ?? 0
      } else {
        if (!this.recording) return
        this.recording = false
        this.stopped = true
        this.flush()
        const end = {
          type: 'end',
          startFrame: this.startFrame,
          frames: this.frames,
          blocks: this.blocks,
          noInput: this.noInput,
          sampleRate,
        }
        this.out?.postMessage(end)
        this.port.postMessage(end)
      }
    }
  }

  private flush(): void {
    if (this.filled === 0) return
    const samples = this.filled === BLOCK ? this.block : this.block.slice(0, this.filled)
    if (this.blockEvents)
      this.port.postMessage({ type: 'block', frame: this.blockFrame, length: this.filled })
    this.out?.postMessage({ type: 'block', frame: this.blockFrame, samples }, [samples.buffer])
    this.blocks++
    this.block = new Float32Array(BLOCK)
    this.filled = 0
  }

  private meter(ch: Float32Array | undefined, n: number): void {
    if (ch)
      for (const v of ch) {
        this.levelSum += v * v
        const a = v < 0 ? -v : v
        if (a > this.levelPeak) this.levelPeak = a
      }
    this.levelFrames += n
    if (this.levelFrames < BLOCK) return
    this.port.postMessage({
      type: 'level',
      rms: Math.sqrt(this.levelSum / this.levelFrames),
      peak: this.levelPeak,
    })
    this.levelSum = 0
    this.levelPeak = 0
    this.levelFrames = 0
  }

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0]
    const n = ch?.length ?? 128
    if (this.levels) this.meter(ch, n)
    if (!this.recording || currentFrame + n <= this.atFrame) return true
    const from = Math.max(0, this.atFrame - currentFrame)
    if (this.startFrame < 0) {
      this.startFrame = currentFrame + from
      this.port.postMessage({ type: 'started', frame: this.startFrame })
    }
    if (!ch) this.noInput++
    let i = from
    while (i < n) {
      if (this.filled === 0) this.blockFrame = currentFrame + i
      const take = Math.min(n - i, BLOCK - this.filled)
      if (ch) this.block.set(ch.subarray(i, i + take), this.filled)
      this.filled += take
      i += take
      if (this.filled === BLOCK) this.flush()
    }
    this.frames += n - from
    return true
  }
}

registerProcessor('va-recorder', Recorder)
export {}
