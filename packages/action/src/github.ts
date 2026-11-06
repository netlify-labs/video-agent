// A small GitHub REST and GraphQL client over fetch: the few routes the action calls, each logged with the rate limit
// left (GITHUB_TOKEN gets 1,000 requests an hour per repository, shared with every other workflow).
import type { Log } from './log.js'

export class GitHubError extends Error {
  override readonly name = 'GitHubError'
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface GhResponse<T> {
  status: number
  data: T
  headers: Headers
}

export interface RequestParams {
  /** Values for {placeholders} in the route. */
  path?: Record<string, string | number>
  query?: Record<string, string | number | undefined>
  body?: unknown
  /** A raw body (release asset uploads), sent as is. */
  raw?: { bytes: Uint8Array; contentType: string }
  /** A full URL instead of the API base (release asset uploads). */
  url?: string
}

export interface GitHub {
  readonly owner: string
  readonly repo: string
  /** `request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { path: { pull_number: 1 } })`. owner and repo fill in. */
  request<T>(route: string, params?: RequestParams): Promise<GhResponse<T>>
  /** Every item of a list route, following Link rel="next". */
  paginate<T>(route: string, params?: RequestParams): AsyncGenerator<T>
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>
}

export interface GitHubOptions {
  token: string
  /** owner/repo (GITHUB_REPOSITORY). */
  repository: string
  apiUrl?: string
  fetch?: typeof fetch
  log: Log
  now?: () => number
}

const nextLink = (link: string | null) => /<([^>]+)>;\s*rel="next"/.exec(link ?? '')?.[1] ?? null

export function createGitHub(o: GitHubOptions): GitHub {
  const [owner = '', repo = ''] = o.repository.split('/')
  const api = (o.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '')
  const f = o.fetch ?? globalThis.fetch.bind(globalThis)
  const now = o.now ?? Date.now

  const urlFor = (route: string, params: RequestParams) => {
    // A full URL (release asset uploads) is used as is; the route only names the call in the log.
    if (params.url) {
      const u = new URL(params.url)
      for (const [k, v] of Object.entries(params.query ?? {}))
        if (v !== undefined) u.searchParams.set(k, String(v))
      return u.toString()
    }
    const values: Record<string, string | number> = { owner, repo, ...params.path }
    const path = route.replace(/\{([a-z_]+)\}/g, (_, k: string) => {
      const v = values[k]
      if (v === undefined) throw new TypeError(`${route}: missing ${k}`)
      return encodeURIComponent(String(v))
    })
    const u = new URL(params.url ?? `${api}${path}`)
    for (const [k, v] of Object.entries(params.query ?? {}))
      if (v !== undefined) u.searchParams.set(k, String(v))
    return u.toString()
  }

  async function send<T>(
    method: string,
    route: string,
    url: string,
    params: RequestParams,
  ): Promise<GhResponse<T>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${o.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'video-agent-action',
    }
    let body: RequestInit['body']
    if (params.raw) {
      headers['content-type'] = params.raw.contentType
      body = params.raw.bytes
    } else if (params.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(params.body)
    }
    const started = now()
    const res = await f(url, { method, headers, ...(body !== undefined ? { body } : {}) })
    const remaining = res.headers.get('x-ratelimit-remaining')
    o.log.gh({
      method,
      route,
      status: res.status,
      ms: now() - started,
      remaining: remaining === null ? null : Number(remaining),
    })
    const text = res.status === 204 ? '' : await res.text()
    let data: unknown
    try {
      data = text ? JSON.parse(text) : undefined
    } catch {
      data = text
    }
    if (res.status >= 400) {
      const message = (data as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`
      throw new GitHubError(res.status, `${method} ${route}: ${message}`)
    }
    return { status: res.status, data: data as T, headers: res.headers }
  }

  return {
    owner,
    repo,
    request: (route, params = {}) => {
      const [method = 'GET', path = ''] = route.split(' ')
      return send(method, path, urlFor(path, params), params)
    },
    async *paginate<T>(route: string, params: RequestParams = {}) {
      const [method = 'GET', path = ''] = route.split(' ')
      let url: string | null = urlFor(path, { ...params, query: { per_page: 100, ...params.query } })
      while (url) {
        const res: GhResponse<T[] | undefined> = await send<T[] | undefined>(method, path, url, params)
        for (const item of res.data ?? []) yield item
        url = nextLink(res.headers.get('link'))
      }
    },
    graphql: async <T>(query: string, variables: Record<string, unknown>) => {
      const res = await send<{ data?: T; errors?: { message: string }[] }>(
        'POST',
        '/graphql',
        `${api}/graphql`,
        {
          body: { query, variables },
        },
      )
      if (res.data.errors?.length)
        throw new GitHubError(200, `graphql: ${res.data.errors[0]?.message ?? 'error'}`)
      return res.data.data as T
    },
  }
}
