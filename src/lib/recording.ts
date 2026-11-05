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
