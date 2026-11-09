// The page's side of the media cache (sw.ts): registers the worker and deletes the cache when the person changes.
import { CACHE_PREFIX } from './policy'

const OWNER_KEY = 'va-media-owner'

/** Production builds only: the dev server and the mock build have no /files. */
const enabled = () => import.meta.env.PROD && !import.meta.env.VITE_MOCK && 'serviceWorker' in navigator

/** Registers /sw.js for the signed-in app. Its fetch handler only answers version files under /files/. */
export function registerMediaCache() {
  if (!enabled()) return
  void navigator.serviceWorker
    .register('/sw.js', { scope: '/', updateViaCache: 'none' })
    .catch(() => undefined)
}

/** Deletes every media cache. Safe to call without a worker. */
export async function clearMediaCache() {
  try {
    localStorage.removeItem(OWNER_KEY)
  } catch {
    // Storage blocked: the caches still go.
  }
  try {
    if (typeof caches === 'undefined') return
    for (const name of await caches.keys()) if (name.startsWith(CACHE_PREFIX)) await caches.delete(name)
  } catch {
    // No Cache Storage (private mode in some browsers): nothing was kept.
  }
}

/** Ties the cache to the signed-in person: when someone else signed in last, their entries are deleted first. */
export async function claimMediaCache(userId: string) {
  if (!enabled()) return
  let owner: string | null
  try {
    owner = localStorage.getItem(OWNER_KEY)
  } catch {
    owner = null
  }
  if (owner !== userId) await clearMediaCache()
  try {
    localStorage.setItem(OWNER_KEY, userId)
  } catch {
    // Without storage every start clears the cache, which is only slower.
  }
}
