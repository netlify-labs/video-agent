// The media role table (screen-recording plan §4.2, "The role table"): every role rule lives in ROLES, takes keep
// their behaviour (test/take-uploads.test.ts and test/take-budgets.test.ts pin each take rule through the API and
// run unchanged), and only the two take roles count as takes, the same way in both stores. A row with any other role
// is a library item: listed, never a take, outside the take budgets.
import { describe, expect, it } from 'vitest'
import { budgetRoles, isTakeRole, ROLES, TAKE_ROLES, UPLOAD_ROLES } from '../src/domain/media-roles.js'
import { createUpload, TAKE_UPLOADS_PER_HOUR } from '../src/domain/media-uploads.js'
import type { Principal } from '../src/domain/policy.js'
import { isTake } from '../src/domain/takes.js'
import {
  MEDIA_ROLES,
  NO_PROVENANCE,
  type MediaRole,
  type MediaRow,
  type MediaUploadRow,
} from '../src/domain/types.js'
import type { ApiError } from '../src/lib/errors.js'
import { createMemoryStore } from '../src/store/memory.js'
import type { Store } from '../src/store/types.js'
import { harness, pgStore, PROMPT } from './helpers.js'

const log = (test: string, fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ test, ...fields }))

let n = 0
const row = (over: Partial<MediaRow> = {}): MediaRow => {
  n += 1
  const at = over.createdAt ?? '2026-11-05T10:00:00.000Z'
  return {
    id: `med_role${n}`,
    uploaderId: 'u_member',
    kind: 'audio',
    status: 'ready',
    rejectReason: null,
    filename: `item-${n}.wav`,
    title: null,
    caption: null,
    mime: 'audio/wav',
    ext: 'wav',
    bytes: 1000,
    originalKey: `med_role${n}/original.wav`,
    originalSha256: 'a'.repeat(64),
    cleanKey: `med_role${n}/original.wav`,
    cleanSha256: 'a'.repeat(64),
    width: null,
    height: null,
    durationSec: 10,
    posterKey: null,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    role: null,
    scopeJobId: null,
    retainUntil: null,
    deletingAt: null,
    ...NO_PROVENANCE,
    ...over,
  }
}

/** A role no take rule knows: stands in for the next role (screen recordings) until it joins MediaRole. */
const OTHER = 'some-other-role' as MediaRole

const member: Principal = {
  kind: 'user',
  userId: 'u_member',
  email: 'mia@acme.com',
  name: 'Mia Member',
  role: 'creator',
  apiKeyId: null,
}

describe('ROLES', () => {
  it('has one row per role, and takes and uploaded takes share one policy', () => {
    expect(Object.keys(ROLES).sort()).toEqual([...MEDIA_ROLES].sort())
    expect(ROLES['screen-recording']).toEqual({
      audioOnly: false,
      needsScope: false,
      quotaSetting: 'recordingQuotaBytes',
      perHour: 10,
      gatedBy: null,
      samples: false,
    })
    expect(budgetRoles('screen-recording')).toEqual(['screen-recording'])
    for (const role of TAKE_ROLES)
      expect(ROLES[role]).toEqual({
        audioOnly: true,
        needsScope: true,
        quotaSetting: 'takeQuotaBytes',
        perHour: TAKE_UPLOADS_PER_HOUR,
        gatedBy: 'narration',
        samples: true,
      })
    expect(UPLOAD_ROLES).toEqual([...TAKE_ROLES, 'screen-recording'])
    expect(budgetRoles('narration-take').sort()).toEqual([...TAKE_ROLES].sort())
    expect(budgetRoles('narration-upload').sort()).toEqual([...TAKE_ROLES].sort())
  })

  it('isTakeRole and isTake mean the two take roles, nothing else', () => {
    for (const role of TAKE_ROLES) {
      expect(isTakeRole(role)).toBe(true)
      expect(isTake({ role })).toBe(true)
    }
    for (const role of [null, undefined, '', OTHER]) {
      expect(isTakeRole(role)).toBe(false)
      if (role !== undefined && role !== '') expect(isTake({ role: role as MediaRole | null })).toBe(false)
    }
  })
})

describe('createUpload role rules', () => {
  it('refuses an unknown role; the domain check names the accepted roles', async () => {
    const h = harness()
    const res = await h.call('POST', '/api/v1/media/uploads', {
      as: h.member,
      body: {
        filename: 'a.wav',
        size: 10,
        sha256: 'b'.repeat(64),
        role: 'bogus-role',
        scopeJobId: 'job_x',
      },
    })
    log('unknown role', { role: 'bogus-role', step: 'create', outcome: res.status })
    // The request schema refuses it first; the domain's own check names the roles it accepts.
    expect(res.status).toBe(400)
    const e = await createUpload(h.deps, member, {
      filename: 'a.wav',
      size: 10,
      sha256: 'b'.repeat(64),
      role: OTHER,
      scopeJobId: 'job_x',
    }).catch((x: unknown) => x as ApiError)
    expect(e).toMatchObject({
      code: 'invalid_request',
      message: 'role must be narration-take or narration-upload or screen-recording.',
    })
  })

  it('counts takes and uploaded takes together against the hourly budget', async () => {
    const h = harness()
    const jobId = (
      await h.json<{ id: string }>(
        await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
      )
    ).id
    const now = h.deps.clock.now().toISOString()
    // Another role's rows sit outside the take budget.
    await h.deps.store.insertMedia(row({ role: OTHER, createdAt: now }))
    for (let i = 0; i < TAKE_UPLOADS_PER_HOUR - 1; i++)
      await h.deps.store.insertMedia(
        row({ role: i % 2 ? 'narration-take' : 'narration-upload', createdAt: now }),
      )
    const input = { filename: 't.wav', size: 10, sha256: 'b'.repeat(64), scopeJobId: jobId }
    // One short of the budget: either take role may start one more, and that one fills it for both.
    expect((await createUpload(h.deps, member, { ...input, role: 'narration-upload' })).status).toBe('open')
    const e = await createUpload(h.deps, member, { ...input, role: 'narration-take' }).catch(
      (x: unknown) => x as ApiError,
    )
    log('hourly budget', {
      role: 'narration-take',
      step: 'create',
      outcome: e instanceof Error ? e.code : 'open',
    })
    expect(e).toMatchObject({ code: 'rate_limited', status: 429 })
  })
})

describe.each([
  ['memory', async () => createMemoryStore() as Store],
  ['postgres', pgStore],
] as const)('a non-take role is a library item (%s)', (name, make) => {
  it('is listed in the library, never as a take, and outside every take budget', async () => {
    const store = await make()
    const other = row({ role: OTHER, kind: 'video', ext: 'mp4', mime: 'video/mp4', bytes: 5000 })
    const take = row({ role: 'narration-take', bytes: 700 })
    const plain = row()
    for (const m of [other, take, plain]) await store.insertMedia(m)
    const open: MediaUploadRow = {
      id: `upl_role${n}`,
      uploaderId: 'u_member',
      filename: 'other.mp4',
      caption: null,
      size: 9000,
      sha256: 'c'.repeat(64),
      partSize: 4 * 1024 * 1024,
      partCount: 1,
      status: 'open',
      mediaId: null,
      error: null,
      createdAt: '2026-11-05T10:00:00.000Z',
      expiresAt: '2026-11-06T10:00:00.000Z',
      leaseUntil: null,
      role: OTHER,
      scopeJobId: null,
    }
    await store.insertUpload(open)

    const ids = async (q: Parameters<Store['listMedia']>[0]) =>
      (await store.listMedia(q)).map((m) => m.id).sort()
    // Someone else's library: the other role is listed with plain items; the take stays its uploader's.
    expect(await ids({ limit: 50 })).toEqual([other.id, plain.id].sort())
    expect(await ids({ limit: 50, takesOf: 'u_member' })).toEqual([other.id, plain.id, take.id].sort())
    expect(await ids({ limit: 50, takesOf: 'u_member', recordings: 'only' })).toEqual([take.id])
    expect(await ids({ limit: 50, takesOf: 'u_member', recordings: 'exclude' })).toEqual(
      [other.id, plain.id].sort(),
    )
    expect((await store.listUnreferencedTakes({ limit: 50 })).map((m) => m.id)).toEqual([take.id])
    // Take budgets: bytes and the hourly count see only takes (the open other-role session included).
    expect(await store.narrationTakeBytes('u_member')).toBe(700)
    expect(await store.countRoleUploads('u_member', TAKE_ROLES, '2026-11-05T00:00:00.000Z')).toBe(1)
    expect(await store.countRoleUploads('u_member', [OTHER], '2026-11-05T00:00:00.000Z')).toBe(2)
    expect(await store.countRoleUploads('u_member', [], '2026-11-05T00:00:00.000Z')).toBe(0)
    expect(isTake(other)).toBe(false)
    log('store parity', { store: name, role: OTHER, step: 'list', outcome: 'library item' })
  })
})
