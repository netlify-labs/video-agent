// The recording-scene check (screen-recording plan §5.2 check; va-rsk5.3.7): the guard that keeps hidden areas from
// disappearing and the data files from becoming code. recording.ts check and check-contract run it in a run, and
// finalize runs the same function on the server. Locked hidden areas are compared with the run's INPUTS (the trace's
// redact entries t1… and the person's setup boxes s1…), never with labels in the HTML, so relabelling an entry
// doesn't unlock it. The contract (contract.ts validate) checks the slot's own attributes; this checks what they name.
import { load, read } from './contract.js'
import {
  CAMERA_MAX_KEYS,
  LOCKED_SRC,
  RATE_RANGE,
  cursorSrc,
  parseCursorScript,
  parseRedactScript,
  rateInRange,
  rateOf,
} from './recording.js'
import type { RedactEntry } from './recording-trace.js'

export interface RecordingProblem {
  scene: string
  rule: string
  message: string
}

export interface RecordingCheckInput {
  html: string
  /** A composition file's text by path relative to video/, or null when it isn't there. */
  readFile: (path: string) => string | null
  /** The run's recording: its file name in assets/media/ and the source length (from the analysis), when known. */
  recording: { filename: string; durationSec?: number | undefined } | null
  /** The locked inputs: the trace's redact entries and the person's setup boxes, in that order. Null: not known. */
  locked: { trace: RedactEntry[]; setup: RedactEntry[] } | null
  /** Hold stills a render-unchanged run makes itself (recording.ts emit --holds-only): present-but-pending. */
  pendingStills?: readonly string[]
  /** A render-unchanged run: the person set the spans in the editor, so a held end needs no voice line or retime. */
  edited?: boolean
}

const TOL = 1e-3
const near = (a: number, b: number) => Math.abs(a - b) <= TOL
const frac = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

/** A keyframed box entry: [t, x, y, w, h] keys inside the frame, sorted, start <= end. */
function boxEntryProblem(e: unknown): string | null {
  if (!e || typeof e !== 'object') return "isn't an object"
  const r = e as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return 'needs an id'
  if (!finite(r.start) || !finite(r.end) || r.end < r.start) return 'needs start and end, start first'
  if (!Array.isArray(r.boxes) || !r.boxes.length) return 'needs boxes'
  let last = -Infinity
  for (const k of r.boxes as unknown[]) {
    if (!Array.isArray(k) || k.length !== 5 || !finite(k[0]) || !k.slice(1).every(frac))
      return "has a key that isn't [t, x, y, w, h]"
    const [t, x, y, w, h] = k as number[]
    if ((x ?? 0) + (w ?? 0) > 1 + 1e-9 || (y ?? 0) + (h ?? 0) > 1 + 1e-9) return 'has a box outside the frame'
    if ((t ?? 0) < last) return 'has keys out of time order'
    last = t ?? 0
  }
  return null
}

/** Every problem with the composition's recording scenes; empty when there are none or they all pass. */
export function recordingCheck(input: RecordingCheckInput): RecordingProblem[] {
  const problems: RecordingProblem[] = []
  const add = (scene: string, rule: string, message: string) => problems.push({ scene, rule, message })
  const beats = read(load(input.html)).beats.filter((b) => b.recording)
  if (!beats.length) return problems

  // The locked hidden areas: redact.js exactly in its form, every input entry present with the same keys.
  const lockedText = input.readFile(LOCKED_SRC)
  const parsed = lockedText === null ? null : parseRedactScript(lockedText)
  if (!parsed) add('*', 'locked-file', `${LOCKED_SRC} is missing; run recording.ts emit to write it.`)
  else if (!parsed.ok)
    add('*', 'locked-file', `${LOCKED_SRC} ${parsed.reason}; run recording.ts emit to rewrite it.`)
  else if (input.locked) {
    const expected = [
      ...input.locked.trace.map((e, i) => ({ ...e, id: `t${String(i + 1)}` })),
      ...input.locked.setup.map((e, i) => ({ ...e, id: `s${String(i + 1)}` })),
    ]
    for (const want of expected) {
      const got = parsed.entries.find((e) => e.id === want.id)
      if (!got) {
        add('*', 'locked-missing', `Hidden area ${want.id} ("${want.reason}") was removed; it can't be.`)
        continue
      }
      const same =
        near(got.start, want.start) &&
        near(got.end, want.end) &&
        got.boxes.length === want.boxes.length &&
        got.boxes.every((k, i) => k.every((n, j) => near(n, want.boxes[i]?.[j] ?? NaN)))
      if (!same)
        add(
          '*',
          'locked-changed',
          `Hidden area ${want.id} ("${want.reason}") was moved, shrunk or retimed; it can't be.`,
        )
    }
  }
  const lockedIds = new Set(parsed?.ok ? parsed.entries.map((e) => e.id) : [])

  for (const b of beats) {
    const r = b.recording
    if (!r) continue
    const scene = b.id
    if (input.recording && r.src !== `assets/media/${input.recording.filename}`)
      add(
        scene,
        'slot-src',
        `The recording slot must show this run's recording, assets/media/${input.recording.filename}.`,
      )
    const dur = input.recording?.durationSec
    if (!(r.in >= 0) || !(r.out > r.in) || (dur !== undefined && r.out > dur + TOL))
      add(
        scene,
        'range',
        `in and out must be inside the recording (0-${dur === undefined ? '?' : String(dur)} s), in first.`,
      )
    const slotSec = r.hold ? b.duration - r.hold.seconds : b.duration
    if (!rateInRange(r.rate))
      add(
        scene,
        'rate',
        `It plays at ${String(r.rate)}x; between ${String(RATE_RANGE[0])}x and ${String(RATE_RANGE[1])}x only.`,
      )
    else if (slotSec > 0 && Math.abs(r.rate - rateOf(r.in, r.out, slotSec)) > 1e-4)
      add(
        scene,
        'rate',
        `data-playback-rate must be ${String(rateOf(r.in, r.out, slotSec))} (its span over its length).`,
      )

    // Camera: numbers, inside the frame, in time order, inside in..out, at most 64.
    const keys = r.camera
    if (keys.length > CAMERA_MAX_KEYS)
      add(scene, 'camera', `It has ${String(keys.length)} camera keys; at most ${String(CAMERA_MAX_KEYS)}.`)
    let last = -Infinity
    for (const [i, k] of keys.entries()) {
      const ok =
        Array.isArray(k) &&
        (k.length === 4 || (k.length === 5 && typeof k[4] === 'string')) &&
        finite(k[0]) &&
        frac(k[1]) &&
        frac(k[2]) &&
        finite(k[3]) &&
        k[3] >= 1 &&
        k[3] <= 8
      if (!ok) {
        add(scene, 'camera', `Camera key ${String(i + 1)} isn't [t, x, y, zoom, ease?] inside the frame.`)
        continue
      }
      const t = k[0] as number
      if (t < last) add(scene, 'camera', 'Camera keys must be in time order.')
      if (t < r.in - TOL || t > r.out + TOL)
        add(scene, 'camera', `Camera key ${String(i + 1)} is outside in..out.`)
      last = t
    }
    for (const [i, c] of r.clicks.entries())
      if (
        !Array.isArray(c) ||
        c.length !== 3 ||
        !finite(c[0]) ||
        !frac(c[1]) ||
        !frac(c[2]) ||
        c[0] < r.in - TOL ||
        c[0] > r.out + TOL
      )
        add(scene, 'clicks', `Click ${String(i + 1)} isn't [t, x, y] inside in..out.`)

    // The cursor file: exactly the one statement emit writes. Its points may run past in..out: the editor's span op
    // narrows the span without rewriting the file, and the runtime plays only the points inside it.
    if (r.cursor.style !== 'none' || r.cursor.path) {
      const step = r.cursor.path ?? ''
      const text = step ? input.readFile(cursorSrc(step)) : null
      if (text === null)
        add(scene, 'cursor-file', `data-va-path must name an existing ${cursorSrc(step || r.step)}.`)
      else {
        const c = parseCursorScript(text, step)
        if (!c.ok)
          add(scene, 'cursor-file', `${cursorSrc(step)} ${c.reason}; run recording.ts emit to rewrite it.`)
      }
    }

    if (r.locked !== LOCKED_SRC)
      add(scene, 'locked-ref', `Its hidden areas must load the locked ones (data-va-locked="${LOCKED_SRC}").`)
    const ids = new Set<string>()
    for (const [i, e] of r.redact.entries()) {
      const p = boxEntryProblem(e)
      if (p) add(scene, 'redact', `Hidden area ${String(i + 1)} ${p}.`)
      const id = (e as { id?: unknown }).id
      if (typeof id === 'string') {
        if (ids.has(id) || lockedIds.has(id)) add(scene, 'redact', `Hidden area id "${id}" is used twice.`)
        ids.add(id)
      }
    }

    if (r.hold) {
      const retimed = Math.abs(b.duration - b.authoredDuration) > TOL
      if (!b.voice && !retimed && !input.edited)
        add(
          scene,
          'hold',
          'A held frame is only for a scene with a voice line or a retime; shorten the scene instead.',
        )
      const still = `assets/recording/${r.step}.hold.jpg`
      if (input.readFile(still) === null && !input.pendingStills?.includes(still))
        add(
          scene,
          'hold',
          `Its still ${still} is missing; run recording.ts emit --duration (or --holds-only).`,
        )
      const lastKey = keys.at(-1)
      if (Array.isArray(lastKey) && finite(lastKey[0]) && lastKey[0] > r.out + TOL)
        add(scene, 'hold', 'Its last camera key must be at or before out.')
    }
  }
  return problems
}
