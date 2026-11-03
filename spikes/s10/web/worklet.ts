// Spike S10: the 'va-recorder' AudioWorkletProcessor. Self-contained (worklets load as their own module).
// Collects mono input in BLOCK-frame blocks and posts each as a transferable Float32Array with the context frame
// index of its first sample, straight to the recorder worker over a MessagePort (never through the main thread).
// Records frame gaps (a render quantum whose currentFrame is not the expected one) and quanta with no input.
// Output is silent; the node is connected through a 0-gain node only so the graph pulls it.

declare const currentFrame: number
declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void

const BLOCK = 2048

class Recorder extends AudioWorkletProcessor {
  private out: MessagePort | null = null
  private recording = false
  private block = new Float32Array(BLOCK)
  private filled = 0
  private blockFrame = 0
  private expected = -1
  private startFrame = -1
  private frames = 0
  private gaps: { at: number; missing: number }[] = []
  private noInput = 0
  private blocks = 0

  constructor() {
    super()
    this.port.onmessage = (e: MessageEvent<{ type: string; port?: MessagePort }>) => {
      const m = e.data
      if (m.type === 'port' && m.port) this.out = m.port
      else if (m.type === 'start') {
        this.recording = true
        this.filled = 0
        this.expected = -1
        this.startFrame = -1
      } else if (m.type === 'stop') {
        if (!this.recording) return
        this.recording = false
        this.flush()
        const end = {
          type: 'end',
          startFrame: this.startFrame,
          frames: this.frames,
          gaps: this.gaps,
          noInput: this.noInput,
          blocks: this.blocks,
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
    this.out?.postMessage({ type: 'block', frame: this.blockFrame, samples }, [samples.buffer])
    this.blocks++
    this.block = new Float32Array(BLOCK)
    this.filled = 0
  }

  process(inputs: Float32Array[][]): boolean {
    if (!this.recording) return true
    const ch = inputs[0]?.[0]
    const n = ch?.length ?? 128
    if (this.startFrame < 0) {
      this.startFrame = currentFrame
      this.port.postMessage({ type: 'started', frame: currentFrame })
    }
    if (this.expected >= 0 && currentFrame !== this.expected)
      this.gaps.push({ at: currentFrame, missing: currentFrame - this.expected })
    this.expected = currentFrame + n
    if (!ch) this.noInput++
    let i = 0
    while (i < n) {
      if (this.filled === 0) this.blockFrame = currentFrame + i
      const take = Math.min(n - i, BLOCK - this.filled)
      if (ch) this.block.set(ch.subarray(i, i + take), this.filled)
      this.filled += take
      i += take
      if (this.filled === BLOCK) this.flush()
    }
    this.frames += n
    return true
  }
}

registerProcessor('va-recorder', Recorder)
export {}
