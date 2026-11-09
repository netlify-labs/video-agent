// The session refresh in a Node test: document.cookie, localStorage and the Identity SDK are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  refreshSession: vi.fn<() => Promise<string | null>>(),
  getUser: vi.fn(),
  handleAuthCallback: vi.fn(),
}))
vi.mock('@netlify/identity', () => sdk)

const jwt = (expInSec: number, tag = 'a') =>
  `h.${btoa(JSON.stringify({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + expInSec, tag }))}.s`

let cookies: Record<string, string>
let store: Record<string, string>

function sdkStores(access: string, refresh = 'r1') {
  store['gotrue.user'] = JSON.stringify({ token: { access_token: access, refresh_token: refresh } })
}

beforeEach(() => {
  vi.resetModules()
  cookies = {}
  store = {}
  vi.stubGlobal('document', {
    get cookie() {
      return Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ')
    },
    set cookie(line: string) {
      const [pair] = line.split(';')
      const [k, v] = (pair ?? '').split('=')
      if (k) cookies[k] = v ?? ''
    },
  })
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => (store[k] = v),
    removeItem: (k: string) => {
      store = Object.fromEntries(Object.entries(store).filter(([key]) => key !== k))
    },
  })
  vi.stubGlobal('location', { protocol: 'https:', hostname: 'example.com' })
  vi.stubGlobal('BroadcastChannel', undefined)
  vi.stubGlobal('navigator', {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

const cookieToken = () => decodeURIComponent(cookies.nf_jwt ?? '')

describe('session', () => {
  it('copies a newer SDK token into the nf_jwt cookie, and keeps a newer cookie', async () => {
    const { sessionToken } = await import('./session')
    // Each token is made once: jwt() stamps the current second, which can tick between calls.
    const fresh = jwt(3600, 'new')
    const newest = jwt(7200, 'newest')
    cookies.nf_jwt = encodeURIComponent(jwt(10, 'old'))
    sdkStores(fresh)
    expect(sessionToken()).toBe(fresh)
    expect(cookieToken()).toBe(fresh)
    expect(decodeURIComponent(cookies.nf_refresh ?? '')).toBe('r1')

    cookies.nf_jwt = encodeURIComponent(newest)
    expect(sessionToken()).toBe(newest)
  })

  it('refreshes before a request when the token is about to expire', async () => {
    const { sessionFetch } = await import('./api/client')
    const refreshed = jwt(3600, 'refreshed')
    sdkStores(jwt(30, 'expiring'))
    sdk.refreshSession.mockImplementation(async () => {
      sdkStores(refreshed, 'r2')
      return null
    })
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const res = await sessionFetch(new Request('https://example.com/api/v1/me'))
    expect(res.status).toBe(200)
    expect(sdk.refreshSession).toHaveBeenCalledTimes(1)
    expect(cookieToken()).toBe(refreshed)
  })

  it('refreshes and retries once after a 401', async () => {
    const { sessionFetch } = await import('./api/client')
    const second = jwt(3600, 'second')
    sdkStores(jwt(3600, 'server-rejected'))
    sdk.refreshSession.mockImplementation(async () => {
      sdkStores(second, 'r2')
      return null
    })
    const seen: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (req: Request) => {
        seen.push(new URL(req.url).pathname)
        return new Response('{}', { status: seen.length === 1 ? 401 : 200 })
      }),
    )
    const res = await sessionFetch(
      new Request('https://example.com/api/v1/videos', { method: 'POST', body: '{"a":1}' }),
    )
    expect(res.status).toBe(200)
    expect(seen).toEqual(['/api/v1/videos', '/api/v1/videos'])
    expect(cookieToken()).toBe(second)
  })

  it('signs out when Identity rejects the session, and keeps it on a network error', async () => {
    const { sessionFetch } = await import('./api/client')
    const { onSessionLost } = await import('./session')
    const lost = vi.fn()
    onSessionLost(lost)
    sdkStores(jwt(3600))
    sdk.refreshSession.mockResolvedValue(null)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401 })),
    )
    expect((await sessionFetch(new Request('https://example.com/api/v1/me'))).status).toBe(401)
    expect(lost).toHaveBeenCalledTimes(1)

    vi.stubGlobal(
      'fetch',
      vi.fn(async (req: Request | string) => {
        if ((typeof req === 'string' ? req : req.url).includes('/.netlify/identity/'))
          throw new TypeError('offline')
        return new Response('{}', { status: 401 })
      }),
    )
    await sessionFetch(new Request('https://example.com/api/v1/me'))
    expect(lost).toHaveBeenCalledTimes(1)
  })
})
