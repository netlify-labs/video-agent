// Screen-recording demos (screen-recording plan §5.1-5.3): the plan the run's agent works from, and the arithmetic every
// side shares (scripts/recording.ts, the contract, finalize, the editor and the UI copy). No Node dependencies.
// Camera keys and clicks are in SOURCE seconds, so retiming a scene changes its speed without re-keying anything. A
// step's speed is never stored: it's (out - in) / duration wherever it's needed.
import type { RedactEntry } from './recording-trace.js'

/** The slowest and fastest a recording scene may play (review A12): one constant for every side. */
export const RATE_RANGE = [0.5, 4] as const
export const ZOOM_DEFAULT_MAX = 2.2
/** The least a zoomed-in camera zooms (the most is the Look's zoomMax). */
export const ZOOM_MIN = 1.4
export const CAMERA_MAX_KEYS = 64
export const ASPECTS = ['16:9', '9:16', '1:1', '4:5'] as const
export type Aspect = (typeof ASPECTS)[number]

/** [t, x, y, zoom, ease?]: source seconds, the frame point at the centre (0-1), zoom (1 = the whole recording). */
export type CameraKey = [number, number, number, number] | [number, number, number, number, string]
/** [t, x, y]: source seconds, frame fractions. */
export type ClickKey = [number, number, number]
export type PlanRedact = RedactEntry & { id: string }

export interface PlanStep {
  id: string
  in: number
  out: number
  camera: CameraKey[]
  clicks: ClickKey[]
  /** The first clicked element (from the recorded app): only in .va-run's copy, never in the kept plan. */
  focus?: { role: string; name: string }
  idleSpedUp: { start: number; end: number }[]
  /** The agent's and the editor's hidden areas for this step; the trace's and the person's are in `locked`. */
  redact: PlanRedact[]
  hold?: boolean
}

export interface PlanV1 {
  v: 1
  mediaId: string
  sha256: string
  frame: { width: number; height: number }
  aspect: Aspect
  zoomMax: number
  frameStyle: 'wallpaper' | 'none'
  /** Every hidden area from the trace (t1…) and the person's setup boxes (s1…), whole: never clipped or changed. */
  locked: PlanRedact[]
  steps: PlanStep[]
  dropped: { start: number; end: number; why: string }[]
  /** Seconds the planner proposes, in all and per step id. */
  estimate: { seconds: number; steps: Record<string, number> }
}

export const round4 = (n: number) => Math.round(n * 1e4) / 1e4

/** Source seconds `s` as seconds into a scene of `authored` seconds that shows `inS`..`outS`. */
export const authoredTime = (s: number, inS: number, outS: number, authored: number) =>
  ((s - inS) / (outS - inS)) * authored

/** The playback rate of a slot of `slotSec` seconds that shows `inS`..`outS`, to 4 places. */
export const rateOf = (inS: number, outS: number, slotSec: number) => round4((outS - inS) / slotSec)

export const rateInRange = (rate: number) => rate >= RATE_RANGE[0] - 1e-9 && rate <= RATE_RANGE[1] + 1e-9

export const clampRate = (rate: number) => Math.min(RATE_RANGE[1], Math.max(RATE_RANGE[0], rate))

/** The plan as the composition keeps it: every `focus` (a name from the recorded app) removed. */
export function keptPlan(plan: PlanV1): PlanV1 {
  return {
    ...plan,
    steps: plan.steps.map((s) => {
      const copy = { ...s }
      delete copy.focus
      return copy
    }),
  }
}

/**
 * The camera at source time `t`: [x, y, zoom], linear between keys (a planning approximation of the eased tween),
 * held before the first key and after the last.
 */
export function cameraAt(keys: CameraKey[], t: number): [number, number, number] {
  const first = keys[0]
  if (!first) return [0.5, 0.5, 1]
  if (t <= first[0]) return [first[1], first[2], first[3]]
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1] as CameraKey
    const b = keys[i] as CameraKey
    if (t <= b[0]) {
      const k = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 1
      return [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k]
    }
  }
  const last = keys.at(-1) as CameraKey
  return [last[1], last[2], last[3]]
}

// ───── data files (§5.2 emit, review R8) ─────
// A composition can't fetch, so a scene's cursor path and the recording's locked hidden areas are scripts loaded with
// <script src>. The preview runs them, so each must be data in exactly one form: one statement, JSON with at most 4
// decimals, nothing else. emit writes them; check and finalize read them back with these parsers.
export const CURSOR_MAX_POINTS = 6000
export const LOCKED_SRC = 'assets/recording/redact.js'
export const cursorSrc = (step: string) => `assets/recording/${step}.cursor.js`
export const STEP_ID = /^[a-z0-9-]{1,40}$/

export type LockedEntry = RedactEntry & { id: string; origin: 'trace' | 'setup' }

/** Numbers to 4 places, arrays and plain objects only (no other JSON can reach the data files). */
const json4 = (v: unknown) =>
  JSON.stringify(v, (_k, x: unknown) => (typeof x === 'number' ? round4(x) + 0 : x))

export function cursorScript(step: string, points: ClickKey[]): string {
  if (!STEP_ID.test(step)) throw new Error(`Step id "${step}" must be lowercase letters, digits and dashes.`)
  return `window.__vaCursor=window.__vaCursor||{};window.__vaCursor["${step}"]=${json4(points)};`
}

export const redactScript = (entries: LockedEntry[]) => `window.__vaRedact=${json4(entries)};`

const finite4 = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && round4(n) === n

/**
 * The cursor path in a <step>.cursor.js, or the reason it isn't exactly the form emit writes: [t, x, y] finite
 * numbers to 4 places, sorted by t, x and y in 0-1, inside in..out when given, at most 6,000 points.
 */
export function parseCursorScript(
  text: string,
  step: string,
  span?: { in: number; out: number },
): { ok: true; points: ClickKey[] } | { ok: false; reason: string } {
  const head = `window.__vaCursor=window.__vaCursor||{};window.__vaCursor["${step}"]=`
  const body = text.trimEnd()
  if (!body.startsWith(head) || !body.endsWith(';'))
    return { ok: false, reason: `isn't the one statement emit writes for step "${step}"` }
  let points: unknown
  try {
    points = JSON.parse(body.slice(head.length, -1))
  } catch {
    return { ok: false, reason: "its path isn't JSON" }
  }
  if (!Array.isArray(points)) return { ok: false, reason: "its path isn't an array" }
  if (points.length > CURSOR_MAX_POINTS)
    return { ok: false, reason: `has more than ${CURSOR_MAX_POINTS} points` }
  let last = -Infinity
  for (const p of points as unknown[]) {
    if (!Array.isArray(p) || p.length !== 3 || !p.every(finite4))
      return { ok: false, reason: "has a point that isn't [t, x, y] numbers to 4 places" }
    const [t, x, y] = p as ClickKey
    if (t < last) return { ok: false, reason: "isn't sorted by time" }
    if (x < 0 || x > 1 || y < 0 || y > 1) return { ok: false, reason: 'has a point outside the frame' }
    if (span && (t < span.in - 1e-4 || t > span.out + 1e-4))
      return {
        ok: false,
        reason: `has a point at ${String(t)} s, outside ${String(span.in)}-${String(span.out)}`,
      }
    last = t
  }
  return { ok: true, points: points as ClickKey[] }
}

/** The locked entries in redact.js, or the reason it isn't exactly the form emit writes. */
export function parseRedactScript(
  text: string,
): { ok: true; entries: LockedEntry[] } | { ok: false; reason: string } {
  const head = 'window.__vaRedact='
  const body = text.trimEnd()
  if (!body.startsWith(head) || !body.endsWith(';'))
    return { ok: false, reason: "isn't the one statement emit writes" }
  let entries: unknown
  try {
    entries = JSON.parse(body.slice(head.length, -1))
  } catch {
    return { ok: false, reason: "isn't JSON" }
  }
  if (!Array.isArray(entries)) return { ok: false, reason: "isn't an array" }
  for (const e of entries as unknown[]) {
    if (!e || typeof e !== 'object') return { ok: false, reason: "has an entry that isn't an object" }
    const r = e as Record<string, unknown>
    const keys = Array.isArray(r.boxes) ? (r.boxes as unknown[]) : null
    if (
      typeof r.id !== 'string' ||
      (r.origin !== 'trace' && r.origin !== 'setup') ||
      !finite4(r.start) ||
      !finite4(r.end) ||
      typeof r.reason !== 'string' ||
      !keys?.length ||
      !keys.every((k) => Array.isArray(k) && k.length === 5 && k.every(finite4))
    )
      return { ok: false, reason: "has an entry that isn't { id, origin, start, end, reason, boxes }" }
  }
  return { ok: true, entries: entries as LockedEntry[] }
}
