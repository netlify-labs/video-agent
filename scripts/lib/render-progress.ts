// Render progress from `hyperframes render` (plan v2 §6 A2): it prints machine lines like
//   @hf-progress {"code":"capture","done":40,"total":150,"pct":45}
// render-job reports them through the checkpoint endpoint, rate-limited well under its 10-a-minute bound.

/** The overall percent from one output line, or null for any other line. */
export function parseRenderProgress(line: string): number | null {
  const i = line.indexOf('@hf-progress ')
  if (i < 0) return null
  try {
    const p = (JSON.parse(line.slice(i + '@hf-progress '.length)) as { pct?: unknown }).pct
    return typeof p === 'number' && p >= 0 && p <= 100 ? Math.floor(p) : null
  } catch {
    return null
  }
}

/** Decides which percentages to send: never backwards, at least `minGapMs` apart, and only real moves. */
export class RenderProgressReporter {
  private last = -1
  private lastAt = -Infinity
  /** A line split across output chunks waits here for its end. */
  private partial = ''
  constructor(
    private readonly send: (pct: number) => void,
    private readonly now: () => number = Date.now,
    private readonly minGapMs = 10_000,
    private readonly minStep = 5,
  ) {}

  line(text: string) {
    const lines = (this.partial + text).split(/\r|\n/)
    this.partial = lines.pop() ?? ''
    for (const l of lines) {
      const pct = parseRenderProgress(l)
      if (pct !== null) this.progress(pct)
    }
  }

  /** A percent an engine already parsed (scripts/lib/engines/), through the same rules. */
  progress(pct: number) {
    if (pct <= this.last) return
    const t = this.now()
    if (pct - this.last < this.minStep && pct < 100) return
    if (t - this.lastAt < this.minGapMs && pct < 100) return
    this.last = pct
    this.lastAt = t
    this.send(pct)
  }

  /** Flushes a last line that had no newline. */
  end() {
    if (this.partial) this.line('\n')
  }
}
