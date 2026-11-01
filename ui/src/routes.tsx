// Route modules loaded on demand. Loading one again returns the same module, so warming it (on idle, or when a link
// is hovered) makes the later navigation instant: a page whose module is already here renders without suspending.
import { lazy, useState, type ComponentType } from 'react'

export interface RouteModule<M> {
  load: () => Promise<M>
  /** The module once it has loaded. */
  loaded: () => M | undefined
}

function route<M>(importer: () => Promise<M>): RouteModule<M> {
  let mod: M | undefined
  return {
    load: () =>
      importer().then((m) => {
        mod = m
        return m
      }),
    loaded: () => mod,
  }
}

export const videoRoute = route(() => import('./pages/Video'))
export const newVideoRoute = route(() => import('./pages/NewVideo'))
export const editRoute = route(() => import('./pages/Edit'))
export const mediaRoute = route(() => import('./pages/Media'))
export const keysRoute = route(() => import('./pages/Keys'))
export const adminRoute = route(() => import('./pages/Admin'))
export const setupRoute = route(() => import('./pages/Setup'))
export const docsRoute = route(() => import('./pages/Docs'))

/**
 * A page component from a route module: the module's component when it has loaded, else a React.lazy one that
 * suspends until it has (with Suspense's fallback, and React's reveal delay). Chosen once per mount, so a page never
 * remounts when its module arrives.
 */
export function lazyPage<M, P extends object>(r: RouteModule<M>, pick: (m: M) => ComponentType<P>) {
  const Lazy = lazy(() => r.load().then((m) => ({ default: pick(m) })))
  return function RoutePage(props: P) {
    const [Page] = useState<ComponentType<P>>(() => {
      const m = r.loaded()
      return m ? pick(m) : Lazy
    })
    return <Page {...props} />
  }
}

const BY_PATH: Record<string, RouteModule<unknown>> = {
  '/new': newVideoRoute,
  '/media': mediaRoute,
  '/keys': keysRoute,
  '/admin': adminRoute,
  '/setup': setupRoute,
  '/docs': docsRoute,
}

/** On a direct visit to a page, starts loading its module alongside the app instead of after the app has rendered. */
export function preloadRoute(path: string) {
  const r = /^\/videos\/[^/]+\/edit\//.test(path)
    ? editRoute
    : path.startsWith('/videos/')
      ? videoRoute
      : BY_PATH[path]
  void r?.load().catch(() => undefined)
}

/** Fetches the routes people open most once the browser is idle (not Docs, the API reference is large). */
export function warmRoutes() {
  const warm = () => {
    for (const r of [videoRoute, newVideoRoute, mediaRoute, keysRoute, adminRoute, editRoute])
      void r.load().catch(() => undefined)
  }
  if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 4000 })
  else setTimeout(warm, 2000)
}
