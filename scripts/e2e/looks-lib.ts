// Offline helpers for the looks live check (scripts/e2e/looks.ts): comparing a restyle's scene and text ids with its
// parent's, refusing derived colours written as expressions, waiting for a look's catalog hash to change, the credit
// ceiling, and the contact sheet. No network here, so they're unit-tested (app/test/e2e-looks.test.ts).
import { spawnSync } from 'node:child_process'

export interface DraftComposition {
  beats: { id: string; texts: { id: string }[] }[]
  colors: Record<string, string>
}

/** Every way a restyle lost the story's ids (§4.6: scenes in order, beat ids, text ids). Empty when it kept them. */
export function idProblems(before: DraftComposition, after: DraftComposition): string[] {
  const p: string[] = []
  const b = before.beats.map((x) => x.id)
  const a = after.beats.map((x) => x.id)
  for (const id of b) if (!a.includes(id)) p.push(`scene "${id}" is gone`)
  for (const id of a) if (!b.includes(id)) p.push(`scene "${id}" is new`)
  const kept = b.filter((id) => a.includes(id))
  const order = a.filter((id) => b.includes(id))
  if (kept.join() !== order.join())
    p.push(`scenes were reordered: ${kept.join(', ')} became ${order.join(', ')}`)
  const texts = (c: DraftComposition) => new Set(c.beats.flatMap((x) => x.texts.map((t) => t.id)))
  const tb = texts(before)
  const ta = texts(after)
  for (const id of tb) if (!ta.has(id)) p.push(`text "${id}" is gone`)
  return p
}

const LITERAL = /^(#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\([0-9.,%\s/+-]+\)|[a-z]+)$/i

/** Colour roles written as expressions (color-mix(…), var(…)), which the editor's colour picker can't edit. */
export function colorProblems(colors: Record<string, string>): string[] {
  return Object.entries(colors)
    .filter(([, v]) => !LITERAL.test(v.trim()))
    .map(([role, v]) => `--va-color-${role} is ${v}, not a literal colour`)
}

/** Polls `hash()` until it differs from `from`, up to `timeoutMs`; returns the new hash, or null on timeout. */
export async function waitForHashChange(o: {
  from: string
  hash: () => Promise<string | null>
  timeoutMs: number
  intervalMs: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onPoll?: (current: string | null, waitedMs: number) => void
}): Promise<string | null> {
  const now = o.now ?? Date.now
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const start = now()
  for (;;) {
    const current = await o.hash()
    o.onPoll?.(current, now() - start)
    if (current && current !== o.from) return current
    if (now() - start >= o.timeoutMs) return null
    await sleep(o.intervalMs)
  }
}

/** Credits spent so far, runs without a reported cost counted at the estimate; refuses a run past the ceiling. */
export class CreditMeter {
  used = 0
  unknown = 0
  constructor(
    readonly ceiling: number,
    readonly perRun: number,
  ) {}
  get total() {
    return this.used + this.unknown * this.perRun
  }
  record(credits: number | null | undefined) {
    if (typeof credits === 'number') this.used += credits
    else this.unknown++
  }
  /** Whether another run may start: not once the running total has reached the ceiling. */
  canStart() {
    return this.total < this.ceiling
  }
}

/** Six frames of an MP4 side by side, as a PNG (ffmpeg). False when ffmpeg isn't there or fails. */
export function contactSheet(ffmpeg: string, mp4: string, png: string, seconds: number): boolean {
  const fps = `6/${Math.max(1, seconds).toFixed(3)}`
  const r = spawnSync(
    ffmpeg,
    ['-loglevel', 'error', '-y', '-i', mp4, '-vf', `fps=${fps},scale=320:-2,tile=6x1`, '-frames:v', '1', png],
    { encoding: 'utf8' },
  )
  return r.status === 0
}
