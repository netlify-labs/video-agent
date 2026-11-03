// The narration soft lock in the browser (docs/plans/2026-11-02-record-your-own-voiceover.md §2.7): opening the
// Narration track acquires the video's lock, a heartbeat keeps it every 30 s and closing releases it. While someone
// else holds it the session retries every 30 s (it's free again 2 min after their last heartbeat) and the banner
// offers Watch and Take over. When someone takes it over, the next heartbeat is refused with who did: the session
// stops heartbeating, Record and save turn off, and the draft stays as it is until its author takes the lock back.
// Pure (no React), so the timers are unit-tested with fake timers; useNarrationLock wraps it.

export const HEARTBEAT_MS = 30_000

export interface LockHolder {
  userId: string
  name: string
  since: string
}

export type NarrationLockState =
  | { status: 'acquiring' }
  /** You hold it: Record and save are on. */
  | { status: 'held'; since: string }
  /** Someone else is editing the narration. */
  | { status: 'locked'; holder: LockHolder | null }
  /** Someone took it over from you; your draft is saved. */
  | { status: 'taken_over'; by: { userId: string; name: string }; at: string }
  | { status: 'error'; message: string }

/** What a lock request comes back as: the lock, or the 409's details. */
export type LockResult =
  | { ok: true; holder: LockHolder | null; mine: boolean }
  | {
      ok: false
      status: number
      message: string
      holder?: LockHolder | null
      takenOverBy?: { userId: string; name: string }
      at?: string
    }

export interface LockApi {
  acquire(heartbeat: boolean): Promise<LockResult>
  takeOver(): Promise<LockResult>
  /** Best effort, and must survive the page going away (keepalive). */
  release(): void
}

export class NarrationLockSession {
  state: NarrationLockState = { status: 'acquiring' }
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(
    private readonly api: LockApi,
    private readonly onChange: (s: NarrationLockState) => void = () => undefined,
  ) {}

  /** Acquire now, then heartbeat (or retry) every 30 s. */
  start() {
    this.stopped = false
    void this.tick(false)
    this.schedule()
  }

  /** Stops the timers and releases the lock if this session holds it. */
  stop() {
    this.stopped = true
    this.clear()
    if (this.state.status === 'held') this.api.release()
  }

  /** Take over: unconditional; heartbeats start again. */
  async takeOver() {
    const r = await this.api.takeOver()
    if (this.stopped) return
    this.apply(r, false)
    if (this.state.status === 'held') this.schedule()
  }

  /** Record and save need the lock. */
  get canEdit() {
    return this.state.status === 'held'
  }

  private schedule() {
    this.clear()
    this.timer = setInterval(() => void this.tick(this.state.status === 'held'), HEARTBEAT_MS)
  }

  private clear() {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  private async tick(heartbeat: boolean) {
    // Taken over: nothing until its author takes it back.
    if (this.state.status === 'taken_over') return
    let r: LockResult
    try {
      r = await this.api.acquire(heartbeat)
    } catch (e) {
      r = { ok: false, status: 0, message: e instanceof Error ? e.message : 'The lock request failed.' }
    }
    if (!this.stopped) this.apply(r, heartbeat)
  }

  private apply(r: LockResult, heartbeat: boolean) {
    if (r.ok) this.set({ status: 'held', since: r.holder?.since ?? new Date().toISOString() })
    else if (r.status === 409 && heartbeat && r.takenOverBy) {
      this.clear()
      this.set({ status: 'taken_over', by: r.takenOverBy, at: r.at ?? new Date().toISOString() })
    } else if (r.status === 409) this.set({ status: 'locked', holder: r.holder ?? null })
    // A network blip on a heartbeat keeps the hold: the server gives 2 min.
    else if (!(heartbeat && r.status === 0)) this.set({ status: 'error', message: r.message })
  }

  private set(s: NarrationLockState) {
    this.state = s
    this.onChange(s)
  }
}

/** "14:02": when a lock was taken, in the viewer's time. */
export const lockTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
