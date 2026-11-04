// Remix a video (docs/plans/2026-11-03-remix.md; beads va-p62w.2.x and the phase 2/3 gates): a NEW video that starts
// from another video's finished composition plus a change request. The source's archive is copied (and cleaned of
// recorded narration) under the remix's own prefix behind a reservation the creating transaction adopts, so the
// remix survives its source and a failed creation leaves nothing behind once the sweep runs.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runCleanup } from '../src/domain/cleanup.js'
import { remixReservationId, remixSourceKey } from '../src/domain/remix.js'
import { applyEdits, applyNarration, type Summary } from '../src/lib/contract.js'
import { readTarGz, writeTarGz } from '../src/lib/tar.js'
import { IDENTITY_FIT, SAMPLE_RATE as S, type NarrationOp } from '../src/lib/timeline.js'
import {
  apiKey,
  harness,
  mcpCall,
  person,
  pgStore,
  png,
  readyVideo,
  upload,
  type Harness,
} from './helpers.js'

const log = (event: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ test: 'remix', event, ...data }))

const remix = (h: Harness, as: string, id: string, body: Record<string, unknown>, key?: string) =>
  h.call('POST', `/api/v1/videos/${id}/remix`, {
    as,
    body,
    ...(key ? { headers: { 'idempotency-key': key } } : {}),
  })
const get = async (h: Harness, as: string, id: string) =>
  h.json(await h.call('GET', `/api/v1/videos/${id}`, { as }))
const sweep = (h: Harness) => runCleanup(h.deps, { deadline: Date.now() + 10_000, maxItems: 100 })
const openReservations = async (h: Harness) =>
  (await h.deps.store.listDueCleanup('9999-12-31T00:00:00.000Z', 1000)).filter((c) =>
    c.id.startsWith('remix-source-'),
  )
/** The prompt the fake runner got for a video's latest attempt. */
const promptOf = async (h: Harness, id: string) => {
  const a = (await h.attempts(id)).at(-1)
  return [...h.deps.runner.runs.values()].find((r) => r.req.requestId === a?.id)?.req.prompt ?? ''
}

/** A narrated composition archive: the contract voice fixture with a recorded-narration layer and its cues. */
function narratedArchive(): Uint8Array {
  const fx = (f: string) => readFileSync(new URL(`./fixtures/contract1-voice/${f}`, import.meta.url), 'utf8')
  const base = applyEdits(fx('index.html'), JSON.parse(fx('summary.json')) as Summary, [])
  const op: NarrationOp = {
    op: 'narration',
    schema: 1,
    sampleRate: S,
    clips: [
      {
        id: 'a',
        mediaId: 'take1',
        srcStart: 0,
        srcEnd: 2 * S,
        fit: IDENTITY_FIT,
        offsetSamples: 0,
        start: 4 * S,
        gainDb: 0,
        fadeInSamples: 0,
        fadeOutSamples: 0,
      },
    ],
    tracks: {
      narration: { volumeDb: 0, muted: false, solo: false },
      aiVoice: { mode: 'under', volumeDb: -6 },
      music: { duck: true, duckDb: -12 },
      original: { muteAll: false },
    },
    cleanup: 'light',
  }
  const narrated = applyNarration(base.html, base.summary, op, new Map([['take1', [[0, 2 * S]]]]))
  const summary: Summary = {
    ...base.summary,
    captions: [
      ...(base.summary.captions ?? []),
      { start: 4, end: 5.5, text: 'In my own words.', narration: true, id: 'n1' },
    ],
  }
  return writeTarGz(
    new Map([
      ['index.html', new TextEncoder().encode(narrated.html)],
      ['summary.json', new TextEncoder().encode(JSON.stringify(summary))],
    ]),
  )
}

async function basics(h: Harness) {
  const rae = await person(h, 'u_rae', 'creator')
  const source = await readyVideo(h, h.member)
  await h.deps.store.updateVersion(source, 1, { targetDurationSec: 20, sound: 'music' })
  const res = await remix(h, rae, source, { prompt: 'Same video, but for the payments API.' })
  expect(res.status).toBe(202)
  const v = await h.json(res)
  expect(res.headers.get('location')).toBe(v.links.self)
  expect(v.id).not.toBe(source)
  expect(v.owner.id).toBe('u_rae')
  expect(v.isRemix).toBe(true)
  expect(v.remixOf).toEqual({ id: source, n: 1, title: expect.any(String) })
  expect(v.title).toBe('Same video, but for the payments API.')
  log('remix.created', { source, remix: v.id })

  const row = await h.deps.store.getVersion(v.id, 1)
  expect(row).toMatchObject({
    parentN: null,
    mode: 'author',
    targetDurationSec: 20,
    sound: 'music',
    authorId: 'u_rae',
  })
  expect(row?.remix).toMatchObject({
    sourceKey: remixSourceKey(v.id),
    fromJobId: source,
    fromN: 1,
    fromOwnerName: 'Mia Member',
    narrationDropped: false,
    sourceSound: 'music',
  })
  expect(row?.remix?.history).toHaveLength(1)
  // The copy is adopted: no open reservation, and it's byte-identical to the (non-narrated) source.
  expect(await openReservations(h)).toEqual([])
  const out = await h.deps.store.getOutput(source, 1)
  expect(row?.remix?.sourceSha256).toBe(out?.sha256['source.tar.gz'])
  expect(await h.deps.blobs.list('sources', remixSourceKey(v.id))).toEqual([remixSourceKey(v.id)])

  await h.drive(6)
  expect((await get(h, rae, v.id)).status).toBe('ready')
  const prompt = await promptOf(h, v.id)
  expect(prompt).toContain('This is a remix')
  expect(prompt).toContain('Same video, but for the payments API.')
  log('remix.ready', { remix: v.id })
  return { rae, source, remix: v.id }
}

describe('remix', () => {
  it('makes a new video from a source, owned by the remixer, that runs to ready (memory)', async () => {
    await basics(harness())
  })

  it('makes a new video from a source, owned by the remixer, that runs to ready (Postgres)', async () => {
    await basics(harness({}, { store: await pgStore() }))
  })

  it('roles: creators and admins remix; reviewers and viewers cannot; private sources stay private', async () => {
    const h = harness()
    const rita = await person(h, 'u_rita', 'reviewer')
    const vic = await person(h, 'u_vic', 'viewer')
    const rae = await person(h, 'u_rae', 'creator')
    const source = await readyVideo(h, h.member)
    expect((await remix(h, rita, source, { prompt: 'Change it' })).status).toBe(403)
    expect((await remix(h, vic, source, { prompt: 'Change it' })).status).toBe(403)
    await h.call('PATCH', `/api/v1/videos/${source}`, { as: h.member, body: { private: true } })
    expect((await remix(h, rae, source, { prompt: 'Change it' })).status).toBe(404)
    const byAdmin = await remix(h, h.admin, source, { prompt: 'An admin remix' })
    expect(byAdmin.status).toBe(202)
    const v = await h.json(byAdmin)
    expect(v.private).toBe(true)
    const mirror = await h.deps.blobs.get('internal', `access/${v.id}.json`)
    expect(JSON.parse(new TextDecoder().decode(mirror))).toMatchObject({ private: true })
    // Nobody but the remix's owner (the admin) and other admins sees it; the source owner can't see the remix.
    expect((await h.call('GET', `/api/v1/videos/${v.id}`, { as: h.member })).status).toBe(404)
    // The source owner sees provenance on nothing; rae sees isRemix-free lists of her own.
  })

  it('needs a ready version: a running latest falls back to the last ready one; an unready one is refused', async () => {
    const h = harness()
    const rae = await person(h, 'u_rae', 'creator')
    const source = await readyVideo(h, h.member)
    await h.call('POST', `/api/v1/videos/${source}/versions`, {
      as: h.member,
      body: { prompt: 'Warmer colours.' },
    })
    const fallback = await h.json(await remix(h, rae, source, { prompt: 'Remix it' }))
    expect(fallback.remixOf.n).toBe(1)
    const unready = await remix(h, rae, source, { prompt: 'Remix v2', fromVersion: 2 })
    expect(unready.status).toBe(409)
    expect((await h.json(unready)).error.code).toBe('not_ready')
    expect((await remix(h, rae, source, { prompt: 'Remix v9', fromVersion: 9 })).status).toBe(404)
    const empty = await h.json(
      await h.call('POST', '/api/v1/videos', {
        as: h.member,
        body: { prompt: 'A brand new video about webhooks.' },
      }),
    )
    expect((await remix(h, rae, empty.id, { prompt: 'Too early' })).status).toBe(409)
  })

  it('overrides replace the source settings; mediaIds is the final list', async () => {
    const h = harness()
    const rae = await person(h, 'u_rae', 'creator')
    const m1 = (await h.json(await upload(h, h.member, png(), 'filename=one.png'))).id as string
    const m2 = (await h.json(await upload(h, h.member, png(), 'filename=two.png'))).id as string
    const created = await h.json(
      await h.call('POST', '/api/v1/videos', {
        as: h.member,
        body: { prompt: 'A short launch video for org webhooks.', mediaIds: [m1, m2] },
      }),
    )
    await h.drive(4)
    // m1 is deleted from the library afterwards: kept as an inherited snapshot, refused as a new pick.
    expect((await h.call('DELETE', `/api/v1/media/${m1}`, { as: h.member })).status).toBeLessThan(300)
    const v = await h.json(
      await remix(h, rae, created.id, {
        prompt: 'Vertical, longer, in German.',
        aspect: '9:16',
        durationSec: 45,
        language: 'de',
        sound: 'music',
        mediaIds: [m1],
      }),
    )
    expect(v).toMatchObject({ aspect: '9:16', language: 'de' })
    expect(await h.deps.store.getVersion(v.id, 1)).toMatchObject({ targetDurationSec: 45, sound: 'music' })
    expect((await h.deps.store.listVersionMedia(v.id, 1)).map((m) => m.mediaId)).toEqual([m1])
    const kept = await h.json(await remix(h, rae, created.id, { prompt: 'Keep the media.' }))
    expect((await h.deps.store.listVersionMedia(kept.id, 1)).map((m) => m.mediaId)).toEqual([m1, m2])
    const m3 = (await h.json(await upload(h, h.member, png(), 'filename=three.png'))).id as string
    await h.call('DELETE', `/api/v1/media/${m3}`, { as: h.member })
    expect((await remix(h, rae, created.id, { prompt: 'A deleted pick', mediaIds: [m3] })).status).toBe(400)
  })

  it('the admin switch refuses remixes before anything is copied', async () => {
    const h = harness()
    const rae = await person(h, 'u_rae', 'creator')
    const source = await readyVideo(h, h.member)
    expect((await h.json(await h.call('GET', '/api/v1/config'))).remixEnabled).toBe(true)
    const off = await h.call('PATCH', '/api/v1/admin/settings', {
      as: h.admin,
      body: { remixEnabled: false },
    })
    expect(off.status).toBe(200)
    expect((await h.json(off)).remixEnabled).toBe(false)
    expect(
      (await h.call('PATCH', '/api/v1/admin/settings', { as: rae, body: { remixEnabled: true } })).status,
    ).toBe(403)
    expect((await h.json(await h.call('GET', '/api/v1/config'))).remixEnabled).toBe(false)
    const res = await remix(h, rae, source, { prompt: 'Remix it' })
    expect(res.status).toBe(409)
    expect((await h.json(res)).error.code).toBe('remix_disabled')
    expect(await openReservations(h)).toEqual([])
    const plan = await h.call('POST', '/api/v1/plans', {
      as: rae,
      body: { prompt: 'Remix it', remixOf: { videoId: source } },
    })
    expect(plan.status).toBe(409)
    await h.call('PATCH', '/api/v1/admin/settings', { as: h.admin, body: { remixEnabled: true } })
    expect((await remix(h, rae, source, { prompt: 'Remix it' })).status).toBe(202)
  })

  it('idempotency: a key replays its remix; another body conflicts; keys are scoped to the source', async () => {
    const h = harness()
    const rae = await person(h, 'u_rae', 'creator')
    const a = await readyVideo(h, h.member)
    const b = await readyVideo(h, h.member)
    const first = await remix(h, rae, a, { prompt: 'Remix it' }, 'k1')
    const again = await remix(h, rae, a, { prompt: 'Remix it' }, 'k1')
    expect((await h.json(again)).id).toBe((await h.json(first)).id)
    expect((await remix(h, rae, a, { prompt: 'Something else' }, 'k1')).status).toBe(409)
    const other = await remix(h, rae, b, { prompt: 'Remix it' }, 'k1')
    expect(other.status).toBe(202)
    expect((await h.json(other)).remixOf.id).toBe(b)
    // The replay made no copy, so nothing is left to sweep.
    expect(await openReservations(h)).toEqual([])
  })

  it('a narrated source is remixed without its recorded narration', async () => {
    const h = harness()
    const rae = await person(h, 'u_rae', 'creator')
    h.deps.nextSource = narratedArchive()
    const source = await readyVideo(h, h.member)
    await h.deps.store.updateVersion(source, 1, {
      narration: {
        op: {},
        recipe: { pipeline: 1, ffmpegVersion: 'x', settings: {} },
        bus: { key: 'k', sha256: 's', samples: 1 },
      },
    })
    const v = await h.json(await remix(h, rae, source, { prompt: 'Same, for the payments API.' }))
    const row = await h.deps.store.getVersion(v.id, 1)
    expect(row?.remix?.narrationDropped).toBe(true)
    expect(row?.narration ?? null).toBeNull()
    const copy = readTarGz((await h.deps.blobs.get('sources', remixSourceKey(v.id)))!)
    const html = new TextDecoder().decode(copy.get('index.html'))
    expect(html).not.toContain('va-narration')
    expect(new TextDecoder().decode(copy.get('summary.json'))).not.toContain('"narration":true')
    await h.drive(6)
    expect(await promptOf(h, v.id)).toContain("recorded voice-over, which isn't carried over")
  })

  it('an edited source, a remix of a remix, and a remix whose source is deleted all run', async () => {
    const h = harness()
    const rae = await person(h, 'u_rae', 'creator')
    const source = await readyVideo(h, h.member)
    await h.deps.store.updateVersion(source, 1, { mode: 'render_unchanged', editedFromN: 1 })
    const first = await h.json(await remix(h, rae, source, { prompt: 'First remix of it.' }))
    const firstRow = await h.deps.store.getVersion(first.id, 1)
    expect(firstRow?.mode).toBe('author')
    expect(firstRow?.editedFromN ?? null).toBeNull()
    expect(firstRow?.frozen ?? null).toBeNull()
    await h.drive(6)
    const second = await h.json(await remix(h, h.member, first.id, { prompt: 'A remix of the remix.' }))
    expect(second.remixOf).toMatchObject({ id: first.id, n: 1 })
    const hist = (await h.deps.store.getVersion(second.id, 1))?.remix?.history
    expect(hist?.at(-1)).toBe('First remix of it.')
    expect(hist?.length).toBe(2)
    // Delete the remix's source and sweep it away: the second remix still runs from its own copy.
    await h.call('DELETE', `/api/v1/videos/${first.id}`, { as: rae })
    await sweep(h)
    expect(await h.deps.blobs.list('sources', `${first.id}/`)).toEqual([])
    await h.drive(6)
    const after = await get(h, h.member, second.id)
    expect(after.status).toBe('ready')
    expect(after.isRemix).toBe(true)
    expect(after.remixOf).toBeNull()
  })

  it('a failed creation leaves its copy under an open reservation that the sweep removes; deletes clean up', async () => {
    const h = harness()
    const rae = await person(h, 'u_rae', 'creator')
    const source = await readyVideo(h, h.member)
    // An unknown plan fails inside the creating transaction, after the copy.
    const res = await remix(h, rae, source, { prompt: 'Remix it', planId: 'plan_missing' })
    expect(res.status).toBe(404)
    const [open] = await openReservations(h)
    expect(open?.prefix).toMatch(/^vid_\w+\/remix-source$/)
    const orphan = `${open!.prefix}.tar.gz`
    expect(await h.deps.blobs.list('sources', orphan)).toEqual([orphan])
    await sweep(h) // not due yet
    expect(await h.deps.blobs.list('sources', orphan)).toEqual([orphan])
    h.deps.clock.advance(61 * 60_000)
    await sweep(h)
    expect(await h.deps.blobs.list('sources', orphan)).toEqual([])
    log('orphan.swept', { key: orphan })
    // An adopted copy is never swept, and deleting the remix removes it (no clash with the reservation row).
    const v = await h.json(await remix(h, rae, source, { prompt: 'Remix it' }))
    h.deps.clock.advance(2 * 3600_000)
    await sweep(h)
    expect(await h.deps.blobs.list('sources', remixSourceKey(v.id))).toEqual([remixSourceKey(v.id)])
    expect(
      (await h.deps.store.listDueCleanup('9999-12-31T00:00:00.000Z', 1000)).some(
        (c) => c.id === remixReservationId(v.id),
      ),
    ).toBe(false)
    await h.call('DELETE', `/api/v1/videos/${v.id}`, { as: rae })
    await sweep(h)
    expect(await h.deps.blobs.list('sources', `${v.id}/`)).toEqual([])
  })

  it('two concurrent remixes with one key make one video; the loser copy is swept (Postgres)', async () => {
    const h = harness({}, { store: await pgStore() })
    const rae = await person(h, 'u_rae', 'creator')
    const source = await readyVideo(h, h.member)
    const [r1, r2] = await Promise.all([
      remix(h, rae, source, { prompt: 'Remix it' }, 'same'),
      remix(h, rae, source, { prompt: 'Remix it' }, 'same'),
    ])
    log('race', { statuses: [r1.status, r2.status] })
    const ok = [r1, r2].filter((r) => r.status === 202)
    expect(ok.length).toBeGreaterThanOrEqual(1)
    const ids = new Set(await Promise.all(ok.map(async (r) => (await h.json(r)).id as string)))
    expect(ids.size).toBe(1)
    const remixes = (await h.deps.store.listJobs({ limit: 50 })).filter((j) => j.remixOfJobId === source)
    expect(remixes).toHaveLength(1)
    h.deps.clock.advance(61 * 60_000)
    await sweep(h)
    const left = (await h.deps.blobs.list('sources', '')).filter((k) => k.endsWith('/remix-source.tar.gz'))
    expect(left).toEqual([remixSourceKey(remixes[0]!.id)])
  })

  it('provenance: remixOf only when the viewer can see the source; the ETag follows it', async () => {
    const h = harness()
    const rae = await person(h, 'u_rae', 'creator')
    const source = await readyVideo(h, h.member)
    const v = await h.json(await remix(h, rae, source, { prompt: 'Remix it' }))
    const first = await h.call('GET', `/api/v1/videos/${v.id}`, { as: rae })
    const etag = first.headers.get('etag') ?? ''
    await h.call('PATCH', `/api/v1/videos/${source}`, { as: h.member, body: { title: 'Renamed source' } })
    const renamed = await h.call('GET', `/api/v1/videos/${v.id}`, {
      as: rae,
      headers: { 'if-none-match': etag },
    })
    expect(renamed.status).toBe(200)
    expect((await h.json(renamed)).remixOf.title).toBe('Renamed source')
    await h.call('PATCH', `/api/v1/videos/${source}`, { as: h.member, body: { private: true } })
    const hidden = await get(h, rae, v.id)
    expect(hidden).toMatchObject({ isRemix: true, remixOf: null })
    const listed = (await h.json(await h.call('GET', '/api/v1/videos?owner=me', { as: rae }))).items
    expect(listed[0]).toMatchObject({ id: v.id, isRemix: true, remixOf: null })
    expect((await get(h, h.admin, v.id)).remixOf).toMatchObject({ id: source })
  })
})

describe('remix plans', () => {
  const BRIEF = {
    title: 'Payments API in 30 seconds',
    goal: 'Announce',
    audience: 'Developers',
    keyMessage: 'Same format',
    beats: [{ text: 'Hook', seconds: 10 }],
    tone: 'Confident',
    callToAction: 'Docs',
    mustInclude: [],
    avoid: [],
  }

  it('plans a remix with the source as data, makes it, and keeps plans to their own kind', async () => {
    const h = harness()
    const rae = await person(h, 'u_rae', 'creator')
    const source = await readyVideo(h, h.member)
    const plan = await h.json(
      await h.call('POST', '/api/v1/plans', {
        as: rae,
        body: { prompt: 'Same, for payments', remixOf: { videoId: source } },
      }),
    )
    expect(plan.remixOf).toEqual({ videoId: source, version: 1 })
    expect(plan.revisionOf).toBeNull()
    expect(h.deps.gateway.calls.find((c) => c.kind === 'route')?.user).toContain('Remix of an existing video')
    h.deps.gateway.replies.push(JSON.stringify({ questions: [] }), JSON.stringify(BRIEF))
    await h.call('POST', `/api/v1/plans/${plan.id}/questions`, { as: rae })
    const briefed = await h.json(
      await h.call('POST', `/api/v1/plans/${plan.id}/brief`, { as: rae, body: { answers: [] } }),
    )
    expect(briefed.brief.title).toBe(BRIEF.title)
    const briefCall = h.deps.gateway.calls.filter((c) => c.kind === 'messages').at(-1)
    expect(briefCall?.user).toContain('<data name="source_video">')
    expect(briefCall?.system).toContain('This is a remix')
    // Not usable to create or revise.
    expect(
      (
        await h.call('POST', '/api/v1/videos', {
          as: rae,
          body: { prompt: 'A brand new one about webhooks', planId: plan.id },
        })
      ).status,
    ).toBe(409)
    const other = await readyVideo(h, h.member)
    expect((await remix(h, rae, other, { prompt: 'Wrong source', planId: plan.id })).status).toBe(409)
    const made = await h.json(await remix(h, rae, source, { prompt: 'Same, for payments', planId: plan.id }))
    expect(made.title).toBe(BRIEF.title)
    expect((await h.deps.store.getVersion(made.id, 1))?.plan?.planId).toBe(plan.id)
    const both = await h.call('POST', '/api/v1/plans', {
      as: rae,
      body: { prompt: 'Both', remixOf: { videoId: source }, revisionOf: { videoId: source } },
    })
    expect(both.status).toBe(400)
  })
})

describe('remix over MCP', () => {
  it('remix_video is listed for creators only, makes a remix, and shows provenance in get_video', async () => {
    const h = harness()
    const rae = await person(h, 'u_rae', 'creator')
    const rita = await person(h, 'u_rita', 'reviewer')
    const source = await readyVideo(h, h.member)
    const key = await apiKey(h, rae)
    const reviewerKey = await apiKey(h, rita)
    const names = async (k: string) =>
      ((await mcpCall(h, k, 'tools/list', {})).tools as { name: string }[]).map((t) => t.name)
    expect(await names(key)).toContain('remix_video')
    expect(await names(reviewerKey)).not.toContain('remix_video')
    const made = await mcpCall(h, key, 'tools/call', {
      name: 'remix_video',
      arguments: { video_id: source, change: 'Same format, about the payments API.', aspect: '9:16' },
    })
    expect(made.isError ?? false).toBe(false)
    const id = made.structuredContent.video_id as string
    expect(made.structuredContent).toMatchObject({
      is_remix: true,
      remix_of: { video_id: source, version: 1 },
      aspect: '9:16',
    })
    const listed = await mcpCall(h, key, 'tools/call', { name: 'list_videos', arguments: { mine: true } })
    expect(listed.structuredContent.videos[0]).toMatchObject({ video_id: id, is_remix: true })
    await h.call('PATCH', '/api/v1/admin/settings', { as: h.admin, body: { remixEnabled: false } })
    const off = await mcpCall(h, key, 'tools/call', {
      name: 'remix_video',
      arguments: { video_id: source, change: 'Another one' },
    })
    expect(off.isError).toBe(true)
    expect(JSON.stringify(off)).toContain('Remixing is turned off')
  })
})
