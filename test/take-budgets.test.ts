// Budgets for narration takes (voice-over plan §8): stored bytes per person (the takeQuotaBytes setting, 2 GiB by
// default) over ready and in-flight takes, with takes GC is deleting counted as freed, checked at upload create and
// complete; and at most TAKE_UPLOADS_PER_HOUR take uploads per person in any hour.
import { describe, expect, it } from 'vitest'
import {
  TAKE_UPLOADS_PER_HOUR,
  completeUpload,
  createUpload,
  PART_SIZE,
  putPart,
  quotaForTakes,
} from '../src/domain/media-uploads.js'
import { TAKE_ROLES } from '../src/domain/media-roles.js'
import type { Principal } from '../src/domain/policy.js'
import {
  NARRATION_SETTING_DEFAULTS,
  NO_PROVENANCE,
  type MediaRow,
  type MediaUploadRow,
} from '../src/domain/types.js'
import { sha256Hex } from '../src/lib/crypto.js'
import { ApiError } from '../src/lib/errors.js'
import type { Store } from '../src/store/types.js'
import { createMemoryStore } from '../src/store/memory.js'
import { harness, pgStore, PROMPT, type Harness } from './helpers.js'

const MiB = 1024 ** 2
const sha = 'a'.repeat(64)
let n = 0

const take = (over: Partial<MediaRow> = {}): MediaRow => {
  n += 1
  const at = over.createdAt ?? '2026-11-03T10:00:00.000Z'
  return {
    id: `med_take${n}`,
    uploaderId: 'u_member',
    kind: 'audio',
    status: 'ready',
    rejectReason: null,
    filename: `take-${n}.wav`,
    title: null,
    caption: null,
    mime: 'audio/wav',
    ext: 'wav',
    bytes: MiB,
    originalKey: `med_take${n}/original.wav`,
    originalSha256: sha,
    cleanKey: `med_take${n}/original.wav`,
    cleanSha256: sha,
    width: null,
    height: null,
    durationSec: 10,
    posterKey: null,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    role: 'narration-take',
    scopeJobId: null,
    retainUntil: null,
    deletingAt: null,
    ...NO_PROVENANCE,
    ...over,
  }
}

const member: Principal = {
  kind: 'user',
  userId: 'u_member',
  email: 'mia@acme.com',
  name: 'Mia Member',
  role: 'creator',
  apiKeyId: null,
}

/** A video for takes to be recorded for (not driven: a take only needs one the person can see). */
const video = async (h: Harness) =>
  (
    await h.json<{ id: string }>(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
    )
  ).id

/** A file of `size` bytes and its sha256; sendParts uploads it for real, so completion's whole-file check passes. */
const file = (size: number) => {
  const bytes = new Uint8Array(size).fill(7)
  return { bytes, sha256: sha256Hex(bytes) }
}
async function sendParts(h: Harness, s: { id: string; partCount: number }, bytes: Uint8Array) {
  for (let i = 0; i < s.partCount; i++)
    await putPart(h.deps, member, s.id, i, bytes.subarray(i * PART_SIZE, (i + 1) * PART_SIZE), undefined)
}

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e as ApiError,
  )

describe.each([
  ['memory', async () => createMemoryStore() as Store],
  ['postgres', pgStore],
] as const)('take usage (%s)', (_name, make) => {
  it('counts ready and in-flight takes, not rejected, deleting, other kinds or other people', async () => {
    const store = await make()
    for (const row of [
      take({ bytes: 100 }),
      take({ bytes: 50, status: 'verifying' }),
      take({ bytes: 20, status: 'uploading', role: 'narration-upload' }),
      take({ bytes: 5, deletedAt: '2026-11-03T11:00:00.000Z' }),
      take({ bytes: 1000, status: 'rejected' }),
      take({ bytes: 500, deletingAt: '2026-11-03T11:00:00.000Z' }),
      take({ bytes: 999, role: null }),
      take({ bytes: 777, uploaderId: 'u_admin' }),
    ])
      await store.insertMedia(row)
    // Soft-deleted takes still hold their bytes until GC marks them deleting.
    expect(await store.narrationTakeBytes('u_member')).toBe(175)
    expect(await store.narrationTakeBytes('u_nobody')).toBe(0)
    expect(await store.countRoleUploads('u_member', TAKE_ROLES, '2026-11-03T10:00:00.000Z')).toBe(6)
    expect(await store.countRoleUploads('u_member', TAKE_ROLES, '2026-11-03T10:00:00.001Z')).toBe(0)
  })

  it('counts open take sessions (bytes and starts) until their media row does; not other sessions', async () => {
    const store = await make()
    const at = '2026-11-03T10:00:00.000Z'
    const session = (id: string, over: Partial<MediaUploadRow>): MediaUploadRow => ({
      id,
      uploaderId: 'u_member',
      filename: 'take.wav',
      caption: null,
      size: 10,
      sha256: sha,
      partSize: PART_SIZE,
      partCount: 1,
      status: 'open',
      mediaId: null,
      error: null,
      leaseUntil: null,
      createdAt: at,
      expiresAt: '2026-11-04T10:00:00.000Z',
      role: 'narration-take',
      scopeJobId: 'job_1',
      ...over,
    })
    await store.insertMedia(take({ bytes: 100 }))
    for (const row of [
      session('upl_open', {}),
      session('upl_upload', { size: 20, role: 'narration-upload' }),
      // Completed: its media row (above) is what counts.
      session('upl_done', { size: 100, status: 'assembling', mediaId: 'med_x' }),
      session('upl_lib', { size: 1000, role: null, scopeJobId: null }),
      session('upl_other', { size: 1000, uploaderId: 'u_admin' }),
    ])
      await store.insertUpload(row)
    expect(await store.narrationTakeBytes('u_member')).toBe(130)
    expect(await store.countRoleUploads('u_member', TAKE_ROLES, at)).toBe(3)
    expect(await store.countRoleUploads('u_member', TAKE_ROLES, '2026-11-03T10:00:00.001Z')).toBe(0)
  })
})

describe('take quota', () => {
  it('reports what is left, and refuses with 413 quota_exceeded and the bytes left when a take does not fit', async () => {
    const h = harness()
    await h.call('PATCH', '/api/v1/admin/settings', { as: h.admin, body: { takeQuotaBytes: 10 * MiB } })
    await h.deps.store.insertMedia(take({ bytes: 4 * MiB }))
    await h.deps.store.insertMedia(take({ bytes: 2 * MiB, status: 'verifying' }))
    await h.deps.store.insertMedia(take({ bytes: 50 * MiB, deletingAt: '2026-11-03T11:00:00.000Z' }))
    expect(await quotaForTakes(h.deps, 'u_member', 3 * MiB)).toEqual({
      quotaBytes: 10 * MiB,
      usedBytes: 6 * MiB,
      remainingBytes: MiB,
    })
    expect(await quotaForTakes(h.deps, 'u_member', 4 * MiB)).toMatchObject({ remainingBytes: 0 })
    const e = await refusal(quotaForTakes(h.deps, 'u_member', 4 * MiB + 1))
    expect(e).toBeInstanceOf(ApiError)
    expect(e).toMatchObject({
      code: 'quota_exceeded',
      status: 413,
      details: {
        quotaBytes: 10 * MiB,
        usedBytes: 6 * MiB,
        remainingBytes: 4 * MiB,
        incomingBytes: 4 * MiB + 1,
      },
    })
    expect(e?.message).toMatch(/4 MB of 10 MB left.*Delete unused recordings/)
    expect(h.deps.logs.some((l) => l.includes('"media.take_quota_exceeded"'))).toBe(true)
  })

  it('uses the 2 GiB default until an admin changes it', async () => {
    const h = harness()
    expect((await quotaForTakes(h.deps, 'u_member', 0)).quotaBytes).toBe(
      NARRATION_SETTING_DEFAULTS.takeQuotaBytes,
    )
    await h.call('PATCH', '/api/v1/admin/settings', { as: h.admin, body: { takeQuotaBytes: 64 * MiB } })
    expect((await quotaForTakes(h.deps, 'u_member', 0)).quotaBytes).toBe(64 * MiB)
  })

  it('is checked when a take upload starts, and again when it completes; other uploads are untouched', async () => {
    const h = harness()
    const p = member
    await h.call('PATCH', '/api/v1/admin/settings', { as: h.admin, body: { takeQuotaBytes: 10 * MiB } })
    await h.deps.store.insertMedia(take({ bytes: 4 * MiB }))
    const f = file(5 * MiB)
    const input = {
      filename: 'take.wav',
      size: 5 * MiB,
      sha256: f.sha256,
      role: 'narration-take' as const,
      scopeJobId: await video(h),
    }

    const s = await createUpload(h.deps, p, input)
    // The open session holds its 5 MB.
    expect(await h.deps.store.narrationTakeBytes('u_member')).toBe(9 * MiB)
    // Another take finished meanwhile: this one no longer fits when it completes.
    await h.deps.store.insertMedia(take({ bytes: 2 * MiB, status: 'verifying' }))
    await sendParts(h, s, f.bytes)
    expect(await refusal(completeUpload(h.deps, p, s.id))).toMatchObject({ code: 'quota_exceeded' })
    expect((await h.deps.store.getUpload(s.id))?.status).toBe('open')

    expect(await refusal(createUpload(h.deps, p, input))).toMatchObject({
      code: 'quota_exceeded',
      details: { usedBytes: 11 * MiB, remainingBytes: 0 },
    })
    // A video or music upload isn't a take.
    expect((await createUpload(h.deps, p, { ...input, role: null, scopeJobId: undefined })).status).toBe(
      'open',
    )
  })

  it('a completed take carries its role, so it counts against the quota while it is checked', async () => {
    const h = harness()
    const p = member
    // Leave it being checked: assembly isn't run.
    h.deps.platform.onAssemble = null
    const f = file(3 * MiB)
    const scopeJobId = await video(h)
    const s = await createUpload(h.deps, p, {
      filename: 'take.wav',
      size: 3 * MiB,
      sha256: f.sha256,
      role: 'narration-take',
      scopeJobId,
    })
    await sendParts(h, s, f.bytes)
    const done = await completeUpload(h.deps, p, s.id)
    expect(await h.deps.store.getMedia(done.mediaId ?? '')).toMatchObject({
      role: 'narration-take',
      scopeJobId,
      status: 'verifying',
    })
    // Counted once: by its media row now, not also as an open session.
    expect(await h.deps.store.narrationTakeBytes('u_member')).toBe(3 * MiB)
  })
})

describe('take upload rate limit', () => {
  it(`allows ${TAKE_UPLOADS_PER_HOUR} take uploads in any hour, then refuses until the window moves on`, async () => {
    const h = harness()
    const p = member
    const now = h.deps.clock.now().getTime()
    for (let i = 0; i < TAKE_UPLOADS_PER_HOUR; i++)
      await h.deps.store.insertMedia(
        take({ bytes: 1, createdAt: new Date(now - 59 * 60_000 + i * 1000).toISOString() }),
      )
    const input = {
      filename: 'take.wav',
      size: MiB,
      sha256: sha,
      role: 'narration-take' as const,
      scopeJobId: await video(h),
    }
    const e = await refusal(createUpload(h.deps, p, input))
    expect(e).toMatchObject({ code: 'rate_limited', status: 429 })
    expect(h.deps.logs.some((l) => l.includes('"media.take_rate_limited"'))).toBe(true)
    // Other uploads aren't limited by it.
    expect((await createUpload(h.deps, p, { ...input, role: undefined, scopeJobId: undefined })).status).toBe(
      'open',
    )
    // A minute on, the oldest take has left the window.
    h.deps.clock.advance(61_000)
    expect((await createUpload(h.deps, p, input)).status).toBe('open')
    // That open session counts too: the window is full again until the next take leaves it.
    expect(await refusal(createUpload(h.deps, p, input))).toMatchObject({ code: 'rate_limited' })
  })
})
