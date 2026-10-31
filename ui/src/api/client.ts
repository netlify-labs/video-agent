// Typed API client generated from openapi.json: a response shape change breaks the typecheck.
import createFetchClient from 'openapi-fetch'
import createClient from 'openapi-react-query'
import { recoverAfterUnauthorized, refreshIfNeeded } from '../session'
import type { paths } from './schema'

/**
 * Sends a request with the session cookie, refreshing the token first when it's about to expire and once
 * more after a 401. fetch is looked up per call so mock mode (ui/src/mock) can replace it after this loads.
 */
export async function sessionFetch(req: Request): Promise<Response> {
  if (import.meta.env.VITE_MOCK) return globalThis.fetch(req)
  await refreshIfNeeded()
  const retry = req.clone()
  const res = await globalThis.fetch(req)
  if (res.status !== 401) return res
  return (await recoverAfterUnauthorized()) ? globalThis.fetch(retry) : res
}

export const fetchClient = createFetchClient<paths>({
  baseUrl: '',
  credentials: 'same-origin',
  fetch: sessionFetch,
})
export const $api = createClient(fetchClient)

export type Video = NonNullable<
  paths['/api/v1/videos/{id}']['get']['responses'][200]['content']['application/json']
>
export type Version = Video['versions'][number]
export type Publication = Version['publications'][number]
export type Stats = paths['/api/v1/stats']['get']['responses'][200]['content']['application/json']

export interface ApiErrorBody {
  error: { code: string; message: string }
}

export function errorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'error' in e) return (e as ApiErrorBody).error.message
  return e instanceof Error ? e.message : 'Something went wrong.'
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID()
}

/** Creators and admins make, revise and edit videos; reviewers and viewers don't (plan v2 §3). The server
 * enforces this; the UI only hides what the role can't use. */
export function useCanCreate(): boolean {
  const me = $api.useQuery('get', '/api/v1/me')
  return me.data?.role === 'admin' || me.data?.role === 'creator'
}
