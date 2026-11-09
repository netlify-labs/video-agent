// A screen recording's pointer trace routes (screen-recording plan §4.7; va-rsk5.2.8): PUT stores it normalized for
// the uploader (or an admin), replaces it until a version uses the recording and then answers 409 trace_frozen;
// refuses an oversize body on its declared length before reading it, a malformed trace with the field path, a trace
// for another file, and items that aren't recordings; shares the hourly budget with recording uploads; GET is for
// the uploader and admins only. On the memory store and PGlite; one JSON line per request.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { NO_PROVENANCE, type MediaRow, type VersionMediaRow } from '../server/domain/types.js'
import { TRACE_MAX_BYTES } from '../server/lib/recording-trace.js'
import { createMemoryStore } from '../server/store/memory.js'
import type { Store } from '../server/store/types.js'
import { harness, person, pgStore, readyVideo, type Harness } from './helpers.js'

const stores: [string, () => Promise<Store>][] = [
  ['memory', async () => createMemoryStore()],
  ['postgres', pgStore],
]

const log = (fields: Record<string, unknown>) => console.log(JSON.stringify(fields))
const good = () =>
  JSON.parse(
    readFileSync(new URL('./fixtures/recording/trace-good.json', import.meta.url), 'utf8'),
  ) as Record<string, any>

/** A ready screen recording matching trace-good.json's frame (2560x1600, 12.5 s). */
async function recording(h: Harness, id = 'med_screen', over: Partial<MediaRow> = {}) {
  const at = h.deps.clock.now().toISOString()
  await h.deps.store.insertMedia({
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
    bytes: 1000,
    originalKey: `${id}/original.mp4`,
    originalSha256: 'a'.repeat(64),
    cleanKey: `${id}/original.mp4`,
    cleanSha256: 'a'.repeat(64),
    width: 2560,
    height: 1600,
    durationSec: 12.5,
    posterKey: null,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    role: 'screen-recording',
    scopeJobId: null,
    retainUntil: null,
    deletingAt: null,
    ...NO_PROVENANCE,
    ...over,
  })
  return id
}

async function put(h: Harness, as: string, id: string, body: unknown) {
  const res = await h.call('PUT', `/api/v1/media/${id}/trace`, { as, body })
  log({ route: 'PUT /media/:id/trace', mediaId: id, status: res.status })
  return res
}
async function get(h: Harness, as: string, id: string) {
  const res = await h.call('GET', `/api/v1/media/${id}/trace`, { as })
  log({ route: 'GET /media/:id/trace', mediaId: id, status: res.status })
  return res
}

describe.each(stores)('pointer trace routes (%s)', (store, make) => {
  it('stores the trace normalized and returns it to the uploader', async () => {
    const h = harness({}, { store: await make() })
    const id = await recording(h)
    const t = good()
    t.events[0].target.name = 'Delete jane@acme.com'
    expect((await put(h, h.member, id, t)).status).toBe(200)
    const back = await h.json<Record<string, any>>(await get(h, h.member, id))
    expect(back.events[0].target.name).toBe('Delete …')
    const row = await h.deps.store.getMedia(id)
    expect(row).toMatchObject({ traceKey: `${id}/trace.json` })
    expect(row?.traceSha256).toMatch(/^[0-9a-f]{64}$/)
    log({ store, case: 'set', ok: true })
  })

  it('refuses an oversize body on its declared length, before reading it', async () => {
    const h = harness({}, { store: await make() })
    const id = await recording(h)
    let pulled = false
    // highWaterMark 0: the stream pulls only when someone reads it (the default 1 pulls at once to fill its queue).
    const body = new ReadableStream(
      {
        pull(ctl) {
          pulled = true
          ctl.close()
        },
      },
      { highWaterMark: 0 },
    )
    const res = await h.app.fetch(
      new Request(`https://video.example.com/api/v1/media/${id}/trace`, {
        method: 'PUT',
        headers: {
          cookie: h.member,
          origin: 'https://video.example.com',
          'content-type': 'application/json',
          'content-length': String(TRACE_MAX_BYTES + 1),
        },
        body,
        duplex: 'half',
      }),
      { context: { deploy: { published: true }, waitUntil: () => undefined } },
    )
    log({ store, case: 'oversize', status: res.status, pulled })
    expect(res.status).toBe(413)
    expect(pulled).toBe(false)
  })

  it('refuses a malformed trace with the field path, a trace for another file, and a non-recording', async () => {
    const h = harness({}, { store: await make() })
    const id = await recording(h)
    const bad = good()
    bad.moves[1][1] = 7
    const r1 = await put(h, h.member, id, bad)
    expect(r1.status).toBe(400)
    expect((await h.json(r1)).error.message).toContain('moves.1.1:')
    const other = good()
    other.frame.width = 1920
    const r2 = await put(h, h.member, id, other)
    expect(r2.status).toBe(400)
    expect((await h.json(r2)).error.message).toBe(
      'This pointer trace is for a different recording (1920x1600, 12.5 s; this one is 2560x1600, 12.5 s).',
    )
    const clip = await recording(h, 'med_clip', { role: null })
    const r3 = await put(h, h.member, clip, good())
    expect(r3.status).toBe(400)
    expect((await h.json(r3)).error.message).toBe('Only screen recordings have a pointer trace.')
  })

  it('is the uploader and admins only: another Creator gets 404 for PUT and GET', async () => {
    const h = harness({}, { store: await make() })
    const id = await recording(h)
    const cora = await person(h, 'u_cora', 'creator')
    expect((await put(h, cora, id, good())).status).toBe(404)
    expect((await put(h, h.member, id, good())).status).toBe(200)
    expect((await get(h, cora, id)).status).toBe(404)
    expect((await get(h, h.admin, id)).status).toBe(200)
  })

  it('shares the hourly budget with recording uploads, with retryAfterSec', async () => {
    const h = harness({}, { store: await make() })
    const id = await recording(h)
    // The recording itself counts as this hour's upload: nine trace writes fit, the tenth doesn't.
    for (let i = 0; i < 9; i++)
      expect((await put(h, h.member, id, good())).status, `write ${i + 1}`).toBe(200)
    const res = await put(h, h.member, id, good())
    const body = await h.json<{ error: { code: string; details?: { retryAfterSec?: number } } }>(res)
    log({ store, case: 'rate', status: res.status, retryAfterSec: body.error.details?.retryAfterSec })
    expect(res.status).toBe(429)
    expect(body.error.details?.retryAfterSec).toBeGreaterThan(0)
  })

  it('is frozen once a version uses the recording (409 trace_frozen)', async () => {
    const h = harness({}, { store: await make() })
    const id = await recording(h)
    expect((await put(h, h.member, id, good())).status).toBe(200)
    const job = await readyVideo(h)
    const vm: VersionMediaRow = {
      jobId: job,
      versionN: 1,
      mediaId: id,
      position: 0,
      kind: 'video',
      key: `${id}/original.mp4`,
      sha256: 'a'.repeat(64),
      filename: `${id}.mp4`,
      caption: null,
    }
    await h.deps.store.insertVersionMedia([vm])
    const res = await put(h, h.member, id, good())
    expect(res.status).toBe(409)
    expect((await h.json(res)).error.code).toBe('trace_frozen')
  })

  it('a version added while a PUT runs: exactly one of PUT-then-frozen or PUT 409', async () => {
    const h = harness({}, { store: await make() })
    const id = await recording(h)
    const job = await readyVideo(h)
    const addVersion = h.deps.store.tx(async (repo) => {
      await repo.lockMedia([id])
      await repo.insertVersionMedia([
        {
          jobId: job,
          versionN: 1,
          mediaId: id,
          position: 0,
          kind: 'video',
          key: `${id}/original.mp4`,
          sha256: 'a'.repeat(64),
          filename: `${id}.mp4`,
          caption: null,
        },
      ])
    })
    const [res] = await Promise.all([put(h, h.member, id, good()), addVersion])
    const after = await put(h, h.member, id, good())
    log({ store, case: 'race', first: res.status, after: after.status })
    expect([200, 409]).toContain(res.status)
    expect(after.status).toBe(409)
  })
})
