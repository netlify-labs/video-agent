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

/** A client for VIDEO_AGENT_URL / VIDEO_AGENT_KEY whose request events print as the scripts' JSON lines. */
export const sdk = () =>
  new VideoAgent({ url: base, apiKey: key, userAgent: 'video-agent-e2e', logger: (_e, f) => log('api', f) })
