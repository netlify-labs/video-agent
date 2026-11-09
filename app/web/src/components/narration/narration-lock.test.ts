// The narration lock session's timers (plan 2026-11-02 §2.7), on fake timers: acquire at once, heartbeat every 30 s,
// retry while someone else holds it, stop on take over, release on stop only when held.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HEARTBEAT_MS, NarrationLockSession, type LockApi, type LockResult } from './narration-lock'

const SINCE = '2026-11-03T14:02:00Z'
const held: LockResult = { ok: true, mine: true, holder: { userId: 'u_me', name: 'Me', since: SINCE } }
const dana = { userId: 'u_dana', name: 'Dana', since: SINCE }

function fakeApi(results: LockResult[]) {
  const calls: string[] = []
  const api: LockApi = {
    acquire: vi.fn(async (heartbeat: boolean) => {
      calls.push(heartbeat ? 'heartbeat' : 'acquire')
      return results.shift() ?? held
    }),
    takeOver: vi.fn(async () => {
      calls.push('takeOver')
      return held
    }),
    release: vi.fn(() => {
      calls.push('release')
    }),
  }
  return { api, calls }
}
const flush = () => vi.advanceTimersByTimeAsync(0)

describe('NarrationLockSession', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('acquires on start, heartbeats every 30 s and releases on stop', async () => {
    const { api, calls } = fakeApi([])
    const s = new NarrationLockSession(api)
    s.start()
    await flush()
    expect(s.state).toEqual({ status: 'held', since: SINCE })
    expect(s.canEdit).toBe(true)
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3)
    expect(calls).toEqual(['acquire', 'heartbeat', 'heartbeat', 'heartbeat'])
    s.stop()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2)
    expect(calls.at(-1)).toBe('release')
    expect(calls.filter((c) => c === 'heartbeat')).toHaveLength(3)
  })

  it("retries while someone else holds it, takes it when it's free, and never releases theirs", async () => {
    const busy: LockResult = { ok: false, status: 409, message: 'Dana is editing', holder: dana }
    const { api, calls } = fakeApi([busy, busy])
    const changes: string[] = []
    const s = new NarrationLockSession(api, (st) => changes.push(st.status))
    s.start()
    await flush()
    expect(s.state).toEqual({ status: 'locked', holder: dana })
    expect(s.canEdit).toBe(false)
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(s.state.status).toBe('locked')
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(s.state.status).toBe('held')
    // Retries are acquires, not heartbeats: nobody here believed it held the lock.
    expect(calls).toEqual(['acquire', 'acquire', 'acquire'])
    expect(changes).toEqual(['locked', 'locked', 'held'])
    const other = fakeApi([busy])
    const t = new NarrationLockSession(other.api)
    t.start()
    await flush()
    t.stop()
    expect(other.calls).not.toContain('release')
  })

  it('stops heartbeating once taken over, until it takes the lock back', async () => {
    const taken: LockResult = {
      ok: false,
      status: 409,
      message: 'Sam took over the narration.',
      holder: { userId: 'u_sam', name: 'Sam', since: SINCE },
      takenOverBy: { userId: 'u_sam', name: 'Sam' },
      at: SINCE,
    }
    const { api, calls } = fakeApi([held, taken])
    const s = new NarrationLockSession(api)
    s.start()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(s.state).toEqual({ status: 'taken_over', by: { userId: 'u_sam', name: 'Sam' }, at: SINCE })
    expect(s.canEdit).toBe(false)
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 4)
    expect(calls).toEqual(['acquire', 'heartbeat'])
    await s.takeOver()
    expect(s.state.status).toBe('held')
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(calls).toEqual(['acquire', 'heartbeat', 'takeOver', 'heartbeat'])
    s.stop()
  })

  it('keeps the hold through a failed heartbeat (the server allows 2 min)', async () => {
    let offline = false
    const { api } = fakeApi([])
    const s = new NarrationLockSession({
      ...api,
      acquire: async (heartbeat) => {
        if (offline) throw new Error('offline')
        return api.acquire(heartbeat)
      },
    })
    s.start()
    await flush()
    offline = true
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(s.state.status).toBe('held')
    s.stop()
  })
})
