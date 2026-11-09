// The Remotion project's rules (render-engines plan §5.1, §5.2), pure TypeScript with no Remotion or zod at runtime, so
// hydrate (engine_tampered), check and finalize (engine_mismatch) share one definition. The locked files' hashes and
// props.json's JSON Schema are generated from app/engines/remotion by scripts/gen-remotion-locked.ts.
import { createHash } from 'node:crypto'
import locked from './remotion-locked.json' with { type: 'json' }
import propsSchemaJson from './remotion-props.schema.json' with { type: 'json' }

export const REMOTION_VERSION = locked.remotion
/** Template-owned files, by sha256: byte-identical in every project. */
export const LOCKED_FILES: Readonly<Record<string, string>> = locked.files
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const text = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined)

const ID = /^[a-z0-9-]+$/
/** What the agent may write, besides the locked files: the editable data, its components and its assets. */
function allowed(path: string) {
  if (path in LOCKED_FILES) return true
  if (['props.json', 'summary.json', 'src/registry.ts'].includes(path)) return true
  if (/^src\/(beats|layers)\/[a-z0-9-]+\.tsx$/.test(path)) return true
  if (path.startsWith('assets/') && !path.includes('..')) return true
  // Placeholders and the tooling's own output, never archived (app/server/lib/bundle-manifest.ts).
  return /(^|\/)\.gitkeep$/.test(path) || path.startsWith('node_modules/') || path.startsWith('.render/')
}

/**
 * Locked files missing or changed, files the project may not have, and a HyperFrames entry point. Every message names
 * its file, so hydrate, check and finalize report it as is.
 */
export function projectFileProblems(files: Map<string, Uint8Array>): string[] {
  const problems: string[] = []
  for (const [path, want] of Object.entries(LOCKED_FILES)) {
    const got = files.get(path)
    if (!got) problems.push(`${path} is missing; it comes from the template.`)
    else if (sha256(got) !== want)
      problems.push(`${path} doesn't match the template; it must not be changed.`)
  }
  for (const path of [...files.keys()].sort()) {
    if (path === 'index.html') problems.push('A Remotion project has no index.html.')
    else if (!allowed(path)) problems.push(`${path} isn't allowed in a Remotion project.`)
  }
  return problems
}

interface Ids {
  beats: { id: string }[]
  layers: { id: string }[]
}
const ident = (kind: string, id: string) =>
  `${kind}${id.replace(/(^|-)([a-z0-9])/g, (_m, _d: string, c: string) => c.toUpperCase())}`

/** src/registry.ts for these props: static imports of every beat and layer, sorted by id, so order never matters. */
export function generateRegistry(props: Ids): string {
  const beats = [...new Set(props.beats.map((b) => b.id))].sort()
  const layers = [...new Set(props.layers.map((l) => l.id))].sort()
  const entries = (kind: string, ids: string[]) =>
    ids.length ? `{ ${ids.map((id) => `'${id}': ${ident(kind, id)}`).join(', ')} }` : '{}'
  return [
    '// GENERATED from props.json by scripts/engine.ts check. Do not edit.',
    "import type { ComponentType } from 'react'",
    ...beats.map((id) => `import ${ident('Beat', id)} from './beats/${id}'`),
    ...layers.map((id) => `import ${ident('Layer', id)} from './layers/${id}'`),
    '',
    `export const beats: Record<string, ComponentType> = ${entries('Beat', beats)}`,
    `export const layers: Record<string, ComponentType> = ${entries('Layer', layers)}`,
    '',
  ].join('\n')
}

/** Every beat and layer has its file, every file its entry, ids are well formed, and the registry is current. */
export function registryProblems(files: Map<string, Uint8Array>, props: Ids): string[] {
  const problems: string[] = []
  for (const [kind, list] of [
    ['beats', props.beats],
    ['layers', props.layers],
  ] as const) {
    const ids = list.map((x) => x.id)
    for (const id of ids)
      if (!ID.test(id))
        problems.push(`props.json: "${id}" isn't a valid ${kind.slice(0, -1)} id (a-z, 0-9 and -).`)
      else if (!files.has(`src/${kind}/${id}.tsx`))
        problems.push(`src/${kind}/${id}.tsx is missing for the ${kind.slice(0, -1)} "${id}" in props.json.`)
    for (const path of files.keys()) {
      const m = new RegExp(`^src/${kind}/([^/]+)\\.tsx$`).exec(path)
      if (m?.[1] && !ids.includes(m[1])) problems.push(`${path} has no entry in props.json's ${kind}.`)
    }
  }
  if (text(files.get('src/registry.ts')) !== generateRegistry(props))
    problems.push("src/registry.ts doesn't match props.json; scripts/engine.ts check regenerates it.")
  return problems
}

// ───── props.json against its JSON Schema: the keywords zod's toJSONSchema emits for src/va/schema.ts ─────
type Schema = {
  type?: string | string[]
  properties?: Record<string, Schema>
  required?: string[]
  additionalProperties?: boolean | Schema
  propertyNames?: Schema
  items?: Schema
  prefixItems?: Schema[]
  minItems?: number
  maxItems?: number
  const?: unknown
  enum?: unknown[]
  pattern?: string
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  maxLength?: number
  anyOf?: Schema[]
}
// Generated JSON: its inferred type is narrower than Schema in ways that don't matter (e.g. string vs string[]).
const propsSchema = propsSchemaJson as unknown as Schema
const typeOk = (t: string, v: unknown) =>
  t === 'object'
    ? !!v && typeof v === 'object' && !Array.isArray(v)
    : t === 'array'
      ? Array.isArray(v)
      : t === 'integer'
        ? Number.isInteger(v)
        : t === 'null'
          ? v === null
          : typeof v === t

function validate(s: Schema, v: unknown, at: string): string[] {
  if (s.anyOf) return s.anyOf.some((x) => !validate(x, v, at).length) ? [] : [`${at} has the wrong shape.`]
  const types = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type]
  if (types.length && !types.some((t) => typeOk(t, v)))
    return [
      `${at} should be ${types.map((t) => (t === 'integer' ? 'a whole number' : t === 'null' ? 'null' : `a ${t}`)).join(' or ')}.`,
    ]
  if ('const' in s && v !== s.const) return [`${at} must be ${JSON.stringify(s.const)}.`]
  if (s.enum && !s.enum.includes(v))
    return [`${at} must be one of ${s.enum.map((x) => JSON.stringify(x)).join(', ')}.`]
  const out: string[] = []
  if (typeof v === 'string') {
    if (s.pattern && !new RegExp(s.pattern).test(v)) out.push(`${at} isn't in the expected form.`)
    if (s.maxLength !== undefined && v.length > s.maxLength)
      out.push(`${at} is longer than ${s.maxLength} characters.`)
  }
  if (typeof v === 'number') {
    if (s.minimum !== undefined && v < s.minimum) out.push(`${at} must be at least ${s.minimum}.`)
    if (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum)
      out.push(`${at} must be more than ${s.exclusiveMinimum}.`)
    if (s.maximum !== undefined && v > s.maximum) out.push(`${at} must be at most ${s.maximum}.`)
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems)
      out.push(`${at} needs at least ${s.minItems} item(s).`)
    if (s.maxItems !== undefined && v.length > s.maxItems)
      out.push(`${at} has more than ${s.maxItems} item(s).`)
    v.forEach((x, i) => {
      const item = s.prefixItems?.[i] ?? s.items
      if (item) out.push(...validate(item, x, `${at}[${i}]`))
    })
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>
    for (const k of s.required ?? []) if (!(k in o)) out.push(`${at}.${k} is missing.`)
    for (const [k, x] of Object.entries(o)) {
      const p = s.properties?.[k]
      if (s.propertyNames) out.push(...validate(s.propertyNames, k, `${at} key "${k}"`))
      if (p) out.push(...validate(p, x, `${at}.${k}`))
      else if (s.additionalProperties === false) out.push(`${at}.${k} isn't a known field.`)
      else if (typeof s.additionalProperties === 'object')
        out.push(...validate(s.additionalProperties, x, `${at}.${k}`))
    }
  }
  return out
}

/** props.json against the contract's schema: parse errors and shape problems, each starting "props.json". */
export function propsProblems(raw: Uint8Array | string | undefined): string[] {
  if (raw === undefined) return ['props.json is missing.']
  let v: unknown
  try {
    v = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
  } catch {
    return ['props.json is not valid JSON.']
  }
  return validate(propsSchema, v, 'props.json')
}

/**
 * Everything wrong with a Remotion project's files (render-engines plan §5.1, reviews A5, A8, R1): the locked files and
 * allowed paths, props.json against its schema, and src/registry.ts against what those props generate. One rule set
 * for the run (before anything in a restored project runs) and finalize (before anything becomes a version).
 */
export function remotionProjectProblems(files: Map<string, Uint8Array>): string[] {
  const props = propsProblems(files.get('props.json'))
  if (props.length) return [...projectFileProblems(files), ...props]
  const parsed = JSON.parse(new TextDecoder().decode(files.get('props.json'))) as Ids
  return [...projectFileProblems(files), ...registryProblems(files, parsed)]
}
