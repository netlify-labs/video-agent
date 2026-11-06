// Upload sessions for screen recordings (screen-recording plan §4.2; va-rsk5.2.3): the role needs no video
// (scopeJobId refused), its cap is 150 MB (a clip's stays 100 MB), completion makes a ready item with the role and
// the MP4 facts in meta.json, at most 10 recording sessions an hour, and a full in-flight reservation names the open
// sessions. On the memory store and PGlite; one JSON line per case.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readMediaMeta } from '../src/domain/media.js'
import { NO_PROVENANCE, type MediaRow } from '../src/domain/types.js'
import { createMemoryStore } from '../src/store/memory.js'
import type { Store } from '../src/store/types.js'
import { harness, pgStore, PROMPT, raw, type Harness } from './helpers.js'

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const log = (fields: Record<string, unknown>) => console.log(JSON.stringify(fields))
const MiB = 1024 * 1024
const recording = () => new Uint8Array(readFileSync(new URL('./fixtures/mp4/gop30.mp4', import.meta.url)))

const create = (h: Harness, body: Record<string, unknown>) =>
  h.call('POST', '/api/v1/media/uploads', {
    as: h.member,
    body: { filename: 'take.mp4', sha256: 'b'.repeat(64), ...body },
  })

const stores: [string, () => Promise<Store>][] = [
  ['memory', async () => createMemoryStore()],
  ['postgres', pgStore],
]

describe.each(stores)('screen recording upload sessions (%s)', (store, make) => {
  it('needs no video: scopeJobId is refused', async () => {
    const h = harness({}, { store: await make() })
    const ok = await create(h, { size: 10 * MiB, role: 'screen-recording' })
    log({ store, case: 'no scope', status: ok.status })
    expect(ok.status).toBe(201)
    const video = await h.json<{ id: string }>(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
    )
    const scoped = await create(h, { size: 10 * MiB, role: 'screen-recording', scopeJobId: video.id })
    log({ store, case: 'scoped', status: scoped.status })
    expect(scoped.status).toBe(400)
    expect((await h.json(scoped)).error.message).toBe(
      "A screen recording doesn't take scopeJobId: it belongs to no video yet.",
    )
  })

  it('caps recordings at 150 MB and clips at 100 MB', async () => {
    const h = harness({}, { store: await make() })
    const over = await create(h, { size: 150 * MiB + 1, role: 'screen-recording' })
    expect(over.status).toBe(400)
    expect((await h.json(over)).error.message).toBe('Screen recordings must be 150 MB or smaller.')
    expect((await create(h, { size: 101 * MiB, role: 'screen-recording' })).status).toBe(201)
    const clip = await create(h, { size: 101 * MiB })
    expect(clip.status).toBe(400)
    expect((await h.json(clip)).error.message).toBe('Files must be 100 MB or smaller.')
    log({ store, case: 'caps', status: 'ok' })
  })

  it('completes to a ready item with the role and the MP4 facts in meta.json', async () => {
    const h = harness({}, { store: await make() })
    const file = recording()
    const s = await h.json<{ id: string }>(
      await create(h, { size: file.byteLength, sha256: sha(file), role: 'screen-recording' }),
    )
    await raw(h, h.member, 'PUT', `/api/v1/media/uploads/${s.id}/parts/0`, file, {
      'x-part-sha256': sha(file),
    })
    const done = await h.json<{ status: string; mediaId: string; error: string | null }>(
      await h.call('POST', `/api/v1/media/uploads/${s.id}/complete`, { as: h.member, body: {} }),
    )
    log({ store, case: 'complete', status: done.status, error: done.error })
    expect(done.status).toBe('done')
    expect(await h.deps.store.getMedia(done.mediaId)).toMatchObject({
      role: 'screen-recording',
      kind: 'video',
      status: 'ready',
      scopeJobId: null,
    })
    expect((await readMediaMeta(h.deps, done.mediaId))?.mp4).toMatchObject({
      fps: 30,
      cfr: true,
      maxKeyframeGapSec: 1,
      sizeChanges: false,
      fastStart: true,
    })
  })

  it('rejects at assembly a recording that breaks a rule, with its message', async () => {
    const h = harness({}, { store: await make() })
    const file = new Uint8Array(readFileSync(new URL('./fixtures/mp4/gop300.mp4', import.meta.url)))
    const s = await h.json<{ id: string }>(
      await create(h, { size: file.byteLength, sha256: sha(file), role: 'screen-recording' }),
    )
    await raw(h, h.member, 'PUT', `/api/v1/media/uploads/${s.id}/parts/0`, file, {
      'x-part-sha256': sha(file),
    })
    const done = await h.json<{ status: string; error: string | null }>(
      await h.call('POST', `/api/v1/media/uploads/${s.id}/complete`, { as: h.member, body: {} }),
    )
    log({ store, case: 'bad recording', status: done.status, error: done.error })
    expect(done.status).toBe('failed')
    expect(done.error).toMatch(/keyframe every second/)
  })

  it('allows 10 recording sessions an hour, counted apart from takes', async () => {
    const h = harness({}, { store: await make() })
    const now = h.deps.clock.now().toISOString()
    for (let i = 0; i < 10; i++)
      await h.deps.store.insertMedia(
        recordingRow(`med_rec${i}`, now, i === 0 ? 'narration-take' : 'screen-recording'),
      )
    // Nine recordings (and one take, which doesn't count) in the hour: one more is allowed, then none.
    expect((await create(h, { size: MiB, role: 'screen-recording' })).status).toBe(201)
    const res = await create(h, { size: MiB, role: 'screen-recording' })
    log({ store, case: 'rate', status: res.status })
    expect(res.status).toBe(429)
  })

  it('names the open sessions when the in-flight reservation is full', async () => {
    const h = harness({}, { store: await make() })
    for (let i = 0; i < 6; i++)
      expect((await create(h, { size: 150 * MiB, role: 'screen-recording' })).status).toBe(201)
    const res = await create(h, { size: 150 * MiB, role: 'screen-recording' })
    const body = await h.json<{ error: { code: string; message: string } }>(res)
    log({ store, case: 'in flight', status: res.status, message: body.error.message })
    expect(res.status).toBe(429)
    expect(body.error).toMatchObject({
      code: 'rate_limited',
      message: 'You have 6 uploads in progress. Finish or cancel one to start another.',
    })
  })
})

function recordingRow(id: string, at: string, role: MediaRow['role']): MediaRow {
  return {
    id,
    uploaderId: 'u_member',
    kind: 'video',
    status: 'ready',
    rejectReason: null,
    filename: `${id}.mp4`,
    title: null,
    caption: null,
    mime: 'video/mp4',
    ext: 'mp4',
    bytes: MiB,
    originalKey: `${id}/original.mp4`,
    originalSha256: 'a'.repeat(64),
    cleanKey: `${id}/original.mp4`,
    cleanSha256: 'a'.repeat(64),
    width: 320,
    height: 180,
    durationSec: 3,
    posterKey: null,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    role,
    scopeJobId: null,
    retainUntil: null,
    deletingAt: null,
    ...NO_PROVENANCE,
  }
}
