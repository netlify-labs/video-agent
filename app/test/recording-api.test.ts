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
      crop: null,
      privacy: false,
      summary: null,
      hidden: [],
      privacyWarnings: [],
    })
    // The trace is frozen now a video uses it.
    const put = await h.call('PUT', `/api/v1/media/${id}/trace`, {
      as: h.member,
      body: JSON.parse(trace) as object,
    })
    expect(put.status).toBe(409)
  })

  it('crop: kept in source pixels on the version and its DTO; setup boxes become fractions of the cropped picture', async () => {
    const h = harness()
    const id = await recording(h, h.member, { trace: true })
    const res = await create(h, h.member, {
      recording: {
        mediaId: id,
        crop: [0.25, 0.25, 0.5, 0.5],
        redact: [
          // Inside the crop, half in it, and outside it (nothing left to hide: left out).
          { box: [0.3, 0.3, 0.1, 0.1] },
          { start: 2, end: 9, box: [0.7, 0.7, 0.2, 0.2], style: 'solid' },
          { box: [0, 0, 0.1, 0.1] },
        ],
      },
    })
    expect(res.status).toBe(202)
    const v = await h.json<{ id: string; private: boolean; versions: { recording: { crop: unknown } }[] }>(
      res,
    )
    const crop = { x: 320, y: 180, width: 640, height: 360, frameWidth: 1280, frameHeight: 720 }
    const row = await h.deps.store.getVersion(v.id, 1)
    console.log(JSON.stringify({ test: 'recording-api', case: 'crop', recording: row?.recording }))
    expect(row?.recording?.crop).toEqual(crop)
    expect(row?.recording?.boxes).toEqual([
      { start: 0, end: 100, reason: 'Hidden by you', boxes: [[0, 0.1, 0.1, 0.2, 0.2]] },
      { start: 2, end: 9, reason: 'Hidden by you', style: 'solid', boxes: [[2, 0.9, 0.9, 0.1, 0.1]] },
    ])
    expect(v.versions[0]?.recording.crop).toEqual(crop)
    expect(v.private).toBe(true)

    // The whole frame is no crop.
    const whole = await h.json<{ id: string }>(
      await create(h, h.member, { recording: { mediaId: id, crop: [0, 0, 1, 1] } }),
    )
    expect((await h.deps.store.getVersion(whole.id, 1))?.recording?.crop).toBeUndefined()

    // Too small, or past the frame: 400 with the reason.
    for (const [bad, says] of [
      [[0, 0, 0.05, 0.5], 'at least'],
      [[0.6, 0, 0.5, 1], 'inside the frame'],
    ] as const) {
      const r = await create(h, h.member, { recording: { mediaId: id, crop: bad } })
      expect(r.status).toBe(400)
      expect(JSON.stringify(await r.json())).toContain(says)
    }
  })

  it('privacy mode is off unless asked; on, it rides on the version and its DTO', async () => {
    const h = harness()
    const id = await recording(h, h.member)
    const on = await h.json<{ id: string; versions: { recording: { privacy: boolean } }[] }>(
      await create(h, h.member, { recording: { mediaId: id, privacy: true } }),
    )
    expect((await h.deps.store.getVersion(on.id, 1))?.recording?.privacy).toBe(true)
    expect(on.versions[0]?.recording.privacy).toBe(true)
    // It will hide things for the person to check: private from the start.
    expect(
      (await h.json<{ private: boolean }>(await h.call('GET', `/api/v1/videos/${on.id}`, { as: h.member })))
        .private,
    ).toBe(true)
    const off = await h.json<{ id: string; versions: { recording: { privacy: boolean } }[] }>(
      await create(h, h.member, { recording: { mediaId: id } }),
    )
    expect((await h.deps.store.getVersion(off.id, 1))?.recording?.privacy).toBeUndefined()
    expect(off.versions[0]?.recording.privacy).toBe(false)
  })

  it('hide strings: trimmed, repeats dropped, kept on the version (never in its DTO), and the demo starts private', async () => {
    const h = harness()
    const id = await recording(h, h.member)
    const v = await h.json<{
      id: string
      private: boolean
      versions: { recording: Record<string, unknown> }[]
    }>(
      await create(h, h.member, {
        recording: { mediaId: id, hideStrings: ['  Acme   Labs ', 'Acme Labs', 'Priya Raman'] },
      }),
    )
    expect((await h.deps.store.getVersion(v.id, 1))?.recording?.hideStrings).toEqual([
      'Acme Labs',
      'Priya Raman',
    ])
    expect(JSON.stringify(v.versions[0]?.recording)).not.toContain('Priya')
    expect(v.private).toBe(true)
    const tooMany = await create(h, h.member, {
      recording: { mediaId: id, hideStrings: Array.from({ length: 51 }, (_, i) => `word ${String(i)}`) },
    })
    expect(tooMany.status).toBe(400)
  })

  it('setup boxes are blurred unless they say solid', async () => {
    const h = harness()
    const id = await recording(h, h.member)
    const v = await h.json<{ id: string }>(
      await create(h, h.member, {
        recording: {
          mediaId: id,
          redact: [
            { start: 0, end: 10, box: [0.1, 0.1, 0.2, 0.1], style: 'solid' },
            { start: 0, end: 10, box: [0.5, 0.5, 0.2, 0.1] },
          ],
        },
      }),
    )
    const boxes = (await h.deps.store.getVersion(v.id, 1))?.recording?.boxes ?? []
    console.log(
      JSON.stringify({ test: 'recording-api', case: 'style', styles: boxes.map((b) => b.style ?? null) }),
    )
    expect(boxes.map((b) => b.style)).toEqual(['solid', undefined])
    const bad = await create(h, h.member, {
      recording: {
        mediaId: id,
        redact: [{ start: 0, end: 10, box: [0.1, 0.1, 0.2, 0.1], style: 'pixelate' }],
      },
    })
    expect(bad.status).toBe(400)
  })

  it('a setup box with no start or end covers the whole recording; one end given keeps it', async () => {
    const h = harness()
    const id = await recording(h, h.member)
    const v = await h.json<{ id: string }>(
      await create(h, h.member, {
        recording: {
          mediaId: id,
          redact: [{ box: [0.1, 0.1, 0.2, 0.1] }, { start: 30, box: [0.5, 0.5, 0.2, 0.1] }],
        },
      }),
    )
    const boxes = (await h.deps.store.getVersion(v.id, 1))?.recording?.boxes ?? []
    console.log(
      JSON.stringify({ test: 'recording-api', case: 'whole', spans: boxes.map((b) => [b.start, b.end]) }),
    )
    expect(boxes.map((b) => [b.start, b.end, b.boxes[0]?.[0]])).toEqual([
      [0, 100, 0],
      [30, 100, 30],
    ])
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
