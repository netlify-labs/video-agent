// WebMCP (https://webmachinelearning.github.io/webmcp/): tools a browser agent calls through document.modelContext to
// drive this app's UI. This file holds what every tool shares: the result shapes (JSON-serialized by the browser), the
// name rule, and a small JSON Schema check, so a tool refuses bad input with a message an agent can act on.

/** What a tool returns. A failure says what went wrong and what to do instead; it never throws at the agent. */
export type ToolResult = { ok: true } & Record<string, unknown>
export interface ToolFailure {
  ok: false
  error: { code: string; message: string; fix?: string }
}

export const ok = (data: Record<string, unknown> = {}): ToolResult => ({ ok: true, ...data })
export const fail = (code: string, message: string, fix?: string): ToolFailure => ({
  ok: false,
  error: { code, message, ...(fix ? { fix } : {}) },
})

/** The spec's name rule: 1 to 128 characters, ASCII letters and digits, '_', '-' and '.'. */
export const isToolName = (name: string): boolean => /^[A-Za-z0-9_.-]{1,128}$/.test(name)

/** The JSON Schema subset the tools use for input. */
export interface InputSchema {
  type: 'object'
  properties: Record<string, PropertySchema>
  required?: string[]
  additionalProperties?: false
}
export type PropertySchema = {
  description?: string
} & (
  | { type: 'string'; enum?: readonly string[]; minLength?: number; maxLength?: number }
  | { type: 'number' | 'integer'; minimum?: number; maximum?: number }
  | { type: 'boolean' }
  | { type: 'array'; items: PropertySchema; minItems?: number; maxItems?: number }
  | { type: ['string', 'null']; enum?: readonly (string | null)[]; maxLength?: number }
)

const typeOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v

function check(path: string, s: PropertySchema, v: unknown, out: string[]) {
  const types = Array.isArray(s.type) ? s.type : [s.type]
  const t = typeOf(v)
  const fits = types.some((x) => x === t || (x === 'number' && t === 'integer'))
  if (!fits) {
    out.push(`${path} must be ${types.join(' or ')}, not ${t}.`)
    return
  }
  // The bounds each type may carry, read through one loose view.
  const b = s as {
    enum?: readonly unknown[]
    minLength?: number
    maxLength?: number
    minimum?: number
    maximum?: number
  }
  if (b.enum && !b.enum.includes(v))
    out.push(`${path} must be one of ${b.enum.map((e) => JSON.stringify(e)).join(', ')}.`)
  if (typeof v === 'string') {
    if (b.minLength !== undefined && v.length < b.minLength)
      out.push(`${path} must be at least ${String(b.minLength)} characters.`)
    if (b.maxLength !== undefined && v.length > b.maxLength)
      out.push(`${path} must be at most ${String(b.maxLength)} characters.`)
  }
  if (typeof v === 'number') {
    if (b.minimum !== undefined && v < b.minimum) out.push(`${path} must be at least ${String(b.minimum)}.`)
    if (b.maximum !== undefined && v > b.maximum) out.push(`${path} must be at most ${String(b.maximum)}.`)
  }
  if (Array.isArray(v) && s.type === 'array') {
    if (s.minItems !== undefined && v.length < s.minItems)
      out.push(`${path} must have at least ${String(s.minItems)} items.`)
    if (s.maxItems !== undefined && v.length > s.maxItems)
      out.push(`${path} must have at most ${String(s.maxItems)} items.`)
    v.forEach((item, i) => {
      check(`${path}[${String(i)}]`, s.items, item, out)
    })
  }
}

/** Every problem with an input, as sentences naming the field; [] when it fits the schema. */
export function inputProblems(schema: InputSchema, input: unknown): string[] {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    return ['The input must be an object.']
  const out: string[] = []
  const obj = input as Record<string, unknown>
  for (const key of schema.required ?? []) if (obj[key] === undefined) out.push(`${key} is required.`)
  for (const [key, v] of Object.entries(obj)) {
    const s = schema.properties[key]
    if (!s) {
      out.push(
        `${key} isn't an input of this tool; it takes ${Object.keys(schema.properties).join(', ') || 'nothing'}.`,
      )
      continue
    }
    if (v !== undefined) check(key, s, v, out)
  }
  return out
}

/** An input-check failure, listing every problem so an agent can fix them all in one try. */
export const invalidInput = (problems: string[]): ToolFailure =>
  fail('invalid_input', problems.join(' '), 'Fix the input and call the tool again.')
