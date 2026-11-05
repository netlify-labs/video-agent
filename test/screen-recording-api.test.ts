// What clients see of screen recordings (screen-recording plan §6; va-rsk5.2.10): `screen_recording` in
// GET /api/v1/config features only once the whole API is in (screenRecordingApi.ready); the media DTO's top-level
// `role` and `hasTrace` (the take-only `recording` field unchanged); MCP list_media's role and has_trace, and its role
// filter. One JSON line per assertion group.
import { afterEach, describe, expect, it } from 'vitest'
import { screenRecordingApi } from '../src/domain/features.js'
import { NO_PROVENANCE, type MediaRow } from '../src/domain/types.js'
import { apiKey, harness, mcpCall, type Harness } from './helpers.js'

const log = (fields: Record<string, unknown>) => console.log(JSON.stringify(fields))

async function item(h: Harness, id: string, over: Partial<MediaRow>) {
  const at = h.deps.clock.now().toISOString()
  await h.deps.store.insertMedia({
    id,
    uploaderId: 'u_member',
    kind: 'video',
    status: 'ready',
    rejectReason: null,
    filename: `${id}.mp4`,
    title: `screen ${id}`,
    caption: null,
    mime: 'video/mp4',
    ext: 'mp4',
    bytes: 1000,
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
    role: null,
    scopeJobId: null,
    retainUntil: null,
    deletingAt: null,
    ...NO_PROVENANCE,
    ...over,
  })
}

describe('screen recordings in the API', () => {
  afterEach(() => {
    screenRecordingApi.ready = false
  })

  it('lists screen_recording in features only when the whole API is in', async () => {
    const h = harness()
    const features = async () =>
      (await h.json<{ features: string[] }>(await h.call('GET', '/api/v1/config'))).features
    expect(await features()).not.toContain('screen_recording')
    screenRecordingApi.ready = true
    expect(await features()).toContain('screen_recording')
    log({ test: 'features', ok: true })
  })

  it('the media DTO shows role and hasTrace; a take keeps its recording field', async () => {
    const h = harness()
    await item(h, 'med_clip', {})
    await item(h, 'med_take', { kind: 'audio', role: 'narration-take', mime: 'audio/wav', ext: 'wav' })
    await item(h, 'med_screen', {
      role: 'screen-recording',
      traceKey: 'med_screen/trace.json',
      traceSha256: 'b'.repeat(64),
    })
    const dto = async (id: string) =>
      h.json<{ role: string | null; hasTrace: boolean; recording: unknown }>(
        await h.call('GET', `/api/v1/media/${id}`, { as: h.member }),
      )
    expect(await dto('med_clip')).toMatchObject({ role: null, hasTrace: false, recording: null })
    const take = await dto('med_take')
    expect(take).toMatchObject({ role: 'narration-take', hasTrace: false })
    expect(take.recording).toMatchObject({ role: 'narration-take' })
    expect(await dto('med_screen')).toMatchObject({
      role: 'screen-recording',
      hasTrace: true,
      recording: null,
    })
    log({ test: 'dto', ok: true })
  })

  it('MCP list_media shows role and has_trace, and filters by role', async () => {
    const h = harness()
    await item(h, 'med_clip', {})
    await item(h, 'med_screen', {
      role: 'screen-recording',
      traceKey: 'med_screen/trace.json',
      traceSha256: 'b'.repeat(64),
    })
    const key = await apiKey(h, h.member)
    const list = async (args: Record<string, unknown>) =>
      (await mcpCall(h, key, 'tools/call', { name: 'list_media', arguments: args })).structuredContent
        .media as {
        id: string
        role: string | null
        has_trace: boolean
      }[]
    const all = await list({ query: 'screen' })
    expect(all).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'med_clip', role: null, has_trace: false }),
        expect.objectContaining({ id: 'med_screen', role: 'screen-recording', has_trace: true }),
      ]),
    )
    expect((await list({ query: 'screen', role: 'screen-recording' })).map((m) => m.id)).toEqual([
      'med_screen',
    ])
    log({ test: 'mcp list_media', ok: true })
  })
})
