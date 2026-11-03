// Take upload sessions (voice-over plan §5.1, §6.1, §7): a recording's session names its role and the video it's for
// (one the person can see), carries the recorder's whole-file sha256 (checked at completion: a mismatch is a 400),
// and the media row gets both role and scope. Peaks and speech spans are sent by the uploader, before or after the
// take is ready, and read under canReadTake. Takes never go through the single-request upload.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PART_SIZE } from '../src/domain/media-uploads.js'
import { PEAKS_MAX_BYTES, takeSamples } from '../src/domain/take-extras.js'
import { classify } from '../src/lib/media/classify.js'
import { computePeaks, decodePeaks, encodePeaks } from '../src/lib/peaks.js'
import { wav } from '../src/lib/voice.js'
import { harness, person, png, PROMPT, raw, readyVideo, type Harness } from './helpers.js'

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

/** A mono 24 kHz WAV of `bytes` PCM bytes, a quiet ramp so it isn't all zeros. */
const take = (bytes = 600_000) => wav(new Uint8Array(bytes).map((_, i) => i % 64))

const peaksOf = (seconds = 2) => encodePeaks(computePeaks(new Float32Array(24_000 * seconds).fill(0.25)))

interface Session {
  id: string
  partCount: number
  status: string
  mediaId: string | null
  error: string | null
  role: string | null
  scopeJobId: string | null
}

const newVideo = async (h: Harness, as = h.member) =>
  (await h.json<{ id: string }>(await h.call('POST', '/api/v1/videos', { as, body: { prompt: PROMPT } }))).id

const start = (h: Harness, as: string, file: Uint8Array, body: Record<string, unknown>) =>
  h.call('POST', '/api/v1/media/uploads', {
    as,
    body: { filename: 'take.wav', size: file.byteLength, sha256: sha(file), ...body },
  })

async function sendParts(h: Harness, as: string, s: Session, file: Uint8Array) {
  for (let i = 0; i < s.partCount; i++) {
    const body = file.subarray(i * PART_SIZE, (i + 1) * PART_SIZE)
    const res = await raw(h, as, 'PUT', `/api/v1/media/uploads/${s.id}/parts/${i}`, body, {
      'x-part-sha256': sha(body),
    })
    expect(res.status).toBe(200)
  }
}
const complete = (h: Harness, as: string, id: string) =>
  h.call('POST', `/api/v1/media/uploads/${id}/complete`, { as, body: {} })

/** A take uploaded through a session for `jobId`; with `assemble: false` it's left being checked. */
async function uploadTake(h: Harness, jobId: string, opts: { assemble?: boolean; as?: string } = {}) {
  const as = opts.as ?? h.member
  const file = take()
  const s = await h.json<Session>(await start(h, as, file, { role: 'narration-take', scopeJobId: jobId }))
  await sendParts(h, as, s, file)
  const onAssemble = h.deps.platform.onAssemble
  if (opts.assemble === false) h.deps.platform.onAssemble = null
  const done = await h.json<Session>(await complete(h, as, s.id))
  h.deps.platform.onAssemble = onAssemble
  return { session: done, mediaId: done.mediaId ?? '', file }
}

const putPeaks = (h: Harness, as: string, id: string, body: Uint8Array) =>
  raw(h, as, 'PUT', `/api/v1/media/${id}/peaks`, body)
const getPeaks = (h: Harness, as: string, id: string) => h.call('GET', `/api/v1/media/${id}/peaks`, { as })

describe('take upload sessions', () => {
  it('take a role, a readable video and the sha256; the media row gets role and scope', async () => {
    const h = harness()
    const jobId = await newVideo(h)
    const file = take()
    const res = await start(h, h.member, file, { role: 'narration-take', scopeJobId: jobId })
    expect(res.status).toBe(201)
    const s = await h.json<Session>(res)
    expect(s).toMatchObject({ role: 'narration-take', scopeJobId: jobId, status: 'open' })
    expect(
      (await h.json<Session>(await h.call('GET', `/api/v1/media/uploads/${s.id}`, { as: h.member }))).role,
    ).toBe('narration-take')
    await sendParts(h, h.member, s, file)
    const done = await h.json<Session>(await complete(h, h.member, s.id))
    expect(done).toMatchObject({ status: 'done', role: 'narration-take', scopeJobId: jobId })
    expect(await h.deps.store.getMedia(done.mediaId ?? '')).toMatchObject({
      kind: 'audio',
      status: 'ready',
      role: 'narration-take',
      scopeJobId: jobId,
      originalSha256: sha(file),
    })
    const logs = h.deps.logs.filter(
      (l) => l.includes('"media.upload_started"') || l.includes('upload_hash_checked'),
    )
    expect(logs.length).toBe(2)
    expect(logs[1]).toContain('"ok":true')
  })

  it('refuses a video the person cannot see (404), and role and scope without each other (400)', async () => {
    const h = harness()
    const cora = await person(h, 'u_cora', 'creator')
    const mine = await newVideo(h)
    expect(
      (await h.call('PATCH', `/api/v1/videos/${mine}`, { as: h.member, body: { private: true } })).status,
    ).toBe(200)
    const file = take()
    for (const scopeJobId of [mine, 'job_nope']) {
      const res = await start(h, cora, file, { role: 'narration-take', scopeJobId })
      expect(res.status, scopeJobId).toBe(404)
      expect((await h.json(res)).error.code).toBe('not_found')
    }
    expect((await start(h, h.member, file, { role: 'narration-upload' })).status).toBe(400)
    expect((await start(h, h.member, file, { scopeJobId: mine })).status).toBe(400)
    expect((await start(h, h.member, file, { role: 'narration-upload', scopeJobId: mine })).status).toBe(201)
  })

  it('a whole-file sha256 that does not match the parts is a 400, and the session fails', async () => {
    const h = harness()
    const jobId = await newVideo(h)
    const file = take()
    const s = await h.json<Session>(
      await start(h, h.member, file, { role: 'narration-take', scopeJobId: jobId, sha256: 'b'.repeat(64) }),
    )
    // Every part matches its own hash; only the recorder's whole-file hash is wrong.
    await sendParts(h, h.member, s, file)
    const res = await complete(h, h.member, s.id)
    expect(res.status).toBe(400)
    expect((await h.json(res)).error.message).toMatch(/sha256 doesn't match/)
    const after = await h.json<Session>(
      await h.call('GET', `/api/v1/media/uploads/${s.id}`, { as: h.member }),
    )
    expect(after).toMatchObject({ status: 'failed', mediaId: null })
    expect(await h.deps.blobs.list('media', `uploads/${s.id}/`)).toEqual([])
    expect(h.deps.platform.assemblies).toEqual([])
    expect(
      h.deps.logs.some((l) => l.includes('"media.upload_hash_checked"') && l.includes('"ok":false')),
    ).toBe(true)
  })

  it('a take that is not audio is rejected at assembly', async () => {
    const h = harness()
    const jobId = await newVideo(h)
    const file = png()
    const s = await h.json<Session>(
      await start(h, h.member, file, { role: 'narration-take', scopeJobId: jobId }),
    )
    await sendParts(h, h.member, s, file)
    const done = await h.json<Session>(await complete(h, h.member, s.id))
    expect(done).toMatchObject({ status: 'failed', error: 'A recording must be an audio file.' })
    expect((await h.deps.store.getMedia(done.mediaId ?? ''))?.status).toBe('rejected')
  })

  it('refuses a role on the single-request upload: recordings use sessions', async () => {
    const h = harness()
    const jobId = await newVideo(h)
    for (const q of ['role=narration-take', `scopeJobId=${jobId}`]) {
      const res = await raw(h, h.member, 'POST', `/api/v1/media?filename=take.wav&${q}`, take(1000))
      expect(res.status, q).toBe(400)
      expect((await h.json(res)).error.message).toMatch(/upload in a session/)
    }
  })

  it('refuses take sessions with 409 narration_disabled when an admin turned recording off', async () => {
    const h = harness()
    const jobId = await newVideo(h)
    await h.call('PATCH', '/api/v1/admin/settings', { as: h.admin, body: { narrationEnabled: false } })
    const res = await start(h, h.member, take(), { role: 'narration-take', scopeJobId: jobId })
    expect(res.status).toBe(409)
    expect((await h.json(res)).error.code).toBe('narration_disabled')
    // Library uploads carry on.
    expect((await start(h, h.member, take(), {})).status).toBe(201)
  })

  it('holds open take sessions against the recordings quota', async () => {
    const h = harness()
    const jobId = await newVideo(h)
    const file = take()
    await h.call('PATCH', '/api/v1/admin/settings', {
      as: h.admin,
      body: { takeQuotaBytes: file.byteLength * 2 + 10 },
    })
    for (let i = 0; i < 2; i++)
      expect((await start(h, h.member, file, { role: 'narration-take', scopeJobId: jobId })).status).toBe(201)
    const res = await start(h, h.member, file, { role: 'narration-take', scopeJobId: jobId })
    expect(res.status).toBe(413)
    expect((await h.json(res)).error.details).toMatchObject({
      usedBytes: file.byteLength * 2,
      remainingBytes: 10,
    })
  })
})

describe('take peaks and speech spans', () => {
  it('round-trip, sent before the take is ready; speech spans survive assembly in meta.json', async () => {
    const h = harness()
    const jobId = await newVideo(h)
    const { session, mediaId } = await uploadTake(h, jobId, { assemble: false })
    expect((await h.deps.store.getMedia(mediaId))?.status).toBe('verifying')
    const peaks = peaksOf()
    const put = await putPeaks(h, h.member, mediaId, peaks)
    expect(put.status).toBe(200)
    expect(await put.json()).toEqual({
      mediaId,
      bytes: peaks.byteLength,
      levels: decodePeaks(peaks).levels.length,
      samples: 48_000,
    })
    const spans = [
      [0, 4800],
      [12_000, 30_000],
    ]
    const sp = await h.call('PUT', `/api/v1/media/${mediaId}/speech`, {
      as: h.member,
      body: { version: 1, spans },
    })
    expect(sp.status).toBe(200)
    // The uploader reads them back while it's being checked.
    const early = await getPeaks(h, h.member, mediaId)
    expect(early.status).toBe(200)
    expect(early.headers.get('content-type')).toBe('application/octet-stream')
    expect(new Uint8Array(await early.arrayBuffer())).toEqual(peaks)

    await h.deps.platform.onAssemble?.(session.id)
    expect((await h.deps.store.getMedia(mediaId))?.status).toBe('ready')
    const meta = JSON.parse(
      new TextDecoder().decode((await h.deps.blobs.get('media', `${mediaId}/meta.json`)) ?? undefined),
    )
    // Top-level fields, as the narration op reads them; samples is filled in from the WAV header (600,000 bytes of
    // mono PCM16 at 24 kHz).
    expect(meta).toMatchObject({
      file: `${mediaId}/original.wav`,
      speech: spans,
      speechVersion: 1,
      samples: 300_000,
    })
    expect(await h.json(await h.call('GET', `/api/v1/media/${mediaId}/speech`, { as: h.member }))).toEqual({
      version: 1,
      spans,
      samples: 300_000,
    })
    // Now that the length is known, spans past it are refused.
    const past = await h.call('PUT', `/api/v1/media/${mediaId}/speech`, {
      as: h.member,
      body: { version: 1, spans: [[0, 300_001]] },
    })
    expect(past.status).toBe(400)
    expect(await h.deps.blobs.get('media', `${mediaId}/peaks.bin`)).toEqual(peaks)
    // After ready, sending again replaces them.
    const next = peaksOf(3)
    expect((await putPeaks(h, h.member, mediaId, next)).status).toBe(200)
    expect(new Uint8Array(await (await getPeaks(h, h.member, mediaId)).arrayBuffer())).toEqual(next)
    expect(h.deps.logs.some((l) => l.includes('"take.peaks_stored"'))).toBe(true)
  })

  it('checks what is sent: valid peaks within the cap, ordered whole-sample spans', async () => {
    const h = harness()
    const { mediaId } = await uploadTake(h, await newVideo(h))
    const bad = peaksOf()
    bad[0] = 0
    expect((await putPeaks(h, h.member, mediaId, bad)).status).toBe(400)
    expect((await putPeaks(h, h.member, mediaId, peaksOf().subarray(0, 40))).status).toBe(400)
    expect((await putPeaks(h, h.member, mediaId, new Uint8Array(PEAKS_MAX_BYTES + 1))).status).toBe(400)
    for (const spans of [
      [[10, 5]],
      [
        [0, 10],
        [5, 20],
      ],
      [[0.5, 10]],
      [[-1, 10]],
    ]) {
      const res = await h.call('PUT', `/api/v1/media/${mediaId}/speech`, {
        as: h.member,
        body: { version: 1, spans },
      })
      expect(res.status, JSON.stringify(spans)).toBe(400)
    }
    // The client's samples are kept: assembly fills samples in only when it's missing.
    const { session, mediaId: early } = await uploadTake(h, await newVideo(h), { assemble: false })
    await h.call('PUT', `/api/v1/media/${early}/speech`, {
      as: h.member,
      body: { version: 1, spans: [[0, 10]], samples: 299_990 },
    })
    await h.deps.platform.onAssemble?.(session.id)
    expect(
      await h.json(await h.call('GET', `/api/v1/media/${early}/speech`, { as: h.member })),
    ).toMatchObject({ samples: 299_990 })
    // A library item has no peaks.
    const lib = await h.json<{ id: string }>(
      await raw(h, h.member, 'POST', '/api/v1/media?filename=tone.wav', take(1000)),
    )
    expect((await putPeaks(h, h.member, lib.id, peaksOf())).status).toBe(400)
    expect((await getPeaks(h, h.member, lib.id)).status).toBe(404)
  })

  it('access: only the uploader writes; readers follow canReadTake (uploader, admin, Creator once used; never Reviewers)', async () => {
    const h = harness()
    const cora = await person(h, 'u_cora', 'creator')
    const rita = await person(h, 'u_rita', 'reviewer')
    const jobId = await readyVideo(h)
    const { mediaId } = await uploadTake(h, jobId)
    expect((await putPeaks(h, h.member, mediaId, peaksOf())).status).toBe(200)
    await h.call('PUT', `/api/v1/media/${mediaId}/speech`, {
      as: h.member,
      body: { version: 1, spans: [[0, 10]] },
    })
    const status = async (as: string) => ({
      peaks: (await getPeaks(h, as, mediaId)).status,
      speech: (await h.call('GET', `/api/v1/media/${mediaId}/speech`, { as })).status,
    })
    const ok = { peaks: 200, speech: 200 }
    const hidden = { peaks: 404, speech: 404 }
    expect(await status(h.member)).toEqual(ok)
    expect(await status(h.admin)).toEqual(ok)
    // Unused: private to its uploader.
    expect(await status(cora)).toEqual(hidden)
    expect(await status(rita)).toEqual(hidden)
    // Used on a version of a video they can see: Creators read it; Reviewers still never get raw takes.
    await h.deps.store.insertMediaRefs([
      {
        mediaId,
        ownerKind: 'version',
        ownerId: `${jobId}#1`,
        jobId,
        createdAt: h.deps.clock.now().toISOString(),
      },
    ])
    expect(await status(cora)).toEqual(ok)
    expect(await status(rita)).toEqual(hidden)
    // Writing is the uploader's alone, even for those who can read it.
    expect((await putPeaks(h, cora, mediaId, peaksOf())).status).toBe(404)
    expect((await putPeaks(h, h.admin, mediaId, peaksOf())).status).toBe(404)
    expect(
      (
        await h.call('PUT', `/api/v1/media/${mediaId}/speech`, {
          as: cora,
          body: { version: 1, spans: [] },
        })
      ).status,
    ).toBe(404)
    // A take GC has begun deleting is gone for everyone.
    await h.deps.store.updateMedia(mediaId, { deletingAt: h.deps.clock.now().toISOString() })
    expect(await status(h.member)).toEqual(hidden)
    expect((await putPeaks(h, h.member, mediaId, peaksOf())).status).toBe(404)
  })
})

describe('takeSamples', () => {
  it('is exact from a PCM WAV header (resampled to 24 kHz), else from the duration', () => {
    const w = take(48_002)
    expect(takeSamples(w, classify(w))).toBe(24_001)
    // The same data chunk declared as 48 kHz stereo: 12,000 frames, 6,000 samples at 24 kHz.
    const st = take(48_000)
    const dv = new DataView(st.buffer)
    dv.setUint16(22, 2, true)
    dv.setUint32(24, 48_000, true)
    dv.setUint32(28, 48_000 * 4, true)
    dv.setUint16(32, 4, true)
    expect(takeSamples(st, classify(st))).toBe(6_000)
    expect(takeSamples(new Uint8Array(4), { ...classify(w), ext: 'mp3', durationSec: 1.5 })).toBe(36_000)
  })
})
