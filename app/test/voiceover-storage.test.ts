// Storage for recorded voice-over (plan 2026-11-02 §6.1, §8), in memory and on Postgres: take columns on media,
// media_refs, narration_locks, versions.narration and versions.captions, and the voice-over settings.
import { describe, expect, it } from 'vitest'
import { getSettings, resetSettingsCache } from '../server/domain/settings.js'
import {
  NARRATION_SETTING_DEFAULTS,
  type MediaRefRow,
  type VersionCaptions,
  type VersionNarration,
} from '../server/domain/types.js'
import { createMemoryStore } from '../server/store/memory.js'
import type { Store } from '../server/store/types.js'
import { harness, pgStore, png, readyVideo, upload } from './helpers.js'

const stores: [string, () => Promise<Store>][] = [
  ['memory', async () => createMemoryStore()],
  ['postgres', pgStore],
]

const ref = (
  mediaId: string,
  ownerKind: MediaRefRow['ownerKind'],
  ownerId: string,
  at: string,
): MediaRefRow => ({
  mediaId,
  ownerKind,
  ownerId,
  jobId: 'job_1',
  createdAt: at,
})

describe.each(stores)('voice-over storage (%s)', (_name, make) => {
  it('keeps media refs per take and per owner, once each', async () => {
    const store = await make()
    await store.insertMediaRefs([
      ref('med_a', 'draft', 'edt_1', '2026-11-02T10:00:00.000Z'),
      ref('med_b', 'draft', 'edt_1', '2026-11-02T10:00:01.000Z'),
      ref('med_a', 'frozen_attempt', 'att_1', '2026-11-02T10:00:02.000Z'),
      ref('med_a', 'version', 'job_1#2', '2026-11-02T10:00:03.000Z'),
    ])
    // A repeat is a no-op, and keeps the first row.
    await store.insertMediaRefs([ref('med_a', 'draft', 'edt_1', '2026-11-02T11:00:00.000Z')])
    await store.insertMediaRefs([])

    expect(await store.listMediaRefsByMedia(['med_a'])).toEqual([
      ref('med_a', 'draft', 'edt_1', '2026-11-02T10:00:00.000Z'),
      ref('med_a', 'frozen_attempt', 'att_1', '2026-11-02T10:00:02.000Z'),
      ref('med_a', 'version', 'job_1#2', '2026-11-02T10:00:03.000Z'),
    ])
    expect((await store.listMediaRefsByOwner('draft', 'edt_1')).map((r) => r.mediaId)).toEqual([
      'med_a',
      'med_b',
    ])
    expect(await store.listMediaRefsByMedia([])).toEqual([])

    expect(await store.deleteMediaRefs('draft', 'edt_1', ['med_b'])).toBe(1)
    expect(await store.deleteMediaRefs('draft', 'edt_1', [])).toBe(0)
    expect((await store.listMediaRefsByOwner('draft', 'edt_1')).map((r) => r.mediaId)).toEqual(['med_a'])
    expect(await store.deleteMediaRefs('frozen_attempt', 'att_1')).toBe(1)
    expect(await store.deleteMediaRefs('draft', 'edt_1')).toBe(1)
    expect(await store.listMediaRefsByMedia(['med_a', 'med_b'])).toEqual([
      ref('med_a', 'version', 'job_1#2', '2026-11-02T10:00:03.000Z'),
    ])
  })

  it('takes, replaces and releases a narration lock', async () => {
    const store = await make()
    expect(await store.getNarrationLock('job_1')).toBeNull()
    const lock = {
      jobId: 'job_1',
      holderId: 'u_member',
      draftId: 'edt_1',
      acquiredAt: '2026-11-02T10:00:00.000Z',
      heartbeatAt: '2026-11-02T10:00:00.000Z',
    }
    await store.upsertNarrationLock(lock)
    expect(await store.getNarrationLock('job_1')).toEqual(lock)
    await store.upsertNarrationLock({ ...lock, heartbeatAt: '2026-11-02T10:01:00.000Z' })
    expect((await store.getNarrationLock('job_1'))?.heartbeatAt).toBe('2026-11-02T10:01:00.000Z')
    const takeover = {
      ...lock,
      holderId: 'u_admin',
      draftId: 'edt_2',
      acquiredAt: '2026-11-02T10:05:00.000Z',
    }
    await store.upsertNarrationLock(takeover)
    expect(await store.getNarrationLock('job_1')).toEqual(takeover)
    await store.deleteNarrationLock('job_1')
    expect(await store.getNarrationLock('job_1')).toBeNull()
    await store.deleteNarrationLock('job_1')
  })

  it('round-trips versions.narration and versions.captions and the take columns on media', async () => {
    const h = harness({}, { store: await make() })
    const videoId = await readyVideo(h)
    const v = await h.deps.store.getVersion(videoId, 1)
    expect(v?.narration ?? null).toBeNull()
    expect(v?.captions ?? null).toBeNull()

    const narration: VersionNarration = {
      op: { op: 'narration', schema: 1, sampleRate: 24000, clips: [] },
      recipe: { pipeline: 1, ffmpegVersion: '7.1', settings: { cleanup: 'off' } },
      bus: { key: `videos/${videoId}/v1/narration-bus.wav`, sha256: 'a'.repeat(64), samples: 240000 },
    }
    const captions: VersionCaptions = {
      status: 'ok',
      policy: 'sidecar',
      rev: 2,
      files: { vtt: 'captions.r2.vtt', transcript: 'transcript.r2.txt' },
      sha256: { vtt: 'b'.repeat(64), transcript: 'c'.repeat(64) },
      generation: 3,
    }
    await h.deps.store.updateVersion(videoId, 1, { narration, captions })
    expect(await h.deps.store.getVersion(videoId, 1)).toMatchObject({ narration, captions })
    await h.deps.store.updateVersion(videoId, 1, { captions: { ...captions, status: 'failed', rev: 3 } })
    expect((await h.deps.store.getVersion(videoId, 1))?.captions).toMatchObject({ status: 'failed', rev: 3 })

    const m = await h.json<{ id: string }>(await upload(h, h.member, png()))
    expect(await h.deps.store.getMedia(m.id)).toMatchObject({
      role: null,
      scopeJobId: null,
      retainUntil: null,
      deletingAt: null,
    })
    await h.deps.store.updateMedia(m.id, {
      role: 'narration-take',
      scopeJobId: videoId,
      retainUntil: '2026-12-02T10:00:00.000Z',
    })
    expect(await h.deps.store.getMedia(m.id)).toMatchObject({
      role: 'narration-take',
      scopeJobId: videoId,
      retainUntil: '2026-12-02T10:00:00.000Z',
      deletingAt: null,
    })
    await h.deps.store.updateMedia(m.id, { deletingAt: '2026-12-03T00:00:00.000Z' })
    expect((await h.deps.store.getMedia(m.id))?.deletingAt).toBe('2026-12-03T00:00:00.000Z')
  })

  it('gives new settings the voice-over defaults, and keeps changes', async () => {
    resetSettingsCache()
    const h = harness({}, { store: await make() })
    resetSettingsCache()
    await getSettings(h.deps)
    expect(await h.deps.store.getSettings()).toMatchObject(NARRATION_SETTING_DEFAULTS)
    await h.deps.store.updateSettings({
      narrationEnabled: false,
      transcriptionProvider: 'off',
      takeQuotaBytes: 1024,
    })
    expect(await h.deps.store.getSettings()).toMatchObject({
      narrationEnabled: false,
      transcriptionProvider: 'off',
      takeQuotaBytes: 1024,
    })
    resetSettingsCache()
  })
})
