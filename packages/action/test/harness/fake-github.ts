// An in-memory GitHub for the action's tests (bead va-mg4i.2.2): the REST routes the action calls, served from state
// the test sets up, as a fetch function. Comments made with the default token are by github-actions[bot], GET /user is
// 403 (GITHUB_TOKEN can't call it, spike A3), lists page with Link headers, every response carries a falling
// x-ratelimit-remaining, and any route can be made to fail.

export interface FakeUser {
  login: string
  type?: 'User' | 'Bot'
}

export interface FakeComment {
  id: number
  issue: number
  body: string
  user: FakeUser
  author_association: string
  created_at: string
  updated_at: string
  reactions: { id: number; content: string; user: FakeUser }[]
}

export interface FakePull {
  number: number
  title: string
  body: string | null
  user: FakeUser
  author_association: string
  labels: string[]
  /** The head repo's full name; null for a deleted fork. Default: the base repo (not a fork). */
  headRepo?: string | null
  headSha: string
  commits: { sha: string; message: string }[]
  files: string[]
  html_url?: string
  /** What GraphQL bodyHTML returns (signed image URLs, spike A4). Default: the body. */
  bodyHTML?: string
  /** Files the compare API reports up to a head sha (new commits since a version). */
  filesBySha?: Record<string, string[]>
}

export interface FakeRelease {
  id: number
  tag_name: string
  name: string | null
  body: string | null
  html_url: string
  upload_url: string
  assets: { id: number; name: string; size: number; content_type: string; bytes: Uint8Array }[]
}

export interface FakeGitHubOptions {
  repo?: string
  visibility?: 'private' | 'public'
  /** login → permission (admin, maintain, write, triage, read, none). Unknown logins answer 404. */
  permissions?: Record<string, string>
  /** The token's identity: github-actions[bot] (GITHUB_TOKEN, default) or a user (a PAT). */
  tokenUser?: FakeUser
  rateLimit?: number
  /** Items per page for lists (GitHub's per_page, capped here so tests see paging). */
  pageSize?: number
}

export const BOT: FakeUser = { login: 'github-actions[bot]', type: 'Bot' }

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

export function fakeGitHub(o: FakeGitHubOptions = {}) {
  const repo = o.repo ?? 'acme/web'
  const state = {
    visibility: o.visibility ?? 'private',
    permissions: { ...o.permissions } as Record<string, string>,
    tokenUser: o.tokenUser ?? BOT,
    pulls: new Map<number, FakePull>(),
    /** Repository files for the contents API: "<ref>:<path>" → bytes. */
    files: new Map<string, Uint8Array>(),
    comments: [] as FakeComment[],
    releases: [] as FakeRelease[],
    remaining: o.rateLimit ?? 1000,
    /** "METHOD /route/pattern" → count. */
    requests: new Map<string, number>(),
    /** Every request: method, url, headers, body. */
    log: [] as {
      method: string
      url: string
      route: string
      headers: Record<string, string>
      body: unknown
    }[],
    /** route pattern → statuses to answer with, in order, instead of the real response. */
    failures: new Map<string, number[]>(),
    nextId: 1000,
    clock: Date.parse('2026-11-05T10:00:00Z'),
  }
  const pageSize = o.pageSize ?? 30
  const stamp = () => new Date((state.clock += 1000)).toISOString()

  const page = (url: URL, items: unknown[]) => {
    const per = Math.min(Number(url.searchParams.get('per_page') ?? pageSize), pageSize)
    const p = Number(url.searchParams.get('page') ?? '1')
    const slice = items.slice((p - 1) * per, p * per)
    const headers: Record<string, string> = {}
    if (p * per < items.length) {
      const next = new URL(url)
      next.searchParams.set('page', String(p + 1))
      headers.link = `<${next.toString()}>; rel="next"`
    }
    return json(200, slice, headers)
  }

  const pullJson = (p: FakePull) => ({
    number: p.number,
    title: p.title,
    body: p.body,
    user: p.user,
    author_association: p.author_association,
    labels: p.labels.map((name) => ({ name })),
    html_url: p.html_url ?? `https://github.com/${repo}/pull/${p.number}`,
    head: {
      sha: p.headSha,
      repo: p.headRepo === undefined ? { full_name: repo } : p.headRepo && { full_name: p.headRepo },
    },
    base: { repo: { full_name: repo } },
    changed_files: p.files.length,
  })
  const commentJson = (c: FakeComment) => ({
    id: c.id,
    body: c.body,
    user: c.user,
    author_association: c.author_association,
    created_at: c.created_at,
    updated_at: c.updated_at,
    html_url: `https://github.com/${repo}/pull/${c.issue}#issuecomment-${c.id}`,
  })
  const releaseJson = (r: FakeRelease) => ({
    id: r.id,
    tag_name: r.tag_name,
    name: r.name,
    body: r.body,
    html_url: r.html_url,
    upload_url: `${r.upload_url}{?name,label}`,
    assets: r.assets.map((a) => ({ id: a.id, name: a.name, size: a.size, content_type: a.content_type })),
  })

  type Handler = (m: RegExpExecArray, url: URL, body: unknown, raw: Uint8Array | null) => Response
  const R = (s: string) => s.replace(/\{[a-z_]+\}/g, '([^/]+)').replace(/\{repo\}/, repo)
  const routes: [string, string, Handler][] = [
    [
      'GET',
      '/repos/{o}/{r}',
      () =>
        json(200, { full_name: repo, private: state.visibility === 'private', visibility: state.visibility }),
    ],
    [
      'GET',
      '/user',
      () =>
        state.tokenUser.type === 'Bot'
          ? json(403, { message: 'Resource not accessible by integration' })
          : json(200, state.tokenUser),
    ],
    [
      'GET',
      '/repos/{o}/{r}/collaborators/{login}/permission',
      (m) => {
        const login = decodeURIComponent(m[3] ?? '')
        const p = state.permissions[login]
        return p === undefined
          ? json(404, { message: 'Not Found' })
          : json(200, { permission: p, role_name: p, user: { login } })
      },
    ],
    [
      'GET',
      '/repos/{o}/{r}/pulls/{n}',
      (m) => {
        const p = state.pulls.get(Number(m[3]))
        return p ? json(200, pullJson(p)) : json(404, { message: 'Not Found' })
      },
    ],
    [
      'GET',
      '/repos/{o}/{r}/pulls/{n}/commits',
      (m, url) =>
        page(
          url,
          (state.pulls.get(Number(m[3]))?.commits ?? []).map((c) => ({
            sha: c.sha,
            commit: { message: c.message },
          })),
        ),
    ],
    [
      'GET',
      '/repos/{o}/{r}/pulls/{n}/files',
      (m, url) =>
        page(
          url,
          (state.pulls.get(Number(m[3]))?.files ?? []).map((filename) => ({ filename })),
        ),
    ],
    [
      'GET',
      '/repos/{o}/{r}/issues/{n}/comments',
      (m, url) => page(url, state.comments.filter((c) => c.issue === Number(m[3])).map(commentJson)),
    ],
    [
      'POST',
      '/repos/{o}/{r}/issues/{n}/comments',
      (m, _u, body) => {
        const now = stamp()
        const c: FakeComment = {
          id: state.nextId++,
          issue: Number(m[3]),
          body: (body as { body: string }).body,
          user: state.tokenUser,
          author_association: 'NONE',
          created_at: now,
          updated_at: now,
          reactions: [],
        }
        state.comments.push(c)
        return json(201, commentJson(c))
      },
    ],
    [
      'PATCH',
      '/repos/{o}/{r}/issues/comments/{id}',
      (m, _u, body) => {
        const c = state.comments.find((x) => x.id === Number(m[3]))
        if (!c) return json(404, { message: 'Not Found' })
        c.body = (body as { body: string }).body
        c.updated_at = stamp()
        return json(200, commentJson(c))
      },
    ],
    [
      'DELETE',
      '/repos/{o}/{r}/issues/comments/{id}',
      (m) => {
        state.comments = state.comments.filter((x) => x.id !== Number(m[3]))
        return new Response(null, { status: 204 })
      },
    ],
    [
      'POST',
      '/repos/{o}/{r}/issues/comments/{id}/reactions',
      (m, _u, body) => {
        const c = state.comments.find((x) => x.id === Number(m[3]))
        if (!c) return json(404, { message: 'Not Found' })
        const r = {
          id: state.nextId++,
          content: (body as { content: string }).content,
          user: state.tokenUser,
        }
        c.reactions.push(r)
        return json(201, r)
      },
    ],
    [
      'GET',
      '/repos/{o}/{r}/releases/tags/{tag}',
      (m) => {
        const r = state.releases.find((x) => x.tag_name === decodeURIComponent(m[3] ?? ''))
        return r ? json(200, releaseJson(r)) : json(404, { message: 'Not Found' })
      },
    ],
    [
      'PATCH',
      '/repos/{o}/{r}/releases/{id}',
      (m, _u, body) => {
        const r = state.releases.find((x) => x.id === Number(m[3]))
        if (!r) return json(404, { message: 'Not Found' })
        const b = body as { body?: string }
        if (b.body !== undefined) r.body = b.body
        return json(200, releaseJson(r))
      },
    ],
    [
      'GET',
      '/repos/{o}/{r}/releases/{id}/assets',
      (m, url) =>
        page(
          url,
          (state.releases.find((x) => x.id === Number(m[3]))?.assets ?? []).map((a) => ({
            id: a.id,
            name: a.name,
            size: a.size,
          })),
        ),
    ],
    [
      'DELETE',
      '/repos/{o}/{r}/releases/assets/{id}',
      (m) => {
        for (const r of state.releases) r.assets = r.assets.filter((a) => a.id !== Number(m[3]))
        return new Response(null, { status: 204 })
      },
    ],
    [
      'POST',
      '/uploads/repos/{o}/{r}/releases/{id}/assets',
      (m, url, _b, raw) => {
        const r = state.releases.find((x) => x.id === Number(m[3]))
        if (!r) return json(404, { message: 'Not Found' })
        const name = url.searchParams.get('name') ?? 'asset'
        if (r.assets.some((a) => a.name === name)) return json(422, { message: 'already_exists' })
        const a = {
          id: state.nextId++,
          name,
          size: raw?.byteLength ?? 0,
          content_type: 'application/octet-stream',
          bytes: raw ?? new Uint8Array(),
        }
        r.assets.push(a)
        return json(201, { id: a.id, name: a.name, size: a.size })
      },
    ],
    [
      'GET',
      '/repos/{o}/{r}/compare/{basehead}',
      (m) => {
        // A PR's history: base...head is "ahead" when base is one of its commits (or its start), "diverged" otherwise.
        const [from = '', to = ''] = decodeURIComponent(m[3] ?? '').split('...')
        for (const p of state.pulls.values()) {
          if (p.headSha !== to) continue
          const i = p.commits.findIndex((c) => c.sha === from)
          if (i < 0) return json(200, { status: 'diverged', commits: [], files: [] })
          const after = p.commits.slice(i + 1)
          return json(200, {
            status: after.length ? 'ahead' : 'identical',
            commits: after.map((c) => ({ sha: c.sha, commit: { message: c.message } })),
            files: (p.filesBySha ?? {})[to]?.map((filename) => ({ filename })) ?? [],
          })
        }
        return json(404, { message: 'Not Found' })
      },
    ],
    [
      'GET',
      '/repos/{o}/{r}/contents/{path}',
      (m, url) => {
        const path = decodeURIComponent(m[3] ?? '')
        const bytes = state.files.get(`${url.searchParams.get('ref') ?? 'main'}:${path}`)
        if (!bytes) return json(404, { message: 'Not Found' })
        return json(200, {
          type: 'file',
          path,
          size: bytes.byteLength,
          encoding: 'base64',
          content: Buffer.from(bytes).toString('base64'),
          download_url: null,
        })
      },
    ],
    [
      'POST',
      '/graphql',
      (_m, _u, body) => {
        const v = (body as { variables: { number?: number; pr?: number } }).variables
        const p = state.pulls.get(Number(v.number ?? v.pr))
        return json(200, {
          data: { repository: { pullRequest: p ? { bodyHTML: p.bodyHTML ?? p.body ?? '' } : null } },
        })
      },
    ],
  ]
  const compiled = routes.map(([method, pattern, handler]) => ({
    method,
    pattern,
    re: new RegExp(`^${R(pattern)}$`),
    handler,
  }))

  const fetchFn = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init)
    const url = new URL(req.url)
    const method = req.method.toUpperCase()
    const path = url.hostname === 'uploads.github.com' ? `/uploads${url.pathname}` : url.pathname
    const bytes = req.body ? new Uint8Array(await req.arrayBuffer()) : null
    const text = bytes ? new TextDecoder().decode(bytes) : ''
    let body: unknown = undefined
    if (text && (req.headers.get('content-type') ?? '').includes('json')) body = JSON.parse(text)
    const headers: Record<string, string> = {}
    req.headers.forEach((v, k) => (headers[k] = v))
    const route = compiled.find((r) => r.method === method && r.re.test(path))
    const key = route ? `${method} ${route.pattern}` : `${method} ${path}`
    state.requests.set(key, (state.requests.get(key) ?? 0) + 1)
    state.log.push({ method, url: url.toString(), route: key, headers, body })
    state.remaining = Math.max(0, state.remaining - 1)
    const limit = {
      'x-ratelimit-remaining': String(state.remaining),
      'x-ratelimit-limit': String(o.rateLimit ?? 1000),
    }
    const injected = state.failures.get(key)?.shift()
    let res: Response
    if (injected) res = json(injected, { message: `injected ${injected}` })
    else if (!route) res = json(404, { message: `fake GitHub has no route ${key}` })
    else res = route.handler(route.re.exec(path) as RegExpExecArray, url, body, bytes)
    const out = new Headers(res.headers)
    for (const [k, v] of Object.entries(limit)) out.set(k, v)
    return new Response(res.body, { status: res.status, headers: out })
  }

  return {
    repo,
    state,
    fetch: fetchFn,
    /** Adds a PR (own repo by default) and returns it. */
    pull(p: Partial<FakePull> & { number: number }): FakePull {
      const full: FakePull = {
        title: `PR ${p.number}`,
        body: '',
        user: { login: 'dana' },
        author_association: 'CONTRIBUTOR',
        labels: [],
        headSha: `sha${p.number}`.padEnd(40, '0'),
        commits: [],
        files: [],
        ...p,
      }
      state.pulls.set(p.number, full)
      return full
    },
    release(r: Partial<FakeRelease> & { tag_name: string }): FakeRelease {
      const id = state.nextId++
      const full: FakeRelease = {
        id,
        name: r.tag_name,
        body: '',
        html_url: `https://github.com/${repo}/releases/tag/${r.tag_name}`,
        upload_url: `https://uploads.github.com/repos/${repo}/releases/${id}/assets`,
        assets: [],
        ...r,
      }
      state.releases.push(full)
      return full
    },
    /** A comment by someone else (a person's /video command). */
    comment(
      issue: number,
      body: string,
      user: FakeUser = { login: 'dana' },
      association = 'CONTRIBUTOR',
    ): FakeComment {
      const now = stamp()
      const c: FakeComment = {
        id: state.nextId++,
        issue,
        body,
        user,
        author_association: association,
        created_at: now,
        updated_at: now,
        reactions: [],
      }
      state.comments.push(c)
      return c
    },
    commentsOn: (issue: number) => state.comments.filter((c) => c.issue === issue),
    /** The next n responses on this route ("METHOD /pattern") answer with these statuses. */
    fail(route: string, ...statuses: number[]) {
      state.failures.set(route, [...(state.failures.get(route) ?? []), ...statuses])
    },
    count: (route: string) => state.requests.get(route) ?? 0,
  }
}

export type FakeGitHub = ReturnType<typeof fakeGitHub>
