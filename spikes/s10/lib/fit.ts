// Spike S10: least-squares line fits and robust averages. Pure; used by the page (online fit, final fit,
// calibration) and by analyze.ts. Sums are kept relative to the first point so 10-minute takes in samples
// (x up to 14.4 M) and perf times in ms do not lose precision.

export interface Line {
  /** y = a + b·x */
  a: number
  b: number
  n: number
}

export class OnlineLine {
  private x0 = 0
  private y0 = 0
  private n = 0
  private sx = 0
  private sy = 0
  private sxx = 0
  private sxy = 0

  add(x: number, y: number): void {
    if (this.n === 0) {
      this.x0 = x
      this.y0 = y
    }
    const dx = x - this.x0
    const dy = y - this.y0
    this.n++
    this.sx += dx
    this.sy += dy
    this.sxx += dx * dx
    this.sxy += dx * dy
  }

  get count(): number {
    return this.n
  }

  line(): Line | null {
    const { n, sx, sy, sxx, sxy } = this
    if (n < 2) return null
    const den = n * sxx - sx * sx
    if (den === 0) return null
    const b = (n * sxy - sx * sy) / den
    const aRel = (sy - b * sx) / n
    return { a: this.y0 + aRel - b * this.x0, b, n }
  }
}

export function fitLine(xs: ArrayLike<number>, ys: ArrayLike<number>): Line | null {
  const o = new OnlineLine()
  for (let i = 0; i < xs.length; i++) o.add(xs[i] ?? 0, ys[i] ?? 0)
  return o.line()
}

export interface Residuals {
  rms: number
  max: number
  /** Index of the largest |residual|. */
  argmax: number
}

export function residuals(l: Line, xs: ArrayLike<number>, ys: ArrayLike<number>): Residuals {
  let ss = 0
  let max = 0
  let argmax = -1
  for (let i = 0; i < xs.length; i++) {
    const r = (ys[i] ?? 0) - (l.a + l.b * (xs[i] ?? 0))
    ss += r * r
    if (Math.abs(r) > max) {
      max = Math.abs(r)
      argmax = i
    }
  }
  return { rms: xs.length ? Math.sqrt(ss / xs.length) : 0, max, argmax }
}

export const median = (v: readonly number[]): number => {
  if (!v.length) return NaN
  const s = [...v].sort((p, q) => p - q)
  const m = s.length >> 1
  return s.length % 2 ? (s[m] ?? NaN) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2
}

export const mean = (v: readonly number[]): number =>
  v.length ? v.reduce((p, q) => p + q, 0) / v.length : NaN

export const stddev = (v: readonly number[]): number => {
  if (v.length < 2) return 0
  const m = mean(v)
  return Math.sqrt(v.reduce((p, q) => p + (q - m) ** 2, 0) / (v.length - 1))
}

export interface RobustMean {
  mean: number
  sd: number
  kept: number
  dropped: number[]
  all: number[]
}

/**
 * Mean after dropping outliers: values more than max(3·MAD·1.4826, floor) from the median are dropped (the floor
 * keeps a tight cluster from rejecting good values). Used for the 8-clap and loopback calibrations.
 */
export function robustMean(v: readonly number[], floor = 5): RobustMean {
  const m = median(v)
  const mad = median(v.map((x) => Math.abs(x - m))) * 1.4826
  const lim = Math.max(3 * mad, floor)
  const keep = v.filter((x) => Math.abs(x - m) <= lim)
  return {
    mean: mean(keep),
    sd: stddev(keep),
    kept: keep.length,
    dropped: v.filter((x) => Math.abs(x - m) > lim),
    all: [...v],
  }
}
