// The editor's recording panels (screen-recording plan §8.2; va-rsk5.4.4, 4.5), pure parts: the ops a recording scene's
// changes make (span, camera, cursor, redact: the API's own; boxSpan for the person's setup boxes, which belong to the
// whole recording), the speed a span gives its scene, and the camera's Auto and No zoom. The patcher (src/lib/contract.ts) checks every op again; these only say what changed.
import { cameraAt, type CameraKey } from '../../../src/lib/recording'
import { RATE_RANGE } from '../../../src/lib/recording'
import type { paths } from '../api/schema'

type Edit = paths['/api/v1/edits/{id}']['get']['responses'][200]['content']['application/json']
export type Composition = Edit['composition']
export type Beat = Composition['beats'][number]
export type RecordingBeat = NonNullable<Beat['recording']>
type Op = Edit['ops'][number]

/** A scene's own hidden area as the patcher keeps it. */
export interface SceneArea {
  id: string
  origin: 'agent' | 'editor'
  start: number
  end: number
  reason: string
  style?: 'solid'
  boxes: [number, number, number, number, number][]
}

const json = (v: unknown) => JSON.stringify(v)
const near = (a: number, b: number) => Math.abs(a - b) < 1e-4

/** The ops that turn each recording scene of `base` into the one in `cur` (scenes only in one of them are skipped). */
export function recordingOps(base: Composition, cur: Composition): Op[] {
  const ops: Op[] = []
  for (const b of cur.beats) {
    const r = b.recording
    const was = base.beats.find((x) => x.id === b.id)?.recording
    if (!r || !was) continue
    if (!near(r.in, was.in) || !near(r.out, was.out))
      ops.push({ op: 'span', beat: b.id, in: r.in, out: r.out })
    if (json(r.camera) !== json(was.camera)) ops.push({ op: 'camera', beat: b.id, keys: r.camera } as Op)
    if (r.cursor.style !== was.cursor.style || (r.cursor.size ?? 1) !== (was.cursor.size ?? 1))
      ops.push({ op: 'cursor', beat: b.id, style: r.cursor.style, size: r.cursor.size ?? 1 } as Op)
    if (json(r.redact) !== json(was.redact)) ops.push({ op: 'redact', beat: b.id, entries: r.redact } as Op)
  }
  // The person's setup boxes: when each hides (shorten or lengthen; where and how stay).
  const wasSpan = new Map((base.setupBoxes ?? []).map((x) => [x.id, x] as const))
  for (const x of cur.setupBoxes ?? []) {
    const w = wasSpan.get(x.id)
    if (w && (!near(w.start, x.start) || !near(w.end, x.end)))
      ops.push({ op: 'boxSpan', id: x.id, start: x.start, end: x.end })
  }
  return ops
}

/** How fast a scene plays its span: source seconds over the scene's seconds, to 2 places. */
export const speedOf = (r: Pick<RecordingBeat, 'in' | 'out'>, sceneSec: number) =>
  Math.round(((r.out - r.in) / Math.max(0.01, sceneSec)) * 100) / 100

/** The speed's note: amber over 2x, a hold below the slowest rate, refused past the fastest. */
export function speedNote(speed: number): { text: string; tone: 'ok' | 'warn' | 'bad' } {
  if (speed > RATE_RANGE[1])
    return { text: `${String(speed)}x is too fast: shorten the span or lengthen the scene`, tone: 'bad' }
  if (speed > 2) return { text: `${String(speed)}x`, tone: 'warn' }
  if (speed < RATE_RANGE[0])
    return {
      text: `${String(RATE_RANGE[0])}x, then its last frame holds (made when you render)`,
      tone: 'warn',
    }
  return { text: `${String(speed)}x`, tone: 'ok' }
}

/** Auto: the planner's camera for the step, kept to the span (a key at its start when none is). */
export function autoCamera(plan: unknown[] | undefined, r: Pick<RecordingBeat, 'in' | 'out'>): unknown[] {
  const keys = ((plan ?? []) as CameraKey[]).filter((k) => k[0] >= r.in - 1e-3 && k[0] <= r.out + 1e-3)
  if (!keys.length || (keys[0] as CameraKey)[0] > r.in + 1e-3) {
    const [x, y, z] = cameraAt((plan ?? []) as CameraKey[], r.in)
    keys.unshift([r.in, x, y, z])
  }
  return keys
}

/** No zoom: one key, the whole frame. */
export const noZoom = (r: Pick<RecordingBeat, 'in'>): unknown[] => [[r.in, 0.5, 0.5, 1]]

/**
 * The camera with a key at `t` set to (x, y, zoom): an existing key within a frame of `t` is changed, else one is
 * added; keys stay in time order and the centre stays where the frame shows no edge.
 */
export function setCameraKey(camera: unknown[], t: number, x: number, y: number, z: number): unknown[] {
  const zoom = Math.min(4, Math.max(1, z))
  const half = 0.5 / zoom
  const cx = Math.min(1 - half, Math.max(half, x))
  const cy = Math.min(1 - half, Math.max(half, y))
  const keys = structuredClone(camera as CameraKey[])
  const r4 = (n: number) => Math.round(n * 1e4) / 1e4
  const at = keys.findIndex((k) => Math.abs(k[0] - t) < 1 / 30)
  const key: CameraKey = [r4(t), r4(cx), r4(cy), r4(zoom)]
  if (at >= 0) {
    const ease = (keys[at] as CameraKey)[4]
    keys[at] = ease ? [key[0], key[1], key[2], key[3], ease] : key
  } else keys.push([...key, 'power2.inOut'])
  return keys.sort((p, q) => p[0] - q[0])
}

/** The camera at source second `t`: [x, y, zoom]. */
export const cameraNow = (camera: unknown[], t: number) => cameraAt(camera as CameraKey[], t)

/** The scene's areas as the panel lists them; anything malformed is left out (the patcher would refuse it). */
export function sceneAreas(r: RecordingBeat): SceneArea[] {
  return (r.redact as SceneArea[]).filter(
    (e) => typeof e.id === 'string' && Array.isArray(e.boxes) && typeof e.start === 'number',
  )
}

/** A box drawn in the editor: hidden for the whole span by default, blurred. */
export function newArea(
  existing: SceneArea[],
  r: Pick<RecordingBeat, 'in' | 'out'>,
  box: [number, number, number, number],
): SceneArea {
  let n = 1
  while (existing.some((e) => e.id === `e${String(n)}`)) n++
  return {
    id: `e${String(n)}`,
    origin: 'editor',
    start: r.in,
    end: r.out,
    reason: '',
    boxes: [[r.in, ...box]],
  }
}
