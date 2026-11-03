// The narration soft lock (plan 2026-11-02 §2.7, §6.1 narration_locks): acquire or heartbeat, lapse after 2 min,
// unconditional take over that tells the previous holder, holder-only release, and the narration op save that needs
// it. Two Creators race on one video, on both stores.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SAMPLE_RATE } from '../src/lib/timeline.js'
import type { Store } from '../src/store/types.js'
import { harness, person, pgStore, PROMPT, upload, type Harness } from './helpers.js'
import { tarGz } from './tarball.js'

const fx = (f: string) => readFileSync(new URL(`./fixtures/contract1/${f}`, import.meta.url), 'utf8')
const tone = () => new Uint8Array(readFileSync(new URL('./fixtures/audio/tone.mp3', import.meta.url)))
const S = SAMPLE_RATE

const narration = (mediaId: string) => ({
  op: 'narration',
  schema: 1,
  sampleRate: S,
  clips: [
    {
      id: 'c1',
      mediaId,
      srcStart: 0,
      srcEnd: 2 * S,
      fit: { a: 0, b: 1 / S, residualMs: 0 },
      offsetSamples: 0,
      start: S,
      gainDb: 0,
      fadeInSamples: 0,
      fadeOutSamples: 0,
    },
  ],
  tracks: {
    narration: { volumeDb: 0, muted: false, solo: false },
    aiVoice: { mode: 'replace', volumeDb: -12 },
    music: { duck: true, duckDb: -12 },
    original: { muteAll: false },
  },
  cleanup: 'light',
})

interface Lock {
  holder: { userId: string; name: string; since: string } | null
  mine: boolean
  draftId: string | null
  expiresAt: string | null
}
const errorOf = async (res: Response) => {
  const body = (await res.json()) as {
    error: { code: string; message: string; details?: Record<string, unknown> }
  }
  return { status: res.status, ...body.error }
}

describe('narration lock', () => {
  beforeEach(() => vi.stubGlobal('Netlify', { env: { get: () => undefined } }))
  afterEach(() => vi.unstubAllGlobals())

  /** A ready, editable video, a second Creator (Dana, named u_dana), and a draft each. */
  async function setup(store?: Store) {
    const h = harness({}, store ? { store } : {})
    h.deps.nextSource = tarGz([
      { name: 'video/index.html', body: fx('index.html') },
      { name: 'video/summary.json', body: fx('summary.json') },
    ])
    const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
    await h.drive(4)
    const id = v.id as string
    const dana = await person(h, 'u_dana', 'creator')
    const draft = async (as: string) =>
      (await h.json<{ id: string }>(await h.call('POST', `/api/v1/videos/${id}/versions/1/edits`, { as }))).id
    return { h, id, dana, mine: await draft(h.member), danas: await draft(dana) }
  }
  const lock = (h: Harness, id: string) => `/api/v1/videos/${id}/narration-lock`
  const acquire = (h: Harness, id: string, as: string, draftId: string, heartbeat?: boolean) =>
    h.call('POST', lock(h, id), { as, body: { draftId, ...(heartbeat ? { heartbeat } : {}) } })

  const stores: [string, () => Promise<Store | undefined>][] = [
    ['memory', async () => undefined],
    ['postgres', pgStore],
  ]

  it.each(stores)(
    'acquires, heartbeats, refuses others, lapses after 2 min (%s)',
    async (_n, make) => {
      const { h, id, dana, mine, danas } = await setup(await make())
      expect(await h.json<Lock>(await h.call('GET', lock(h, id), { as: dana }))).toMatchObject({
        holder: null,
      })
      const first = await h.json<Lock>(await acquire(h, id, h.member, mine))
      expect(first).toMatchObject({
        mine: true,
        draftId: mine,
        holder: { userId: 'u_member', name: 'Mia Member' },
      })
      // Dana sees who holds it, without the draft id, and can't take it by acquiring.
      expect(await h.json<Lock>(await h.call('GET', lock(h, id), { as: dana }))).toMatchObject({
        mine: false,
        draftId: null,
        holder: { userId: 'u_member', since: first.holder!.since },
      })
      const refused = await errorOf(await acquire(h, id, dana, danas))
      expect(refused).toMatchObject({
        status: 409,
        code: 'narration_locked',
        message: 'Mia Member is editing the narration.',
      })
      expect(refused.details).toEqual({ holder: first.holder })
      // A heartbeat keeps the hold, and when it was taken.
      h.deps.clock.advance(90_000)
      const beat = await h.json<Lock>(await acquire(h, id, h.member, mine, true))
      expect(beat.holder!.since).toBe(first.holder!.since)
      expect(Date.parse(beat.expiresAt!)).toBeGreaterThan(Date.parse(first.expiresAt!))
      h.deps.clock.advance(90_000)
      expect((await acquire(h, id, dana, danas)).status).toBe(409)
      // 2 min without one: free, and Dana takes it.
      h.deps.clock.advance(31_000)
      expect(await h.json<Lock>(await h.call('GET', lock(h, id), { as: dana }))).toMatchObject({
        holder: null,
      })
      expect(await h.json<Lock>(await acquire(h, id, dana, danas))).toMatchObject({
        mine: true,
        holder: { userId: 'u_dana', name: 'u_dana' },
      })
    },
    60_000,
  )

  it.each(stores)(
    'take over moves it and tells the previous holder (%s)',
    async (_n, make) => {
      const { h, id, dana, mine, danas } = await setup(await make())
      const held = await h.json<Lock>(await acquire(h, id, dana, danas))
      h.deps.clock.advance(5_000)
      const took = await h.json<{ lock: Lock; previous: Lock['holder'] }>(
        await h.call('POST', `${lock(h, id)}/take-over`, { as: h.member, body: { draftId: mine } }),
      )
      expect(took.previous).toEqual({ userId: 'u_dana', name: 'u_dana', since: held.holder!.since })
      expect(took.lock).toMatchObject({ mine: true, holder: { userId: 'u_member' } })
      // Dana's next heartbeat says who took over and when; her draft is untouched.
      const beat = await errorOf(await acquire(h, id, dana, danas, true))
      expect(beat).toMatchObject({ status: 409, code: 'narration_locked' })
      expect(beat.message).toBe(
        'Mia Member took over the narration. Your draft is saved; you can render it or discard it.',
      )
      expect(beat.details).toMatchObject({
        takenOverBy: { userId: 'u_member', name: 'Mia Member' },
        at: took.lock.holder!.since,
      })
      expect(await h.deps.store.getEdit(danas)).not.toBeNull()
      // Taking it back works the same way; with no live holder there's no previous one.
      const back = await h.json<{ previous: Lock['holder'] }>(
        await h.call('POST', `${lock(h, id)}/take-over`, { as: dana, body: { draftId: danas } }),
      )
      expect(back.previous).toMatchObject({ userId: 'u_member' })
      h.deps.clock.advance(3 * 60_000)
      const lapsed = await h.json<{ previous: Lock['holder'] }>(
        await h.call('POST', `${lock(h, id)}/take-over`, { as: h.member, body: { draftId: mine } }),
      )
      expect(lapsed.previous).toBeNull()
    },
    60_000,
  )

  it.each(stores)(
    'only the holder releases; a narration save needs the lock (%s)',
    async (_n, make) => {
      const { h, id, dana, mine, danas } = await setup(await make())
      const m = await h.json<{ id: string }>(await upload(h, h.member, tone(), 'filename=take.mp3'))
      await h.deps.store.updateMedia(m.id, { role: 'narration-take', scopeJobId: id, durationSec: 20 })
      const save = (rev: number, ops: object[]) =>
        h.call('PUT', `/api/v1/edits/${mine}`, { as: h.member, body: { rev, ops } })
      // No lock: refused, with nothing saved.
      expect(await errorOf(await save(0, [narration(m.id)]))).toMatchObject({
        status: 409,
        code: 'narration_locked',
      })
      expect((await h.deps.store.getEdit(mine))?.rev).toBe(0)
      // Other edits don't need it.
      expect((await save(0, [{ op: 'retime', beat: 'intro', duration: 4 }])).status).toBe(200)
      await acquire(h, id, h.member, mine)
      expect((await save(1, [narration(m.id)])).status).toBe(200)
      // Dana can't release it for me; after Dana takes over, my save is refused and says so.
      expect((await h.call('DELETE', lock(h, id), { as: dana })).status).toBe(204)
      expect(await h.json<Lock>(await h.call('GET', lock(h, id), { as: dana }))).toMatchObject({
        holder: { userId: 'u_member' },
      })
      await h.call('POST', `${lock(h, id)}/take-over`, { as: dana, body: { draftId: danas } })
      const taken = await errorOf(await save(2, [narration(m.id)]))
      expect(taken).toMatchObject({ status: 409, code: 'narration_locked' })
      expect(taken.details).toMatchObject({ takenOverBy: { userId: 'u_dana', name: 'u_dana' } })
      // Dana releases hers; it's free.
      expect((await h.call('DELETE', lock(h, id), { as: dana })).status).toBe(204)
      expect(await h.json<Lock>(await h.call('GET', lock(h, id), { as: h.member }))).toMatchObject({
        holder: null,
      })
      expect(h.deps.logs.some((l) => l.includes('narration_lock.released'))).toBe(true)
    },
    60_000,
  )

  it.each(stores)(
    'concurrent acquires: exactly one wins (%s)',
    async (_n, make) => {
      const { h, id, dana, mine, danas } = await setup(await make())
      const res = await Promise.all([acquire(h, id, h.member, mine), acquire(h, id, dana, danas)])
      expect(res.map((r) => r.status).sort()).toEqual([200, 409])
    },
    60_000,
  )

  it('is Creator+ on a video the caller can read, for their own draft', async () => {
    const { h, id, mine } = await setup()
    const reviewer = await person(h, 'u_rev', 'reviewer')
    expect((await h.call('GET', lock(h, id), { as: reviewer })).status).toBe(403)
    expect((await acquire(h, id, reviewer, mine)).status).toBe(403)
    expect((await h.call('GET', lock(h, 'vid_nothere'), { as: h.member })).status).toBe(404)
    // Someone else's draft reads as missing.
    const cora = await person(h, 'u_cora', 'creator')
    expect((await acquire(h, id, cora, mine)).status).toBe(404)
    expect(
      (await h.call('POST', `${lock(h, id)}/take-over`, { as: cora, body: { draftId: mine } })).status,
    ).toBe(404)
  }, 60_000)
})
