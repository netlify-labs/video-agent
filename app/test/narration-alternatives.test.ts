// Take alternatives (plan 2026-11-02 §9 phase 6, owner decision 7): a clip may carry its slot's other takes, each with
// its own source bounds and alignment. They are draft-only: the schema bounds them, a save checks each one like a
// clip's own take (access, source bounds, the 32-take limit), the draft's media_refs hold them (so GC and the 30-day
// release treat them as the draft's), and a render freezes only the selected take.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NarrationOpSchema } from '../server/schemas.js'
import { MAX_CLIP_ALTERNATIVES, SAMPLE_RATE } from '../server/lib/timeline.js'
import { editableVideo, harness, narrationTake as take, person, type Harness } from './helpers.js'
import { narrationTrack as narration } from './narration-render.js'

const S = SAMPLE_RATE
const FIT = { a: 0, b: 1 / S, residualMs: 0 }

/** Another take of a slot at composition 1 s: source [srcStart, srcEnd) placed there by its offset. */
const alt = (mediaId: string, srcStart = 0, srcEnd = 2 * S) => ({
  mediaId,
  srcStart,
  srcEnd,
  fit: FIT,
  offsetSamples: S - srcStart,
})
const clip = (mediaId: string, over: Record<string, unknown> = {}) => ({
  id: 'c1',
  mediaId,
  srcStart: 0,
  srcEnd: 2 * S,
  fit: FIT,
  offsetSamples: S,
  start: S,
  gainDb: 0,
  fadeInSamples: 0,
  fadeOutSamples: 0,
  ...over,
})

const openDraft = async (h: Harness, id: string, as = h.member) =>
  h.json<{ id: string; rev: number }>(await h.call('POST', `/api/v1/videos/${id}/versions/1/edits`, { as }))
async function save(h: Harness, editId: string, body: { rev: number; ops: object[] }, as = h.member) {
  const e = await h.deps.store.getEdit(editId)
  if (e) await h.call('POST', `/api/v1/videos/${e.jobId}/narration-lock`, { as, body: { draftId: editId } })
  return h.call('PUT', `/api/v1/edits/${editId}`, { as, body })
}
const draftRefs = async (h: Harness, editId: string) =>
  (await h.deps.store.listMediaRefsByOwner('draft', editId)).map((r) => r.mediaId).sort()
const error = async (res: Response) => {
  const body = (await res.json()) as { error: { code: string; message: string } }
  return { status: res.status, ...body.error }
}

describe('take alternatives in the op schema', () => {
  const parse = (c: object) => NarrationOpSchema.safeParse(narration([c])).success
  it('takes alternatives with their own bounds and alignment, and the clip take number among them', () => {
    const ok = clip('med_aaaaaaaa', { alternatives: [alt('med_bbbbbbbb'), alt('med_cccccccc')], take: 2 })
    expect(parse(ok)).toBe(true)
    expect(NarrationOpSchema.parse(narration([ok])).clips[0]).toEqual(ok)
    expect(parse(clip('med_aaaaaaaa', { alternatives: [alt('med_bbbbbbbb')] }))).toBe(true)
  })

  it('bounds them: at most MAX_CLIP_ALTERNATIVES, none empty, a take number inside the slot', () => {
    const many = Array.from({ length: MAX_CLIP_ALTERNATIVES + 1 }, () => alt('med_bbbbbbbb'))
    expect(parse(clip('med_aaaaaaaa', { alternatives: many }))).toBe(false)
    expect(parse(clip('med_aaaaaaaa', { alternatives: many.slice(1) }))).toBe(true)
    expect(parse(clip('med_aaaaaaaa', { alternatives: [] }))).toBe(false)
    expect(parse(clip('med_aaaaaaaa', { alternatives: [alt('med_bbbbbbbb', S, S)] }))).toBe(false)
    expect(parse(clip('med_aaaaaaaa', { alternatives: [alt('med_bbbbbbbb', 0.5, S)] }))).toBe(false)
    expect(parse(clip('med_aaaaaaaa', { alternatives: [alt('not-a-media-id')] }))).toBe(false)
    expect(parse(clip('med_aaaaaaaa', { alternatives: [alt('med_bbbbbbbb')], take: 3 }))).toBe(false)
    expect(parse(clip('med_aaaaaaaa', { take: 2 }))).toBe(false)
    expect(parse(clip('med_aaaaaaaa', { alternatives: [alt('med_bbbbbbbb')], take: 0 }))).toBe(false)
  })
})

describe('saving and rendering take alternatives', () => {
  beforeEach(() => vi.stubGlobal('Netlify', { env: { get: () => undefined } }))
  afterEach(() => vi.unstubAllGlobals())

  it("the draft holds its alternatives' takes; dropping one starts its 30 days", async () => {
    const h = harness()
    const id = await editableVideo(h)
    const [a, b, c] = [await take(h, id), await take(h, id), await take(h, id)]
    const e = await openDraft(h, id)
    const op = narration([clip(c, { alternatives: [alt(a), alt(b, S, 3 * S)], take: 3 })])
    const res = await save(h, e.id, { rev: 0, ops: [op] })
    expect(res.status).toBe(200)
    expect((await h.json<{ ops: object[] }>(res)).ops[0]).toEqual(op)
    expect(await draftRefs(h, e.id)).toEqual([a, b, c].sort())
    expect((await h.deps.store.getMedia(a))?.retainUntil).toBeNull()
    // A swap that leaves a out of the slot releases it; the others stay held.
    const next = narration([
      clip(b, { srcStart: S, srcEnd: 3 * S, offsetSamples: 0, alternatives: [alt(c)] }),
    ])
    expect((await save(h, e.id, { rev: 1, ops: [next] })).status).toBe(200)
    expect(await draftRefs(h, e.id)).toEqual([b, c].sort())
    expect((await h.deps.store.getMedia(a))?.retainUntil).not.toBeNull()
    expect((await h.deps.store.getMedia(c))?.retainUntil).toBeNull()
  })

  it('checks each alternative like a take: its access, its source bounds and the 32-take limit', async () => {
    const h = harness()
    const id = await editableVideo(h)
    const cora = await person(h, 'u_cora', 'creator')
    const coras = await take(h, id, cora)
    const mine = await take(h, id, h.member, 20)
    const e = await openDraft(h, id)
    const attempt = async (c: object) => error(await save(h, e.id, { rev: 0, ops: [narration([c])] }))
    // Someone else's unused take reads as unavailable, as a clip's own would.
    expect(await attempt(clip(mine, { alternatives: [alt(coras)] }))).toMatchObject({
      status: 400,
      message: expect.stringContaining(`recording ${coras} isn't available`),
    })
    expect(await attempt(clip(mine, { alternatives: [alt('med_nothere00')] }))).toMatchObject({
      status: 400,
      code: 'invalid_request',
    })
    expect(await attempt(clip(mine, { alternatives: [alt(mine, 19 * S, 20 * S + 1)] }))).toMatchObject({
      status: 400,
      message: "That edit can't be made: a take of clip c1 runs past the end of its recording.",
    })
    // 31 clip takes and two more in a slot's alternatives is 33.
    const fake = (i: number) => `med_fake${String(i).padStart(6, '0')}`
    const clips = Array.from({ length: 31 }, (_, i) => clip(fake(i), { id: `c${i}`, start: i * 3 * S }))
    clips.push(clip(mine, { id: 'cx', start: 100 * S, alternatives: [alt(fake(40)), alt(fake(41))] }))
    expect(await error(await save(h, e.id, { rev: 0, ops: [narration(clips)] }))).toMatchObject({
      status: 400,
      message: 'A narration uses at most 32 recordings.',
    })
    expect(await draftRefs(h, e.id)).toEqual([])
  })

  it('a render freezes only the selected take: no alternatives in the frozen op, the takes or the attempt', async () => {
    const h = harness({ MAX_ACTIVE_RUNS: '0' })
    const id = await editableVideo(h)
    const [a, b] = [await take(h, id), await take(h, id)]
    const e = await openDraft(h, id)
    const op = narration([clip(b, { alternatives: [alt(a)], take: 2 })])
    expect((await save(h, e.id, { rev: 0, ops: [op] })).status).toBe(200)
    const res = await h.call('POST', `/api/v1/edits/${e.id}/render`, { as: h.member })
    expect(res.status).toBe(202)
    const frozen = (await h.deps.store.getVersion(id, 2))!.frozen!.narration!
    expect(frozen.takes.map((t) => t.mediaId)).toEqual([b])
    expect(frozen.op.clips).toEqual([
      {
        id: 'c1',
        mediaId: b,
        srcStart: 0,
        srcEnd: 2 * S,
        fit: FIT,
        offsetSamples: S,
        start: S,
        gainDb: 0,
        fadeInSamples: 0,
        fadeOutSamples: 0,
      },
    ])
    const held: string[] = []
    for (const at of await h.attempts(id))
      held.push(...(await h.deps.store.listMediaRefsByOwner('frozen_attempt', at.id)).map((r) => r.mediaId))
    expect(held).toEqual([b])
  })
})
