// "Notify me when it's done" (the video page's Notify button). The button adds the video to a watch list kept in
// localStorage, and RunWatcher (mounted for the whole signed-in app) polls each watched video, in a background tab
// too, until its run ends, then shows one browser notification and drops the watch. The video page alone can't do it:
// it stops polling when the tab is hidden and unmounts when the person goes to another page, which are exactly the
// times a notification is for.

type KV = Pick<Storage, 'getItem' | 'setItem'>

export const WATCH_KEY = 'va-notify-watch'
/** The person's choice on the Notify button, which carries over to the next run they watch. */
export const PREF_KEY = 'notify'
/** A watch older than this is dropped: a run that long has ended, and a notification a day late is noise. */
export const WATCH_TTL_MS = 24 * 60 * 60 * 1000

export type Watch = { id: string; since: number }
export type RunStatus = 'queued' | 'running' | 'finishing' | 'ready' | 'failed' | 'timed_out' | (string & {})

const store = (): KV | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

const listeners = new Set<() => void>()
const changed = () => {
  for (const l of listeners) l()
}

/** The watched videos, without expired ones. */
export function readWatches(kv: KV | null = store(), now = Date.now()): Watch[] {
  let raw: string | null
  try {
    raw = kv?.getItem(WATCH_KEY) ?? null
  } catch {
    return []
  }
  if (!raw) return []
  try {
    const list: unknown = JSON.parse(raw)
    if (!Array.isArray(list)) return []
    return list.filter(
      (w): w is Watch =>
        typeof w === 'object' &&
        w !== null &&
        typeof (w as Watch).id === 'string' &&
        typeof (w as Watch).since === 'number' &&
        now - (w as Watch).since < WATCH_TTL_MS,
    )
  } catch {
    return []
  }
}

function write(kv: KV | null, list: Watch[]) {
  try {
    kv?.setItem(WATCH_KEY, JSON.stringify(list))
  } catch {
    // Private mode: the watch lasts only while this page is open (RunWatcher keeps what it has).
  }
  changed()
}

export function watchRun(id: string, kv: KV | null = store(), now = Date.now()) {
  const list = readWatches(kv, now)
  if (list.some((w) => w.id === id)) return
  write(kv, [...list, { id, since: now }])
}

export function unwatchRun(id: string, kv: KV | null = store(), now = Date.now()) {
  const list = readWatches(kv, now)
  if (!list.some((w) => w.id === id)) return
  write(
    kv,
    list.filter((w) => w.id !== id),
  )
}

export const isWatched = (id: string, kv: KV | null = store()) => readWatches(kv).some((w) => w.id === id)

/** For useSyncExternalStore: changes in this tab, and in other tabs through the storage event. */
export function subscribeWatches(fn: () => void): () => void {
  listeners.add(fn)
  const onStorage = (e: StorageEvent) => {
    if (e.key === WATCH_KEY || e.key === null) fn()
  }
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(fn)
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
  }
}

/** A stable snapshot for useSyncExternalStore: the watched ids, sorted and joined. */
export const watchSnapshot = () =>
  readWatches()
    .map((w) => w.id)
    .sort()
    .join(',')

export const runEnded = (s: RunStatus) => s !== 'queued' && s !== 'running' && s !== 'finishing'

export const doneMessage = (title: string, status: RunStatus) =>
  status === 'ready' ? `"${title}" is ready.` : `"${title}" didn't finish.`

export function readPref(kv: KV | null = store()): boolean {
  try {
    return kv?.getItem(PREF_KEY) === '1'
  } catch {
    return false
  }
}

export function savePref(on: boolean, kv: KV | null = store()) {
  try {
    kv?.setItem(PREF_KEY, on ? '1' : '0')
  } catch {
    // private mode
  }
}

export const canNotify = () => typeof Notification !== 'undefined' && Notification.permission === 'granted'

type ShowOptions = { body?: string; tag?: string; data?: { url: string } }
type Registration = { active: unknown; showNotification(title: string, o?: ShowOptions): Promise<void> }
type Workers = { getRegistration(): Promise<Registration | undefined> }

/**
 * Shows a browser notification for a finished run. Through the service worker when one controls the page (Chrome
 * on Android has no Notification constructor, and a worker's notification opens the video when clicked), else with
 * the constructor. The tag is per video, so two open tabs replace each other's notification instead of doubling it.
 * Resolves true when one was shown.
 */
export async function showRunNotification(
  msg: string,
  url: string,
  onClick: () => void,
  sw: Workers | undefined = typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    ? navigator.serviceWorker
    : undefined,
): Promise<boolean> {
  if (!canNotify()) return false
  const options = { body: 'Video Agent', tag: `va-run:${url}`, data: { url } }
  try {
    const reg = await sw?.getRegistration()
    if (reg?.active) {
      await reg.showNotification(msg, options)
      return true
    }
  } catch {
    // No worker, or it refused: try the constructor.
  }
  try {
    const n = new Notification(msg, options)
    n.onclick = () => {
      window.focus()
      onClick()
      n.close()
    }
    return true
  } catch {
    return false
  }
}
