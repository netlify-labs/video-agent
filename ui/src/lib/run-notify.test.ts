import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WATCH_KEY,
  WATCH_TTL_MS,
  doneMessage,
  isWatched,
  readPref,
  readWatches,
  runEnded,
  savePref,
  showRunNotification,
  unwatchRun,
  watchRun,
} from './run-notify'

const memory = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the watch list', () => {
  it('adds a video once and removes it', () => {
    const kv = memory()
    const t = Date.now()
    watchRun('vid_a', kv, t)
    watchRun('vid_a', kv, t + 1)
    watchRun('vid_b', kv, t + 2)
    expect(readWatches(kv, t + 2)).toEqual([
      { id: 'vid_a', since: t },
      { id: 'vid_b', since: t + 2 },
    ])
    unwatchRun('vid_a', kv, t + 2)
    expect(isWatched('vid_a', kv)).toBe(false)
    expect(isWatched('vid_b', kv)).toBe(true)
  })

  it('drops watches older than a day, and survives junk in storage', () => {
    const kv = memory()
    watchRun('vid_old', kv, 0)
    expect(readWatches(kv, WATCH_TTL_MS + 1)).toEqual([])
    kv.setItem(WATCH_KEY, '{nope')
    expect(readWatches(kv)).toEqual([])
    kv.setItem(WATCH_KEY, JSON.stringify([{ id: 1 }, 'x', null, { id: 'vid_ok', since: 5 }]))
    expect(readWatches(kv, 10)).toEqual([{ id: 'vid_ok', since: 5 }])
  })

  it('works without storage (private mode)', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(() => watchRun('vid_a', broken)).not.toThrow()
    expect(readWatches(broken)).toEqual([])
    expect(readPref(broken)).toBe(false)
    expect(() => savePref(true, broken)).not.toThrow()
  })

  it('keeps the Notify choice', () => {
    const kv = memory()
    expect(readPref(kv)).toBe(false)
    savePref(true, kv)
    expect(readPref(kv)).toBe(true)
  })
})

describe('when a run ends', () => {
  it('counts ready, failed and timed out as ended, and finishing as still going', () => {
    expect(['queued', 'running', 'finishing'].map(runEnded)).toEqual([false, false, false])
    expect(['ready', 'failed', 'timed_out', 'cancelled'].map(runEnded)).toEqual([true, true, true, true])
  })

  it('says ready or not', () => {
    expect(doneMessage('Launch', 'ready')).toBe('"Launch" is ready.')
    expect(doneMessage('Launch', 'failed')).toBe('"Launch" didn\'t finish.')
    expect(doneMessage('Launch', 'timed_out')).toBe('"Launch" didn\'t finish.')
  })
})

describe('showRunNotification', () => {
  const stubNotification = (permission: string) => {
    const shown: { title: string; options: unknown }[] = []
    class FakeNotification {
      static permission = permission
      onclick: (() => void) | null = null
      constructor(title: string, options: unknown) {
        shown.push({ title, options })
      }
      close() {}
    }
    vi.stubGlobal('Notification', FakeNotification)
    vi.stubGlobal('window', { focus: () => undefined })
    return shown
  }

  it('shows nothing without permission', async () => {
    const shown = stubNotification('default')
    expect(await showRunNotification('"A" is ready.', '/videos/a', () => undefined, undefined)).toBe(false)
    expect(shown).toEqual([])
  })

  it('goes through the service worker when one is active, tagged per video', async () => {
    const shown = stubNotification('granted')
    const showNotification = vi.fn(() => Promise.resolve())
    const sw = { getRegistration: () => Promise.resolve({ active: {}, showNotification }) }
    expect(await showRunNotification('"A" is ready.', '/videos/a', () => undefined, sw)).toBe(true)
    expect(showNotification).toHaveBeenCalledWith('"A" is ready.', {
      body: 'Video Agent',
      tag: 'va-run:/videos/a',
      data: { url: '/videos/a' },
    })
    expect(shown).toEqual([])
  })

  it('falls back to the constructor without a worker, or when the worker fails', async () => {
    const shown = stubNotification('granted')
    const none = { getRegistration: () => Promise.resolve(undefined) }
    expect(await showRunNotification('"A" is ready.', '/videos/a', () => undefined, none)).toBe(true)
    const failing = {
      getRegistration: () =>
        Promise.resolve({ active: {}, showNotification: () => Promise.reject(new Error('no')) }),
    }
    expect(await showRunNotification('"B" didn\'t finish.', '/videos/b', () => undefined, failing)).toBe(true)
    expect(shown.map((s) => s.title)).toEqual(['"A" is ready.', '"B" didn\'t finish.'])
  })
})
