// A streaming resampler for the recorder worker, context rate (usually 48 or 44.1 kHz) to 24 kHz (plan 2026-11-02
// §5.1; from spike S10).
//
// Kind: windowed-sinc polyphase with a phase table and linear interpolation between phases (an arbitrary ratio,
// not only 2:1). Cutoff 0.45 x the lower rate (10.8 kHz for 24 kHz out), 16 zero crossings per side, Blackman
// window, PHASES table entries per input sample, every phase normalised to unity DC gain. Linear interpolation
// would alias everything above 12 kHz into the take; this costs about 2 x 2 x 16 / 0.45 = 140 multiply-adds per
// output sample (3.4 M/s at 24 kHz), nothing for a worker.
//
// Timing is exact: output sample j is the signal at input time j x inRate / outRate (integer arithmetic, no
// accumulated phase error), so output index j <-> context frame startFrame + j x inRate / outRate holds for the whole
// take. Pushing in blocks of any size gives the same output as one call (zero-phase: the kernel is centred, the stream
// just waits for HALF input samples of look-ahead; finish() pads with zeros). Output length is
// ceil(inputSamples x outRate / inRate).

const ZEROS = 16
const PHASES = 256

export class Resampler {
  readonly ratio: number
  private readonly half: number
  private readonly table: Float32Array
  private readonly taps: number
  private buf: Float32Array
  private bufStart = 0
  private bufLen = 0
  private inTotal = 0
  private nextOut = 0

  constructor(
    readonly inRate: number,
    readonly outRate: number,
  ) {
    if (!Number.isInteger(inRate) || !Number.isInteger(outRate) || inRate <= 0 || outRate <= 0)
      throw new Error('resample: integer rates')
    this.ratio = outRate / inRate
    const fc = (0.45 * Math.min(inRate, outRate)) / inRate // cycles per input sample
    this.half = Math.ceil(ZEROS / (2 * fc))
    this.taps = 2 * this.half
    // table[p][k], p = 0..PHASES (inclusive, for interpolation), k = 0..taps-1: weight of input (i - half + 1 + k)
    // for an output at input position i + p / PHASES.
    this.table = new Float32Array((PHASES + 1) * this.taps)
    for (let p = 0; p <= PHASES; p++) {
      const frac = p / PHASES
      let sum = 0
      for (let k = 0; k < this.taps; k++) {
        const x = k - this.half + 1 - frac
        const sinc = x === 0 ? 1 : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x * 2 * fc)
        const u = (x + this.half) / (2 * this.half) // 0..1 across the window
        const w =
          u <= 0 || u >= 1 ? 0 : 0.42 - 0.5 * Math.cos(2 * Math.PI * u) + 0.08 * Math.cos(4 * Math.PI * u)
        const v = sinc * w
        this.table[p * this.taps + k] = v
        sum += v
      }
      for (let k = 0; k < this.taps; k++)
        this.table[p * this.taps + k] = (this.table[p * this.taps + k] ?? 0) / sum
    }
    this.buf = new Float32Array(Math.max(8192, 4 * this.taps))
  }

  /** Output samples produced so far. */
  get produced(): number {
    return this.nextOut
  }

  push(block: Float32Array): Float32Array {
    this.append(block)
    this.inTotal += block.length
    return this.run(this.inTotal)
  }

  finish(): Float32Array {
    const want = Math.ceil((this.inTotal * this.outRate) / this.inRate)
    const pad = new Float32Array(this.half + 1)
    this.append(pad)
    const out = this.run(this.inTotal + pad.length, want)
    return out
  }

  private append(block: Float32Array): void {
    if (this.bufLen + block.length > this.buf.length) {
      const next = new Float32Array(Math.max(this.buf.length * 2, this.bufLen + block.length))
      next.set(this.buf.subarray(0, this.bufLen))
      this.buf = next
    }
    this.buf.set(block, this.bufLen)
    this.bufLen += block.length
  }

  /** Produces every output whose kernel lies inside the first `available` inputs (and below `limit`). */
  private run(available: number, limit = Infinity): Float32Array {
    const out: number[] = []
    const { inRate, outRate, half, taps, table } = this
    for (;;) {
      const j = this.nextOut
      if (j >= limit) break
      const num = j * inRate
      const i = Math.floor(num / outRate)
      if (i + half >= available) break
      const fracPos = ((num - i * outRate) / outRate) * PHASES
      const p = Math.floor(fracPos)
      const t = fracPos - p
      const first = i - half + 1 - this.bufStart
      let acc = 0
      const r0 = p * taps
      const r1 = r0 + taps
      for (let k = 0; k < taps; k++) {
        const idx = first + k
        const x = idx >= 0 ? (this.buf[idx] ?? 0) : 0
        const w0 = table[r0 + k] ?? 0
        acc += x * (w0 + t * ((table[r1 + k] ?? 0) - w0))
      }
      out.push(acc)
      this.nextOut++
    }
    // Drop inputs no future output needs.
    const need = Math.floor((this.nextOut * inRate) / outRate) - half + 1
    const drop = Math.min(this.bufLen, Math.max(0, need - this.bufStart))
    if (drop > 0) {
      this.buf.copyWithin(0, drop, this.bufLen)
      this.bufLen -= drop
      this.bufStart += drop
    }
    return Float32Array.from(out)
  }
}
