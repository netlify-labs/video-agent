// The pointer trace (screen-recording plan §4.6, §4.7): the cursor and click log written next to a screen recording
// by `video-agent record` (or any tool that writes this schema). Shared by the CLI, Functions, the browser and
// scripts/recording.ts, so it has no Node dependencies. Text in it comes from someone else's page (a button's name,
// a URL path, a redaction reason), so the schema scrubs it where the trace becomes an input: kept to 60 plain
// characters, with email-shaped and long-digit strings replaced by "…" (review R4). Redaction boxes are keyframed so
// they follow scrolling (review R3). Positions are fractions of the frame (0-1); times are seconds into it.
import { z } from 'zod'

export const TRACE_MAX_BYTES = 4 * 1024 * 1024
export const TRACE_LIMITS = {
  moves: 30_000,
  events: 5_000,
  redactEntries: 200,
  redactKeys: 20_000,
  keysPerEntry: 600,
  nameChars: 60,
  pathChars: 200,
} as const

export class TraceError extends Error {}

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g
const LONG_DIGITS = /\d{8,}/g
/** Letters, digits, spaces, the listed punctuation, and the "…" the scrubber itself writes. */
const DISALLOWED = /[^\p{L}\p{N} .,:;!?'"()\-/&+#@…]/gu

/** Replaces every match until none is left (one replacement can expose another, as in a@b.c@d.e). */
function replaceAll(s: string, re: RegExp, by: string) {
  for (let i = 0; i < 100 && re.test(s); i++) {
    re.lastIndex = 0
    s = s.replace(re, by)
  }
  re.lastIndex = 0
  return s
}

/** Text from a page, made safe to show and to give an agent: plain characters, no emails or long numbers, 60 chars. */
export function scrubName(s: string): string {
  let out = s.replace(/\s+/g, ' ').replace(DISALLOWED, '')
  out = replaceAll(replaceAll(out, EMAIL, '…'), LONG_DIGITS, '…')
  return out.replace(/ {2,}/g, ' ').trim().slice(0, TRACE_LIMITS.nameChars).trim()
}

/** A URL path with every segment that holds an email or a long number replaced by "…". */
export function scrubPath(p: string): string {
  return p
    .split('/')
    .map((seg) => {
      EMAIL.lastIndex = 0
      LONG_DIGITS.lastIndex = 0
      const hit = EMAIL.test(seg) || LONG_DIGITS.test(seg)
      EMAIL.lastIndex = 0
      LONG_DIGITS.lastIndex = 0
      return hit ? '…' : seg
    })
    .join('/')
}

const num = z.number().refine(Number.isFinite, 'must be a finite number')
const frac = num.pipe(z.number().min(0).max(1))
const time = num.pipe(z.number().min(0))
const point = z.tuple([frac, frac])
const box = z
  .tuple([frac, frac, frac, frac])
  .refine(([x, y, w, h]) => x + w <= 1 + 1e-9 && y + h <= 1 + 1e-9, 'box must stay inside the frame')
const name = z.string().max(2000).transform(scrubName)

const click = z.strictObject({
  kind: z.literal('click'),
  t: time,
  x: frac,
  y: frac,
  button: z.number().int().min(0).max(4),
  target: z.strictObject({ role: z.string().max(40).transform(scrubName), name, box }).optional(),
})
const type = z.strictObject({
  kind: z.literal('type'),
  t: time,
  end: time,
  box,
  keys: z.number().int().min(0),
})
const scroll = z.strictObject({ kind: z.literal('scroll'), t: time, end: time, dy: num })
const focus = z.strictObject({
  kind: z.literal('focus'),
  t: time,
  box,
  role: z.string().max(40).transform(scrubName).optional(),
})
const drag = z.strictObject({ kind: z.literal('drag'), t: time, end: time, from: point, to: point })
const navigate = z.strictObject({
  kind: z.literal('navigate'),
  t: time,
  path: z
    .string()
    .max(TRACE_LIMITS.pathChars)
    .regex(/^\/[^?#]*$/, 'must be a path starting with / and without ? or #')
    .transform(scrubPath),
})
const event = z.discriminatedUnion('kind', [click, type, scroll, focus, drag, navigate])

const redactKey = z
  .tuple([time, frac, frac, frac, frac])
  .refine(([, x, y, w, h]) => x + w <= 1 + 1e-9 && y + h <= 1 + 1e-9, 'box must stay inside the frame')
const redact = z.strictObject({
  start: time,
  end: time,
  reason: name,
  /** [t, x, y, w, h] keys; w = h = 0 hides the box from t on. */
  boxes: z.array(redactKey).min(1).max(TRACE_LIMITS.keysPerEntry),
})

const sorted = (ts: number[]) => ts.every((t, i, all) => t >= (all[i - 1] ?? t))

export const TraceSchema = z
  .strictObject({
    v: z.literal(1),
    source: z.strictObject({
      kind: z.enum(['cli', 'upload', 'browser', 'script']),
      tool: z.string().max(80),
      startedAt: z.iso.datetime({ offset: true }),
    }),
    frame: z.strictObject({
      width: z.number().int().min(1).max(4096),
      height: z.number().int().min(1).max(4096),
      fps: num.pipe(z.number().min(1).max(120)),
      duration: num.pipe(z.number().min(0).max(300.5)),
    }),
    viewport: z.strictObject({
      width: z.number().int().min(1).max(16384),
      height: z.number().int().min(1).max(16384),
      dpr: num.pipe(z.number().min(0.5).max(4)),
    }),
    moves: z.array(z.tuple([time, frac, frac])).max(TRACE_LIMITS.moves),
    events: z.array(event).max(TRACE_LIMITS.events),
    redact: z.array(redact).max(TRACE_LIMITS.redactEntries),
  })
  .superRefine((t, ctx) => {
    const d = t.frame.duration + 1e-6
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message })
    if (!sorted(t.moves.map((m) => m[0]))) issue(['moves'], 'must be sorted by time')
    t.moves.forEach((m, i) => m[0] > d && issue(['moves', i, 0], 'is past the end of the recording'))
    if (!sorted(t.events.map((e) => e.t))) issue(['events'], 'must be sorted by time')
    t.events.forEach((e, i) => {
      if (e.t > d) issue(['events', i, 't'], 'is past the end of the recording')
      if ('end' in e) {
        if (e.end < e.t) issue(['events', i, 'end'], 'is before t')
        if (e.end > d) issue(['events', i, 'end'], 'is past the end of the recording')
      }
    })
    let keys = 0
    t.redact.forEach((r, i) => {
      keys += r.boxes.length
      if (r.end < r.start) issue(['redact', i, 'end'], 'is before start')
      if (r.end > d) issue(['redact', i, 'end'], 'is past the end of the recording')
      if (!sorted(r.boxes.map((b) => b[0]))) issue(['redact', i, 'boxes'], 'must be sorted by time')
      r.boxes.forEach(
        (b, k) => b[0] > d && issue(['redact', i, 'boxes', k, 0], 'is past the end of the recording'),
      )
    })
    if (keys > TRACE_LIMITS.redactKeys)
      issue(['redact'], `has ${keys} keys in all; at most ${TRACE_LIMITS.redactKeys}`)
  })

export type Trace = z.infer<typeof TraceSchema>
export type RedactEntry = Trace['redact'][number]

/** Checks and normalizes a trace (an object, or its JSON text). Throws TraceError listing each failing field. */
export function parseTrace(json: unknown): Trace {
  let value = json
  if (typeof json === 'string') {
    if (new TextEncoder().encode(json).byteLength > TRACE_MAX_BYTES)
      throw new TraceError(`The trace is larger than ${TRACE_MAX_BYTES / 1024 / 1024} MB.`)
    try {
      value = JSON.parse(json)
    } catch {
      throw new TraceError('The trace is not valid JSON.')
    }
  }
  const r = TraceSchema.safeParse(value)
  if (!r.success)
    throw new TraceError(
      `The trace is not valid: ${r.error.issues
        .slice(0, 20)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
    )
  return r.data
}

/** Normalizes an already-valid trace again (idempotent: normalizing twice equals once). */
export const normalizeTrace = (t: Trace): Trace => parseTrace(t)
