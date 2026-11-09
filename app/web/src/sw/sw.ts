// The media service worker, served at /sw.js (built by the plugin in app/web/vite.config.ts). It answers only the
// version files policy.ts allows, cache first, keyed by path without the signature, so a poster or hover clip seen
// once loads instantly after its signed URL has rotated. Every other request (pages, /api, the full video, /v/ share
// pages, /preview frames) isn't touched and goes to the network as if there were no worker.
//
// Privacy: an entry exists only after this browser downloaded those bytes through a URL that passed the edge's
// signature check, and a version's files never change. A cached copy can still be shown for a video the person has
// since lost access to, but only bytes they already downloaded; nothing new is fetched for it. Sign-out, a lost
// session and a different person signing in delete the cache (app/web/src/sw/register.ts).
import { CACHE_NAME, CACHE_PREFIX, cacheKey, cacheableResponse, parseRange, pickEvictions } from './policy'

// The worker globals this uses, declared here because the UI typechecks against the DOM library.
interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void
}
interface FetchEvent extends ExtendableEvent {
  request: Request
  respondWith(r: Response | Promise<Response>): void
}
interface NotificationEvent extends ExtendableEvent {
  notification: { data?: { url?: unknown }; close(): void }
}
interface WindowClient {
  url: string
  focus(): Promise<WindowClient>
  navigate(url: string): Promise<WindowClient | null>
}
declare const self: {
  location: Location
  skipWaiting(): Promise<void>
  clients: {
    claim(): Promise<void>
    matchAll(o: { type: 'window'; includeUncontrolled: boolean }): Promise<WindowClient[]>
    openWindow(url: string): Promise<WindowClient | null>
  }
  addEventListener(type: 'install' | 'activate', fn: (e: ExtendableEvent) => void): void
  addEventListener(type: 'fetch', fn: (e: FetchEvent) => void): void
  addEventListener(type: 'notificationclick', fn: (e: NotificationEvent) => void): void
}

self.addEventListener('install', (e) => {
  e.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) await caches.delete(name)
      await self.clients.claim()
    })(),
  )
})

// A "your video is ready" notification (app/web/src/lib/run-notify.ts): clicking it opens that video, in an open tab of
// the app when there is one.
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const raw = e.notification.data?.url
  if (typeof raw !== 'string' || !raw.startsWith('/videos/')) return
  const url = new URL(raw, self.location.origin).href
  e.waitUntil(
    (async () => {
      const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const tab = tabs.find((c) => c.url === url) ?? tabs[0]
      if (!tab) {
        await self.clients.openWindow(url)
        return
      }
      await tab.focus()
      if (tab.url !== url) await tab.navigate(url).catch(() => null)
    })().catch(() => undefined),
  )
})

self.addEventListener('fetch', (e) => {
  const key = cacheKey(e.request, self.location.origin)
  if (!key) return
  e.respondWith(answer(e, key))
})

async function answer(e: FetchEvent, key: string): Promise<Response> {
  const range = e.request.headers.get('range')
  const cache = await caches.open(CACHE_NAME).catch(() => null)
  if (!cache) return fetch(e.request)
  const hit = await cache.match(key).catch(() => undefined)
  if (hit) return range ? partial(hit, range) : hit
  // A clip asks for a range. It's small, so fetch it whole once, keep it, and answer the range from that.
  const res = await fetch(range ? new Request(e.request.url, { credentials: 'same-origin' }) : e.request)
  if (!cacheableResponse(res)) {
    if (!range) return res
    void res.body?.cancel()
    return fetch(e.request)
  }
  const kept = res.clone()
  e.waitUntil(store(cache, key, kept))
  return range ? partial(res, range) : res
}

async function store(cache: Cache, key: string, res: Response) {
  try {
    await cache.put(key, res)
    await trim(cache)
  } catch {
    // Quota or a body that failed midway: the response was still served; it just isn't kept.
  }
}

let trimming: Promise<void> | null = null

/** Deletes the oldest entries beyond the count and size limits. One pass at a time. */
function trim(cache: Cache): Promise<void> {
  trimming ??= (async () => {
    const keys = await cache.keys()
    const entries = await Promise.all(
      keys.map(async (k) => {
        const r = await cache.match(k)
        return { key: k.url, bytes: Number(r?.headers.get('content-length') ?? 0) }
      }),
    )
    for (const key of pickEvictions(entries)) await cache.delete(key)
  })().finally(() => {
    trimming = null
  })
  return trimming
}

/** A 206 (or 416) for one range of a whole cached body, the way the edge answers it. */
async function partial(full: Response, header: string): Promise<Response> {
  const body = await full.blob()
  const r = parseRange(header, body.size)
  const type = full.headers.get('content-type') ?? 'application/octet-stream'
  if (r === null)
    return new Response(body, { status: 200, headers: { 'content-type': type, 'accept-ranges': 'bytes' } })
  if (r === 'unsatisfiable')
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${body.size}` } })
  return new Response(body.slice(r.start, r.end + 1), {
    status: 206,
    headers: {
      'content-type': type,
      'content-length': String(r.end - r.start + 1),
      'content-range': `bytes ${r.start}-${r.end}/${body.size}`,
      'accept-ranges': 'bytes',
    },
  })
}
