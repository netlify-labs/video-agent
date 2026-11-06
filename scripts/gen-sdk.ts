// Writes packages/sdk/src/generated/resources.ts from ui/src/api/openapi.json (cli-and-sdk plan §4.1 layer 2, §4.3):
// one namespace per x-sdk resource, one thin typed method per operation. --check fails when the file is stale.
// Signature rule: path parameters positionally in path order, then one `input` object (body and query fields merged;
// a name in both fails generation), then opts. Routes with x-sdk false or a binary body are skipped (va.raw has them).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { format } from 'prettier'
import type { SdkMeta } from '../src/lib/sdk-meta.js'
import { repoRoot, writeOrCheck } from './lib/run-tools.js'

interface Param {
  name: string
  in: string
  required?: boolean
}
interface Operation {
  operationId?: string
  summary?: string
  'x-sdk'?: SdkMeta
  parameters?: Param[]
  requestBody?: { required?: boolean; content: Record<string, { schema?: Schema }> }
  responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>
}
interface Schema {
  $ref?: string
  type?: string
  properties?: Record<string, Schema>
  required?: string[]
  allOf?: Schema[]
}
export interface Spec {
  paths: Record<string, Record<string, Operation>>
  components?: { schemas?: Record<string, Schema> }
}

interface Method {
  resource: string
  method: string
  operationId: string
  summary: string
  httpMethod: string
  path: string
  pathParams: string[]
  query: string[]
  body: string[]
  bodyIsObject: boolean
  inputRequired: boolean
  features: string[]
  fieldFeatures: [string, string][]
  pageable: boolean
  noContent: boolean
}

const HTTP = ['get', 'post', 'put', 'patch', 'delete'] as const

function resolve(spec: Spec, s: Schema | undefined): Schema | undefined {
  if (!s?.$ref) return s
  const name = s.$ref.replace('#/components/schemas/', '')
  return resolve(spec, spec.components?.schemas?.[name])
}

/** An object schema's properties and required names (allOf merged); null when it isn't an object. */
function objectShape(spec: Spec, s: Schema | undefined): { props: string[]; required: string[] } | null {
  const r = resolve(spec, s)
  if (!r) return null
  if (r.allOf) {
    const parts = r.allOf.map((p) => objectShape(spec, p))
    if (parts.some((p) => !p)) return null
    return {
      props: parts.flatMap((p) => p?.props ?? []),
      required: parts.flatMap((p) => p?.required ?? []),
    }
  }
  if (r.type !== 'object' && !r.properties) return null
  return { props: Object.keys(r.properties ?? {}), required: r.required ?? [] }
}

function describe(spec: Spec, path: string, httpMethod: string, op: Operation): Method | null {
  const sdk = op['x-sdk']
  if (!sdk) return null
  const where = `${httpMethod.toUpperCase()} ${path}`
  const content = op.requestBody?.content ?? {}
  if (Object.keys(content).some((ct) => ct !== 'application/json')) return null
  const params = op.parameters ?? []
  const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] ?? '')
  const query = params.filter((p) => p.in === 'query').map((p) => p.name)
  const bodySchema = content['application/json']?.schema
  const shape = bodySchema ? objectShape(spec, bodySchema) : null
  if (bodySchema && !shape)
    throw new Error(`${where}: a JSON body that isn't an object can't merge into input`)
  const body = shape?.props ?? []
  const clash = body.filter((b) => query.includes(b))
  if (clash.length) throw new Error(`${where}: ${clash.join(', ')} is both a body field and a query field`)
  const ok = Object.entries(op.responses ?? {}).find(([code]) => /^2\d\d$/.test(code))
  const okShape = objectShape(spec, ok?.[1].content?.['application/json']?.schema)
  return {
    resource: sdk.resource,
    method: sdk.method,
    operationId: op.operationId ?? '',
    summary: op.summary ?? '',
    httpMethod,
    path,
    pathParams,
    query,
    body,
    bodyIsObject: Boolean(shape),
    inputRequired:
      params.some((p) => p.in === 'query' && p.required) ||
      Boolean(op.requestBody?.required && shape?.required.length),
    features: sdk.feature ? [sdk.feature] : [],
    fieldFeatures: Object.entries(sdk.fieldFeatures ?? {}),
    pageable: Boolean(okShape?.props.includes('items') && okShape.props.includes('nextCursor')),
    noContent: !ok?.[1].content,
  }
}

export function collect(spec: Spec): Method[] {
  const out: Method[] = []
  for (const [path, item] of Object.entries(spec.paths))
    for (const m of HTTP) {
      const op = item[m]
      if (!op) continue
      const d = describe(spec, path, m, op)
      if (d) out.push(d)
    }
  return out.sort((a, b) => `${a.resource}.${a.method}`.localeCompare(`${b.resource}.${b.method}`))
}

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const list = (xs: string[]) => `[${xs.map(q).join(', ')}]`

function methodSource(m: Method): string {
  const P = `${q(m.path)}, ${q(m.httpMethod)}`
  const hasInput = m.query.length > 0 || m.bodyIsObject
  const args = [
    ...m.pathParams.map((p) => `${/^[A-Za-z_$][\w$]*$/.test(p) ? p : `p_${p}`}: string | number`),
    ...(hasInput ? [`input${m.inputRequired ? '' : '?'}: Input<${P}>`] : []),
    'opts?: CallOptions',
  ]
  const gates = [
    ...(m.features.length ? [`...${list(m.features)}`] : []),
    ...m.fieldFeatures.map(
      ([field, f]) => `...(input${m.inputRequired ? '' : '?'}.${field} !== undefined ? [${q(f)}] : [])`,
    ),
  ]
  const call = [
    `method: ${q(m.httpMethod.toUpperCase())}`,
    `path: ${q(m.path)}`,
    `pathParams: { ${m.pathParams.map((p) => (/^[A-Za-z_$][\w$]*$/.test(p) ? p : `${q(p)}: p_${p}`)).join(', ')} }`,
    ...(hasInput
      ? [`input`, `query: ${list(m.query)}`, `body: ${m.bodyIsObject ? list(m.body) : 'null'}`]
      : []),
    `features: ${gates.length ? `[${gates.join(', ')}]` : '[]'}`,
    `operationId: ${q(m.operationId)}`,
  ]
  const ret = m.noContent ? 'undefined' : `Ok<${P}>`
  return `    /** ${m.summary.replace(/\*\//g, '*\\/')} (\`${m.operationId}\`) */
    ${m.method}: (${args.join(', ')}): Promise<${ret}> =>
      t.call<${ret}>({ ${call.join(', ')} }, opts),`
}

export async function generateResources(spec: Spec): Promise<string> {
  const methods = collect(spec)
  const byResource = new Map<string, Method[]>()
  for (const m of methods) byResource.set(m.resource, [...(byResource.get(m.resource) ?? []), m])
  const src = `// Generated by scripts/gen-sdk.ts from ui/src/api/openapi.json. Do not edit; run \`npm run openapi:gen\`.
import type { CallOptions, Input, Ok, Transport } from '../transport.js'

/** The generated resource methods: one namespace per x-sdk resource. */
export function resources(t: Transport) {
  return {
${[...byResource].map(([r, ms]) => `  ${r}: {\n${ms.map(methodSource).join('\n')}\n  },`).join('\n')}
  }
}

export type Resources = ReturnType<typeof resources>

/** Operations whose response pages with { items, nextCursor } (the ones listAll can follow). */
export const PAGEABLE = ${list(methods.filter((m) => m.pageable).map((m) => `${m.resource}.${m.method}`))} as const
`
  return format(src, {
    parser: 'typescript',
    semi: false,
    singleQuote: true,
    printWidth: 110,
    trailingComma: 'all',
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const spec = JSON.parse(readFileSync(join(repoRoot, 'ui/src/api/openapi.json'), 'utf8')) as Spec
  const out = await generateResources(spec)
  writeOrCheck(join(repoRoot, 'packages/sdk/src/generated/resources.ts'), out, {
    check: process.argv.includes('--check'),
    label: 'packages/sdk/src/generated/resources.ts',
    hint: 'Run `npm run openapi:gen` and commit it.',
  })
}
