// Shared by the live checks in this folder: the site and key from the environment, JSON-line logging, a JSON call and
// the SDK (cli-and-sdk plan §9: our own scripts are its first users; move a script to sdk() when you touch it).
import { VideoAgent } from '../../packages/sdk/src/index.js'
export const base = (process.env.VIDEO_AGENT_URL ?? '').replace(/\/$/, '')
export const key = process.env.VIDEO_AGENT_KEY ?? ''
export const started = Date.now()
export const log = (step: string, f: Record<string, unknown> = {}) => {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      s: Math.round((Date.now() - started) / 1000),
      step,
      ...f,
    }),
  )
}
export const fail = (msg: string, f: Record<string, unknown> = {}): never => {
  log('FAIL', { msg, ...f })
  process.exit(1)
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the response type
export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: T }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as T }
}

/** One stateless MCP JSON-RPC request (id 1) as `k`; the server may answer as JSON or as one SSE event. */
export const mcpPost = (k: string, method: string, params: unknown) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${k}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })

/** A client for VIDEO_AGENT_URL / VIDEO_AGENT_KEY whose request events print as the scripts' JSON lines. */
export const sdk = () =>
  new VideoAgent({ url: base, apiKey: key, userAgent: 'video-agent-e2e', logger: (_e, f) => log('api', f) })
