// Typed API client generated from openapi.json: a response shape change breaks the typecheck.
import createFetchClient from 'openapi-fetch'
import createClient from 'openapi-react-query'
import type { paths } from './schema'

// fetch is looked up per call so mock mode (ui/src/mock) can replace it after this module loads.
export const fetchClient = createFetchClient<paths>({
  baseUrl: '',
  credentials: 'same-origin',
  fetch: (req) => globalThis.fetch(req),
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
