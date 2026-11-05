// The demo API (screen-recording plan §6.1, §6.2; va-rsk5.3.16): recording on POST /videos and remix; the version's
// recording (frozen trace, setup boxes, trim) and its DTO; private when anything is hidden; the default length; the
// guards (not readable 404, being deleted 410, bad trim 400, an ordinary clip that isn't a recording 400); the trace
// frozen once used; features list screen_recording; MCP create_video takes recording_media_id.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { harness, mcpCall, apiKey, person, png, PROMPT, readyVideo, upload, type Harness } from './helpers.js'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const trace = JSON.stringify({
  v: 1,
  source: { kind: 'cli', tool: 't', startedAt: '2026-11-05T10:00:00.000Z' },
  frame: { width: 1280, height: 720, fps: 30, duration: 100 },
  viewport: { width: 1280, height: 720, dpr: 1 },
  moves: [],
  events: [],
  redact: [{ start: 0, end: 100, reason: 'password field', boxes: [[0, 0.3, 0.5, 0.4, 0.04]] }],
})

/** A ready screen recording of `seconds`, uploaded by `as`; with a stored trace when asked. */
async function recording(h: Harness, as: string, opts: { seconds?: number; trace?: boolean } = {}) {
  const m = await h.json<{ id: string }>(await upload(h, as, png(300, 100), 'filename=screen.png'))
  await h.deps.store.updateMedia(m.id, {
    role: 'screen-recording',
    kind: 'video',
    ext: 'mp4',
    width: 1280,
    height: 720,
    durationSec: opts.seconds ?? 100,
    ...(opts.trace ? { traceKey: `${m.id}/trace.json`, traceSha256: sha(trace) } : {}),
  })
  if (opts.trace) await h.deps.blobs.set('media', `${m.id}/trace.json`, trace)
  return m.id
}

const create = (h: Harness, as: string, body: Record<string, unknown>) =>
  h.call('POST', '/api/v1/videos', { as, body: { prompt: PROMPT, ...body } })

describe('demo API', () => {
  it('creates a demo: the recording, frozen trace and setup boxes on the version; private; the default length', async () => {
    const h = harness()
    const id = await recording(h, h.member, { trace: true })
    const res = await create(h, h.member, {
      recording: { mediaId: id, trim: [10, 90], redact: [{ start: 5, end: 60, box: [0.8, 0, 0.2, 0.08] }] },
    })
    expect(res.status).toBe(202)
    const v = await h.json<{ id: string; private: boolean; versions: { recording: unknown }[] }>(res)
    const row = await h.deps.store.getVersion(v.id, 1)
    console.log(JSON.stringify({ test: 'recording-api', case: 'create', recording: row?.recording }))
    expect(row?.recording).toEqual({
      mediaId: id,
      trace: { key: `${id}/trace.json`, sha256: sha(trace) },
      trim: [10, 90],
      boxes: [{ start: 5, end: 60, reason: 'Hidden by you', boxes: [[5, 0.8, 0, 0.2, 0.08]] }],
      compose: false,
      summary: null,
      hidden: [],
    })
    // 80 s used -> 32 s.
    expect(row?.targetDurationSec).toBe(32)
    expect(v.private).toBe(true)
    expect((await h.deps.store.listVersionMedia(v.id, 1)).map((m) => [m.mediaId, m.filename])).toEqual([
      [id, `${id}.mp4`],
    ])
    expect(v.versions[0]?.recording).toEqual({
      mediaId: id,
      trace: true,
      compose: false,
      summary: null,
      hidden: [],
    })
    // The trace is frozen now a video uses it.
    const put = await h.call('PUT', `/api/v1/media/${id}/trace`, {
      as: h.member,
      body: JSON.parse(trace) as object,
    })
    expect(put.status).toBe(409)
  })

  it('a demo with nothing hidden stays team-visible; any other video has no recording', async () => {
    const h = harness()
    const id = await recording(h, h.member)
    const v = await h.json<{ id: string; private: boolean }>(
      await create(h, h.member, { recording: { mediaId: id } }),
    )
    expect(v.private).toBe(false)
    expect((await h.deps.store.getVersion(v.id, 1))?.targetDurationSec).toBe(40)
    const plain = await h.json<{ versions: { recording?: unknown }[] }>(await create(h, h.member, {}))
    expect(plain.versions[0]?.recording ?? null).toBeNull()
  })

  it('guards: not readable 404, being deleted 410, bad trim or box 400, an ordinary clip that is not a recording 400', async () => {
    const h = harness()
    const mine = await recording(h, h.member)
    const other = await person(h, 'u_cora', 'creator')
    const cases: [string, string, Record<string, unknown>, number, RegExp?][] = [
      ['another person’s unused recording', other, { mediaId: mine }, 404],
      ['trim under 2 s', h.member, { mediaId: mine, trim: [10, 11] }, 400, /at least 2 seconds/],
      ['trim past the end', h.member, { mediaId: mine, trim: [10, 140] }, 400, /inside the recording/],
      [
        'box past the frame',
        h.member,
        { mediaId: mine, redact: [{ start: 0, end: 5, box: [0.9, 0, 0.2, 0.1] }] },
        400,
        /inside the frame/,
      ],
    ]
    for (const [name, as, rec, status, msg] of cases) {
      const res = await create(h, as, { recording: rec })
      const body = await res.text()
      console.log(JSON.stringify({ test: 'recording-api', case: name, status: res.status }))
      expect(res.status, name).toBe(status)
      if (msg) expect(body, name).toMatch(msg)
    }
    await h.deps.store.updateMedia(mine, { deletingAt: '2026-11-05T10:00:00.000Z' })
    expect((await create(h, h.member, { recording: { mediaId: mine } })).status).toBe(410)
    // An ordinary video (not uploaded as a recording) whose bytes don't meet the recording rules.
    const clip = await h.json<{ id: string }>(await upload(h, h.member, png(64, 64), 'filename=clip.png'))
    await h.deps.store.updateMedia(clip.id, { kind: 'video', ext: 'mp4', durationSec: 30 })
    const res = await create(h, h.member, { recording: { mediaId: clip.id } })
    expect(res.status).toBe(400)
    expect(await res.text()).toMatch(/can't be used as a recording/)
  })

  it('remix: a new recording replaces the source’s; without one, a demo’s recording carries on', async () => {
    const h = harness()
    const source = await readyVideo(h)
    const id = await recording(h, h.member)
    const remixed = await h.json<{ id: string }>(
      await h.call('POST', `/api/v1/videos/${source}/remix`, {
        as: h.member,
        body: { prompt: 'Same, as a demo', recording: { mediaId: id } },
      }),
    )
    expect((await h.deps.store.getVersion(remixed.id, 1))?.recording?.mediaId).toBe(id)
    // The source as a demo: its recording on the version and in its media.
    await h.deps.store.updateVersion(source, 1, {
      recording: {
        mediaId: id,
        trace: null,
        trim: null,
        boxes: [],
        compose: false,
        summary: null,
        hidden: [],
      },
    })
    await h.deps.store.insertVersionMedia([
      {
        jobId: source,
        versionN: 1,
        mediaId: id,
        position: 9,
        kind: 'video',
        key: `${id}/clean.mp4`,
        sha256: 'a'.repeat(64),
        filename: `${id}.mp4`,
        caption: null,
      },
    ])
    const again = await h.json<{ id: string }>(
      await h.call('POST', `/api/v1/videos/${source}/remix`, {
        as: h.member,
        body: { prompt: 'Same, for payments', mediaIds: [] },
      }),
    )
    expect((await h.deps.store.getVersion(again.id, 1))?.recording).toMatchObject({
      mediaId: id,
      summary: null,
      hidden: [],
    })
    expect((await h.deps.store.listVersionMedia(again.id, 1)).map((m) => m.mediaId)).toContain(id)
  })

  it('features list screen_recording; MCP create_video takes recording_media_id', async () => {
    const h = harness()
    const config = await h.json<{ features: string[] }>(
      await h.call('GET', '/api/v1/config', { as: h.member }),
    )
    expect(config.features).toContain('screen_recording')
    const id = await recording(h, h.member)
    const key = await apiKey(h, h.member)
    const r = (await mcpCall(h, key, 'tools/call', {
      name: 'create_video',
      arguments: { prompt: PROMPT, recording_media_id: id, trim: [0, 50] },
    })) as { content?: { text?: string }[] }
    const videoId = (JSON.parse(r.content?.[0]?.text ?? '{}') as { video_id?: string }).video_id ?? ''
    expect(videoId, JSON.stringify(r).slice(0, 300)).toMatch(/^vid_/)
    expect((await h.deps.store.getVersion(videoId, 1))?.recording).toMatchObject({
      mediaId: id,
      trim: [0, 50],
    })
  })
})
