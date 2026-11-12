// Options forms for publish destinations (docs/plans/2026-11-04-publish-destinations.md §6.3): a small JSON-Schema
// subset an HTTP destination can declare, so the Publish dialog can render it and the server can check it without a
// new dependency. v1: an object of at most 10 string or boolean properties. A string can be a secret
// (format "password": masked in the dialog, encrypted at rest, never shown again) and any option can depend on a
// switch (showIf: shown, checked and sent only while that boolean option is on).

export interface StringOption {
  type: 'string'
  title?: string
  description?: string
  minLength?: number
  maxLength?: number
  enum?: string[]
  default?: string
  /** A secret: the dialog masks it and Video Agent keeps it encrypted. */
  format?: 'password'
  /** The name of a boolean option: this one counts only while that one is on. */
  showIf?: string
}
export interface BooleanOption {
  type: 'boolean'
  title?: string
  description?: string
  default?: boolean
  showIf?: string
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
        ? ['type', 'title', 'description', 'minLength', 'maxLength', 'enum', 'default', 'format', 'showIf']
        : ['type', 'title', 'description', 'default', 'showIf']
    const bad = keys.find((k) => !allowed.includes(k))
    if (bad) return { ok: false, error: `${at}: unknown key "${bad}".` }
    if (p.title !== undefined && (typeof p.title !== 'string' || p.title.length > 60))
      return { ok: false, error: `${at}.title must be text of at most 60 characters.` }
    if (p.description !== undefined && (typeof p.description !== 'string' || p.description.length > 200))
      return { ok: false, error: `${at}.description must be text of at most 200 characters.` }
    if (p.showIf !== undefined && (typeof p.showIf !== 'string' || p.showIf === name))
      return { ok: false, error: `${at}.showIf must name another option.` }
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
      if (p.minLength !== undefined) {
        if (
          !Number.isInteger(p.minLength) ||
          (p.minLength as number) < 1 ||
          (p.minLength as number) > (spec.maxLength ?? STRING_MAX)
        )
          return { ok: false, error: `${at}.minLength must be a whole number from 1 to maxLength.` }
        spec.minLength = p.minLength as number
      }
      if (p.format !== undefined) {
        if (p.format !== 'password') return { ok: false, error: `${at}.format must be "password".` }
        if (p.enum !== undefined || p.default !== undefined)
          return { ok: false, error: `${at}: a password takes no enum or default.` }
        spec.format = 'password'
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
      if (p.showIf !== undefined) spec.showIf = p.showIf
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
      if (p.showIf !== undefined) spec.showIf = p.showIf
      properties[name] = spec
    } else {
      return { ok: false, error: `${at}.type must be "string" or "boolean".` }
    }
  }
  for (const [name, spec] of Object.entries(properties))
    if (spec.showIf !== undefined && properties[spec.showIf]?.type !== 'boolean')
      return { ok: false, error: `properties.${name}.showIf must name a boolean option.` }
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
  // A switch's state: what was sent, else its default.
  const on = (name: string) => {
    const v = input[name]
    return typeof v === 'boolean' ? v : props[name]?.default === true
  }
  for (const [name, spec] of Object.entries(props)) {
    // Behind a switch that's off: not checked, not kept, not sent.
    if (spec.showIf !== undefined && !on(spec.showIf)) continue
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
    else if (spec.minLength !== undefined && v.length < spec.minLength)
      errors.push(`"${spec.title ?? name}" must be at least ${spec.minLength} characters.`)
    else if (spec.enum && !spec.enum.includes(v))
      errors.push(`"${spec.title ?? name}" must be one of the choices.`)
    else value[name] = v
  }
  return errors.length ? { ok: false, errors } : { ok: true, value }
}

/** Where secret option values live at rest: one encrypted JSON object under a key no option can be named. */
export const SEALED_KEY = '__sealed'

/** Moves the secret (format "password") values out of `value` into one encrypted entry. */
export function sealOptions(
  schema: OptionsSchema | null,
  value: Record<string, string | boolean>,
  encrypt: (plaintext: string) => string,
): Record<string, string | boolean> {
  const secret: Record<string, string> = {}
  const out: Record<string, string | boolean> = {}
  for (const [k, v] of Object.entries(value)) {
    const spec = schema?.properties[k]
    if (spec?.type === 'string' && spec.format === 'password' && typeof v === 'string') secret[k] = v
    else out[k] = v
  }
  if (Object.keys(secret).length) out[SEALED_KEY] = encrypt(JSON.stringify(secret))
  return out
}

/** The options as the receiver gets them: the sealed values back in place. */
export function openOptions(
  stored: Record<string, unknown>,
  decrypt: (payload: string) => string,
): Record<string, unknown> {
  const { [SEALED_KEY]: sealed, ...rest } = stored
  if (typeof sealed !== 'string') return rest
  return { ...rest, ...(JSON.parse(decrypt(sealed)) as Record<string, string>) }
}

/** The options without the sealed entry (its ciphertext differs each time, so it can't be compared). */
export function withoutSealed(stored: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(stored).filter(([k]) => k !== SEALED_KEY))
}
