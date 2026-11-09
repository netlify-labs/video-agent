// Every API call the page makes through the API client, newest first, for the API calls drawer
// (components/ApiCalls.tsx). It shows the REST call behind each click, so the app doubles as a guide to its own API.

export interface ApiCall {
  id: number
  at: number
  method: string
  /** Path and query, without the origin. */
  path: string
  /** null when the request never got a response. */
  status: number | null
  ms: number
  /** The JSON body sent, for "Copy as curl" (cut short when long). */
  body: string | null
}

const MAX_CALLS = 200
const MAX_BODY = 4000

let calls: ApiCall[] = []
let nextId = 1
const listeners = new Set<() => void>()

export function subscribeCalls(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const getCalls = (): ApiCall[] => calls

export function clearCalls() {
  calls = []
  for (const l of listeners) l()
}

function add(call: ApiCall) {
  calls = [call, ...calls].slice(0, MAX_CALLS)
  for (const l of listeners) l()
}

/** The JSON body, read from a copy taken before the request is sent, so recording never delays the request. */
function jsonBody(req: Request): Promise<string | null> {
  if (req.method === 'GET' || req.method === 'HEAD') return Promise.resolve(null)
  if (!req.headers.get('content-type')?.includes('application/json')) return Promise.resolve(null)
  return req
    .clone()
    .text()
    .then((text) => (text ? text.slice(0, MAX_BODY) : null))
    .catch(() => null)
}

/** Sends `req` with `send` and records the call. */
export async function recordCall(req: Request, send: (req: Request) => Promise<Response>): Promise<Response> {
  const url = new URL(req.url)
  const body = jsonBody(req)
  const at = Date.now()
  const record = (status: number | null) => {
    const ms = Date.now() - at
    void body.then((b) =>
      add({ id: nextId++, at, method: req.method, path: url.pathname + url.search, status, ms, body: b }),
    )
  }
  try {
    const res = await send(req)
    record(res.status)
    return res
  } catch (e) {
    record(null)
    throw e
  }
}

/** The call as a curl command with an API key from the environment, ready to paste into a terminal. */
export function curlFor(call: ApiCall, origin: string): string {
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const lines = [
    `curl${call.method === 'GET' ? '' : ` -X ${call.method}`} ${quote(origin + call.path)}`,
    `-H "Authorization: Bearer $VIDEO_AGENT_API_KEY"`,
  ]
  if (call.body) lines.push(`-H 'Content-Type: application/json'`, `-d ${quote(call.body)}`)
  return lines.join(' \\\n  ')
}

type Spec = { paths?: Record<string, Record<string, { summary?: string }>> }
let operations: Promise<{ method: string; pattern: RegExp; template: string; summary: string }[]> | null =
  null

/** Each call's operation in the OpenAPI spec ("Create a video"), loaded once when the drawer first opens. */
export function loadOperations() {
  operations ??= globalThis
    .fetch('/api/openapi.json')
    .then((r) => (r.ok ? (r.json() as Promise<Spec>) : {}))
    .then((spec: Spec) =>
      Object.entries(spec.paths ?? {}).flatMap(([template, ops]) =>
        Object.entries(ops).map(([method, op]) => ({
          method: method.toUpperCase(),
          template,
          summary: op.summary ?? '',
          pattern: new RegExp(
            `^${template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^/]+\}/g, '[^/]+')}$`,
          ),
        })),
      ),
    )
    .catch(() => [])
  return operations
}
