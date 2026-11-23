// What the generated resource methods (generated/resources.ts) call, and the types they're written in. The client
// core implements Transport: auth, the feature check, retries, errors.
import type { paths } from './generated/schema.js'

type Op<P extends keyof paths, M extends keyof paths[P]> = paths[P][M]
type QueryOf<O> = O extends { parameters: { query?: infer Q } }
  ? [Q] extends [undefined]
    ? object
    : NonNullable<Q>
  : object
type BodyOf<O> = O extends { requestBody?: infer B }
  ? NonNullable<B> extends { content: { 'application/json': infer J } }
    ? J
    : object
  : object
type JsonOf<R> = R extends { content: { 'application/json': infer J } } ? J : never
type OkOf<O> = O extends { responses: infer R }
  ? R extends { 200: infer X }
    ? JsonOf<X>
    : R extends { 201: infer X }
      ? JsonOf<X>
      : R extends { 202: infer X }
        ? JsonOf<X>
        : never
  : never

/** An operation's input: its query fields and JSON body fields, merged (the generator refuses a name in both). */
export type Input<P extends keyof paths, M extends keyof paths[P]> = QueryOf<Op<P, M>> & BodyOf<Op<P, M>>
/** An operation's success body. */
export type Ok<P extends keyof paths, M extends keyof paths[P]> = OkOf<Op<P, M>>

export interface CallOptions {
  /** Sent as Idempotency-Key on create, revise and remix; a generated one is used when omitted. */
  idempotencyKey?: string
  signal?: AbortSignal
  headers?: Record<string, string>
}

/** One generated method's request, described. */
export interface Call {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  pathParams: Record<string, string | number>
  input?: object | undefined
  /** Which input fields go in the query string. */
  query?: readonly string[]
  /** Which input fields go in the JSON body; null: the operation takes no body. */
  body?: readonly string[] | null
  /** The `features` strings the server must list for this call (unsupported_by_server otherwise). */
  features: readonly string[]
  operationId: string
}

export interface Transport {
  call<T>(call: Call, opts?: CallOptions): Promise<T>
}

/** The URL path with its parameters filled in, and the input split into query and body. */
export function prepare(call: Call): {
  path: string
  query: URLSearchParams
  body: Record<string, unknown> | null
} {
  const path = call.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const v = call.pathParams[name]
    if (v === undefined || v === '')
      throw new TypeError(`${call.operationId}: missing path parameter ${name}`)
    return encodeURIComponent(String(v))
  })
  const input = (call.input ?? {}) as Record<string, unknown>
  const query = new URLSearchParams()
  for (const k of call.query ?? []) {
    const v = input[k]
    if (v !== undefined && v !== null) query.set(k, typeof v === 'string' ? v : JSON.stringify(v))
  }
  let body: Record<string, unknown> | null = null
  if (call.body) {
    body = {}
    for (const k of call.body) if (input[k] !== undefined) body[k] = input[k]
  }
  return { path, query, body }
}
