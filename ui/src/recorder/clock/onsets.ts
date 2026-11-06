// A streaming onset detector for claps and clicks (ported from docs/spikes/s10/lib/onsets.ts, docs/spikes.md S10), used by
// the per-route calibration (calibration.ts). Pure; runs on worklet blocks in the page and in Node tests.
//
// x -> 2nd-order high-pass at 1 kHz (removes rumble, the monitor's bed and most speech fundamentals) -> |x| envelope
// (instant attack, 10 ms release). Trigger when the envelope exceeds max(minLevel, ratio · floor), where floor is a
// slow (1 s) average of the envelope outside events. The onset is then refined to the first sample, from LOOKBACK
// before the trigger, whose |high-passed x| reaches 25% of the event's peak within the next WINDOW: for a gated tone
// or a clap that is within a quarter period of the true start (S10: +1 sample on synthetic 2 kHz beeps). A refractory
// period stops one event (a clap's room tail) triggering twice.

export interface OnsetOptions {
  sampleRate: number
  minLevel?: number
  ratio?: number
  refractoryMs?: number
}

export interface Onset {
  /** Sample index in the stream (integer). */
  sample: number
  peak: number
}

export class OnsetDetector {
  readonly onsets: Onset[] = []
  private readonly sr: number
  private readonly minLevel: number
  private readonly ratio: number
  private readonly refractory: number
  private readonly look: number
  private readonly window: number
  private readonly release: number
  private readonly floorK: number
  // biquad state
  private readonly b0: number
  private readonly b1: number
  private readonly b2: number
  private readonly a1: number
  private readonly a2: number
  private x1 = 0
  private x2 = 0
  private y1 = 0
  private y2 = 0
  private env = 0
  private floor = 0
  private n = 0
  private lastOnset = -Infinity
  // ring of |hp| for the look-back + window
  private readonly ring: Float32Array
  private pendingTrigger = -1

  constructor(o: OnsetOptions) {
    this.sr = o.sampleRate
    this.minLevel = o.minLevel ?? 0.02
    this.ratio = o.ratio ?? 8
    this.refractory = Math.round(((o.refractoryMs ?? 150) * this.sr) / 1000)
    this.look = Math.round(0.005 * this.sr)
    this.window = Math.round(0.01 * this.sr)
    this.release = Math.exp(-1 / (0.01 * this.sr))
    this.floorK = 1 - Math.exp(-1 / (1 * this.sr))
    this.ring = new Float32Array(this.look + this.window + 2)
    const w0 = (2 * Math.PI * 1000) / this.sr
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2)
    const cos = Math.cos(w0)
    const a0 = 1 + alpha
    this.b0 = (1 + cos) / 2 / a0
    this.b1 = -(1 + cos) / a0
    this.b2 = (1 + cos) / 2 / a0
    this.a1 = (-2 * cos) / a0
    this.a2 = (1 - alpha) / a0
  }

  push(block: Float32Array): Onset[] {
    const found: Onset[] = []
    const L = this.ring.length
    for (const x of block) {
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
      this.x2 = this.x1
      this.x1 = x
      this.y2 = this.y1
      this.y1 = y
      const ay = Math.abs(y)
      this.ring[this.n % L] = ay
      this.env = ay > this.env ? ay : this.env * this.release
      const thr = Math.max(this.minLevel, this.ratio * this.floor)
      if (this.pendingTrigger < 0) {
        if (this.env > thr && this.n - this.lastOnset > this.refractory) this.pendingTrigger = this.n
        else this.floor += this.floorK * (this.env - this.floor)
      } else if (this.n - this.pendingTrigger >= this.window) {
        const o = this.refine(this.pendingTrigger)
        found.push(o)
        this.onsets.push(o)
        this.lastOnset = o.sample
        this.pendingTrigger = -1
      }
      this.n++
    }
    return found
  }

  private refine(trigger: number): Onset {
    const L = this.ring.length
    const from = Math.max(0, trigger - this.look, this.n - L + 1)
    let peak = 0
    for (let i = from; i <= this.n; i++) peak = Math.max(peak, this.ring[i % L] ?? 0)
    let at = trigger
    for (let i = from; i <= this.n; i++) {
      if ((this.ring[i % L] ?? 0) >= 0.25 * peak) {
        at = i
        break
      }
    }
    return { sample: at, peak }
  }
}
