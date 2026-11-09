// Options forms for publish destinations (docs/plans/2026-11-04-publish-destinations.md §6.3): a small JSON-Schema
// subset an HTTP destination can declare, so the Publish dialog can render it and the server can check it without a
// new dependency. v1: an object of at most 10 string or boolean properties.

export interface StringOption {
  type: 'string'
  title?: string
  description?: string
  maxLength?: number
  enum?: string[]
  default?: string
}
export interface BooleanOption {
  type: 'boolean'
  title?: string
  description?: string
  default?: boolean
}
export type OptionSpec = StringOption | BooleanOption

export interface OptionsSchema {
  type: 'object'
  properties: Record<string, OptionSpec>
  required?: string[]
}

export const OPTIONS_MAX = 10
const STRING_MAX = 2000

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Checks an admin-supplied options schema; errors name the path that's wrong. */
export function parseOptionsSchema(raw: unknown): Parsed<OptionsSchema> {
  if (!isObj(raw)) return { ok: false, error: 'The options form must be a JSON object.' }
  const extra = Object.keys(raw).filter((k) => !['type', 'properties', 'required'].includes(k))
  if (extra.length) return { ok: false, error: `Unknown key "${extra[0]}" at the top level.` }
  if (raw.type !== 'object') return { ok: false, error: '"type" must be "object".' }
  if (!isObj(raw.properties)) return { ok: false, error: '"properties" must be an object.' }
  const names = Object.keys(raw.properties)
  if (names.length > OPTIONS_MAX) return { ok: false, error: `At most ${OPTIONS_MAX} options.` }
  const properties: Record<string, OptionSpec> = {}
  for (const name of names) {
    const at = `properties.${name}`
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(name))
      return { ok: false, error: `${at}: names are letters, digits, _.` }
    const p = raw.properties[name]
    if (!isObj(p)) return { ok: false, error: `${at} must be an object.` }
    const keys = Object.keys(p)
    const allowed =
      p.type === 'string'
        ? ['type', 'title', 'description', 'maxLength', 'enum', 'default']
        : ['type', 'title', 'description', 'default']
    const bad = keys.find((k) => !allowed.includes(k))
    if (bad) return { ok: false, error: `${at}: unknown key "${bad}".` }
    if (p.title !== undefined && (typeof p.title !== 'string' || p.title.length > 60))
      return { ok: false, error: `${at}.title must be text of at most 60 characters.` }
    if (p.description !== undefined && (typeof p.description !== 'string' || p.description.length > 200))
      return { ok: false, error: `${at}.description must be text of at most 200 characters.` }
    if (p.type === 'string') {
      const spec: StringOption = { type: 'string' }
      if (p.title !== undefined) spec.title = p.title
      if (p.description !== undefined) spec.description = p.description
      if (p.maxLength !== undefined) {
        if (
          !Number.isInteger(p.maxLength) ||
          (p.maxLength as number) < 1 ||
          (p.maxLength as number) > STRING_MAX
        )
          return { ok: false, error: `${at}.maxLength must be a whole number from 1 to ${STRING_MAX}.` }
        spec.maxLength = p.maxLength as number
      }
      if (p.enum !== undefined) {
        const e = p.enum
        if (
          !Array.isArray(e) ||
          e.length === 0 ||
          e.length > 20 ||
          e.some((x) => typeof x !== 'string' || x.length > 100)
        )
          return { ok: false, error: `${at}.enum must be 1 to 20 texts of at most 100 characters.` }
        spec.enum = e as string[]
      }
      if (p.default !== undefined) {
        if (typeof p.default !== 'string') return { ok: false, error: `${at}.default must be text.` }
        if (spec.enum && !spec.enum.includes(p.default))
          return { ok: false, error: `${at}.default must be in enum.` }
        spec.default = p.default
      }
      properties[name] = spec
    } else if (p.type === 'boolean') {
      const spec: BooleanOption = { type: 'boolean' }
      if (p.title !== undefined) spec.title = p.title
      if (p.description !== undefined) spec.description = p.description
      if (p.default !== undefined) {
        if (typeof p.default !== 'boolean')
          return { ok: false, error: `${at}.default must be true or false.` }
        spec.default = p.default
      }
      properties[name] = spec
    } else {
      return { ok: false, error: `${at}.type must be "string" or "boolean".` }
    }
  }
  const schema: OptionsSchema = { type: 'object', properties }
  if (raw.required !== undefined) {
    const r = raw.required
    if (!Array.isArray(r) || r.some((x) => typeof x !== 'string' || !(x in properties)))
      return { ok: false, error: '"required" must list names from "properties".' }
    schema.required = r as string[]
  }
  return { ok: true, value: schema }
}

/** Checks a publisher's options against a schema, applying defaults. Unknown keys are refused. */
export function validateOptions(
  schema: OptionsSchema | null,
  raw: unknown,
): { ok: true; value: Record<string, string | boolean> } | { ok: false; errors: string[] } {
  const input = raw == null ? {} : raw
  if (!isObj(input)) return { ok: false, errors: ['Options must be an object.'] }
  const props = schema?.properties ?? {}
  const errors: string[] = []
  const value: Record<string, string | boolean> = {}
  for (const k of Object.keys(input)) if (!(k in props)) errors.push(`Unknown option "${k}".`)
  for (const [name, spec] of Object.entries(props)) {
    const v = input[name]
    if (v === undefined || v === null || v === '') {
      if (spec.default !== undefined) value[name] = spec.default
      else if (schema?.required?.includes(name)) errors.push(`"${spec.title ?? name}" is required.`)
      continue
    }
    if (spec.type === 'boolean') {
      if (typeof v !== 'boolean') errors.push(`"${spec.title ?? name}" must be true or false.`)
      else value[name] = v
      continue
    }
    if (typeof v !== 'string') {
      errors.push(`"${spec.title ?? name}" must be text.`)
      continue
    }
    if (v.length > (spec.maxLength ?? STRING_MAX)) errors.push(`"${spec.title ?? name}" is too long.`)
    else if (spec.enum && !spec.enum.includes(v))
      errors.push(`"${spec.title ?? name}" must be one of the choices.`)
    else value[name] = v
  }
  return errors.length ? { ok: false, errors } : { ok: true, value }
}
