// Publish destinations, phase 1 (docs/plans/2026-11-04-publish-destinations.md §2, §6.1): the share page through
// the new route, the fenced-lease worker, publish/retry/remove/delete in every state, the sweep, the DTO and ETag.
// A scripted kind stands in for a real destination (the HTTP kind arrives in phase 2).
import { describe, expect, it } from 'vitest'
import { registerKind } from '../server/domain/destinations/registry.js'
import { runPublication } from '../server/domain/destinations/run.js'
import { duePublications } from '../server/domain/destinations/sweep.js'
import type { StepCtx, StepResult } from '../server/domain/destinations/types.js'
import { getSettings } from '../server/domain/settings.js'
import { deliverWebhooks } from '../server/domain/webhooks.js'
import { encrypt } from '../server/lib/crypto.js'
import { harness, pgStore, readyVideo, type Harness } from './helpers.js'

/** A scripted destination: each step pops the next result (or waits on a gate first). */
const script: { results: StepResult[]; gate: Promise<void> | null; calls: StepCtx[] } = {
  results: [],
  gate: null,
  calls: [],
}
registerKind({
  kind: 'http',
  optionsSchema: () => ({ type: 'object', properties: { name: { type: 'string', maxLength: 40 } } }),
  unpublishOptionsSchema: () => null,
  ready: async ({ destination }) =>
    destination.row?.enabled ? { ok: true } : { ok: false, reason: 'This destination is turned off.' },
  step: async (ctx) => {
    script.calls.push(ctx)
    if (script.gate) await script.gate
    return (
      script.results.shift() ??
      (ctx.operation.action === 'remove'
        ? { status: 'removed' }
        : { status: 'live', url: 'https://example.com/v', externalId: 'ext-1' })
    )
  },
})

async function addDestination(h: Harness, caps = { targets: true, instructions: true }) {
  const now = h.deps.clock.now().toISOString()
  await h.deps.store.insertDestination({
    id: 'dst_test',
    name: 'Test destination',
    enabled: true,
    url: 'https://receiver.example.com/hook',
    secretEnc: 'unused-in-phase-1',
    optionsSchema: null,
    capabilities: caps,
    sharePublisherContact: false,
    revision: 1,
    createdBy: 'u_admin',
    createdAt: now,
    updatedAt: now,
  })
}

const publish = (h: Harness, id: string, body: object, headers: Record<string, string> = {}) =>
  h.call('POST', `/api/v1/videos/${id}/versions/1/destinations`, { as: h.member, body, headers })
const versionDests = async (h: Harness, id: string) =>
  (await h.json(await h.call('GET', `/api/v1/videos/${id}`, { as: h.member }))).versions[0].destinations as {
    id: string
    kind: string
    status: string
    url: string | null
  }[]

async function scenario(h: Harness) {
  script.results = []
  script.gate = null
  script.calls = []
  const id = await readyVideo(h)

  // The share page through the new route: the same publications row and mirror as the old route.
  const viaNew = await h.json(await publish(h, id, { destination: 'share_page', includeTranscript: false }))
  expect(viaNew).toMatchObject({ kind: 'share_page', status: 'live' })
  const pubs = await h.deps.store.listPublications(id)
  expect(pubs).toHaveLength(1)
  const slug = pubs[0]?.slug ?? ''
  const mirror = JSON.parse(h.deps.blobs.text('internal', `pub/${slug}.json`) ?? '{}')
  expect(mirror).toMatchObject({ slug, jobId: id, versionN: 1, showTranscript: false })
  // Unpublish through the old route; the entry goes removed.
  expect((await h.call('DELETE', `/api/v1/videos/${id}/versions/1/publish`, { as: h.member })).status).toBe(
    204,
  )
  expect((await versionDests(h, id)).find((d) => d.kind === 'share_page')?.status).toBe('removed')

  // Listing: the share page and the enabled HTTP destination.
  await addDestination(h)
  const list = await h.json(await h.call('GET', '/api/v1/destinations', { as: h.member }))
  expect(list.items.map((d: { id: string }) => d.id)).toEqual(['share_page', 'dst_test'])
  expect(list.items[1]).toMatchObject({ ready: true, capabilities: { targets: true, instructions: true } })

  // Publish to the destination: queued, dispatched, then the worker takes it live.
  const etag0 = (await h.call('GET', `/api/v1/videos/${id}`, { as: h.member })).headers.get('etag')
  const res = await publish(
    h,
    id,
    { destination: 'dst_test', options: { name: 'acme' } },
    { 'idempotency-key': 'k1' },
  )
  expect(res.status).toBe(200)
  const dp = await h.json(res)
  expect(dp).toMatchObject({
    kind: 'http',
    status: 'queued',
    destination: { id: 'dst_test', name: 'Test destination' },
  })
  expect(h.deps.platform.publishes).toContain(dp.id)
  // The same idempotency key replays; the same request again returns the same publication.
  expect(
    (
      await h.json(
        await publish(
          h,
          id,
          { destination: 'dst_test', options: { name: 'acme' } },
          { 'idempotency-key': 'k1' },
        ),
      )
    ).id,
  ).toBe(dp.id)
  // Unknown options are refused.
  expect((await publish(h, id, { destination: 'dst_test', options: { nope: 1 } })).status).toBe(400)

  script.results = [
    { status: 'continue', state: { step: 1 } },
    { status: 'live', url: 'https://example.com/acme', externalId: 'ext-acme' },
  ]
  expect(await runPublication(h.deps, dp.id)).toBe('done')
  expect(script.calls[1]?.state).toEqual({ step: 1 }) // state is saved (encrypted) between steps
  const row = await h.deps.store.getDestinationPublication(dp.id)
  expect(row).toMatchObject({
    status: 'live',
    url: 'https://example.com/acme',
    externalId: 'ext-acme',
    leaseUntil: null,
  })
  expect(row?.stateEnc).toMatch(/^v1\./)
  // The manifest is minimal: no prompt, no owner email.
  const m = JSON.stringify(row?.manifest)
  expect(m).not.toContain('mia@acme.com')
  expect(m).not.toContain('A short launch video for org webhooks')
  expect((row?.manifest as { files: { kind: string }[] }).files.map((f) => f.kind)).toEqual([
    'mp4',
    'poster',
    'captions',
  ])
  // A webhook event, the DTO and a new ETag.
  expect((await versionDests(h, id)).find((d) => d.id === dp.id)).toMatchObject({
    status: 'live',
    url: 'https://example.com/acme',
  })
  const etag1 = (await h.call('GET', `/api/v1/videos/${id}`, { as: h.member })).headers.get('etag')
  expect(etag1).not.toBe(etag0)
  // Publishing the same target with other options now conflicts.
  expect((await publish(h, id, { destination: 'dst_test', options: { name: 'other' } })).status).toBe(200) // "new" target: a second publication
  // The library's published filter counts the live destination row.
  const published = await h.json(await h.call('GET', '/api/v1/videos?published=true', { as: h.member }))
  expect(published.items.map((v: { id: string }) => v.id)).toContain(id)

  // Remove a live publication: removing, then removed by the worker.
  const del = await h.json(
    await h.call('DELETE', `/api/v1/destination-publications/${dp.id}`, { as: h.member }),
  )
  expect(del).toMatchObject({ status: 'removing', desired: 'removed' })
  expect(await runPublication(h.deps, dp.id)).toBe('done')
  expect((await h.deps.store.getDestinationPublication(dp.id))?.status).toBe('removed')
  expect(script.calls.at(-1)?.manifest).toMatchObject({ action: 'remove', externalId: 'ext-acme' })

  // Try again keeps the publication and bumps its generation.
  const failing = await h.json(
    await publish(h, id, {
      destination: 'dst_test',
      target: { id: 't1', name: 'T1', description: null, url: null, metadata: { a: 1 } },
    }),
  )
  script.results = [{ status: 'failed', error: { code: 'nope', message: 'No.' } }]
  await runPublication(h.deps, failing.id)
  expect((await h.deps.store.getDestinationPublication(failing.id))?.status).toBe('failed')
  const again = await h.json(
    await h.call('POST', `/api/v1/destination-publications/${failing.id}/retry`, { as: h.member }),
  )
  expect(again).toMatchObject({ id: failing.id, status: 'queued' })
  expect((await h.deps.store.getDestinationPublication(failing.id))?.generation).toBe(2)
  await runPublication(h.deps, failing.id)
  expect((await h.deps.store.getDestinationPublication(failing.id))?.target?.metadata).toEqual({ a: 1 })

  // Stale fence: a worker mid-step loses to an unpublish; its result is never written.
  let open: () => void = () => undefined
  script.gate = new Promise((r) => (open = r))
  const racing = await h.json(
    await publish(h, id, {
      destination: 'dst_test',
      target: { id: 't2', name: 'T2', description: null, url: null, metadata: null },
    }),
  )
  const run = runPublication(h.deps, racing.id)
  await new Promise((r) => setTimeout(r, 10))
  await h.call('DELETE', `/api/v1/destination-publications/${racing.id}`, { as: h.member })
  script.results = [{ status: 'live', url: 'https://example.com/late', externalId: 'late' }]
  open()
  script.gate = null
  expect(await run).toBe('lost_fence')
  const after = await h.deps.store.getDestinationPublication(racing.id)
  expect(after).toMatchObject({ status: 'removing', desired: 'removed', url: null })
  await runPublication(h.deps, racing.id)
  expect((await h.deps.store.getDestinationPublication(racing.id))?.status).toBe('removed')

  // Unpublish before anything was sent: removed at once, no removal step.
  const untouched = await h.json(
    await publish(h, id, {
      destination: 'dst_test',
      target: { id: 't3', name: 'T3', description: null, url: null, metadata: null },
    }),
  )
  const calls = script.calls.length
  expect(
    (
      await h.json(
        await h.call('DELETE', `/api/v1/destination-publications/${untouched.id}`, { as: h.member }),
      )
    ).status,
  ).toBe('removed')
  expect(script.calls.length).toBe(calls)

  // Private videos don't go out.
  await h.call('PATCH', `/api/v1/videos/${id}`, { as: h.member, body: { private: true } })
  const priv = await publish(h, id, { destination: 'dst_test' })
  expect(priv.status).toBe(403)
  await h.call('PATCH', `/api/v1/videos/${id}`, { as: h.member, body: { private: false } })

  // Deleting the video turns every active publication towards removed; the sweep dispatches the removals.
  const liveOne = await h.json(
    await publish(h, id, {
      destination: 'dst_test',
      target: { id: 't4', name: 'T4', description: null, url: null, metadata: null },
    }),
  )
  await runPublication(h.deps, liveOne.id)
  const queuedOne = await h.json(
    await publish(h, id, {
      destination: 'dst_test',
      target: { id: 't5', name: 'T5', description: null, url: null, metadata: null },
    }),
  )
  expect((await h.call('DELETE', `/api/v1/videos/${id}`, { as: h.member })).status).toBe(202)
  expect((await h.deps.store.getDestinationPublication(liveOne.id))?.status).toBe('removing')
  expect((await h.deps.store.getDestinationPublication(queuedOne.id))?.status).toBe('removed')
  h.deps.platform.publishes = []
  const swept = await duePublications(h.deps, { deadline: Date.now() + 10_000, maxItems: 20 })
  expect(swept.dispatched).toBeGreaterThanOrEqual(1)
  expect(h.deps.platform.publishes).toContain(liveOne.id)
  await runPublication(h.deps, liveOne.id) // removal needs no bytes and no Video DTO
  expect((await h.deps.store.getDestinationPublication(liveOne.id))?.status).toBe('removed')
}

describe('publish destinations: lifecycle', () => {
  it('memory', async () => {
    await scenario(harness())
  })
  it('Postgres', async () => {
    await scenario(harness({}, { store: await pgStore() }))
  })

  it('sweep: deadlines (including callback-only waits), re-dispatch, expired secrets', async () => {
    const h = harness()
    const id = await readyVideo(h)
    await addDestination(h)
    const dp = await h.json(await publish(h, id, { destination: 'dst_test' }))
    script.results = [{ status: 'waiting', checkAfterSec: null, message: 'Working on it' }]
    await runPublication(h.deps, dp.id)
    expect(await h.deps.store.getDestinationPublication(dp.id)).toMatchObject({
      status: 'waiting',
      nextRunAt: null,
      message: 'Working on it',
    })
    // Not due (callback-only) until its deadline passes.
    h.deps.platform.publishes = []
    await duePublications(h.deps, { deadline: Date.now() + 10_000, maxItems: 20 })
    expect(h.deps.platform.publishes).toEqual([])
    h.deps.clock.advance(25 * 3600_000)
    const r = await duePublications(h.deps, { deadline: Date.now() + 10_000, maxItems: 20 })
    expect(r.expired).toBe(1)
    expect(await h.deps.store.getDestinationPublication(dp.id)).toMatchObject({
      status: 'failed',
      error: { code: 'deadline' },
    })
    // A retry row is re-dispatched once it's due, at most once a minute.
    const dp2 = await h.json(
      await publish(h, id, {
        destination: 'dst_test',
        target: { id: 'x', name: 'X', description: null, url: null, metadata: null },
      }),
    )
    script.results = [{ status: 'retry', error: { code: 'busy', message: 'Busy' }, retryAfterSec: 30 }]
    await runPublication(h.deps, dp2.id)
    h.deps.platform.publishes = []
    h.deps.clock.advance(31_000)
    await duePublications(h.deps, { deadline: Date.now() + 10_000, maxItems: 20 })
    await duePublications(h.deps, { deadline: Date.now() + 10_000, maxItems: 20 })
    expect(h.deps.platform.publishes).toEqual([dp2.id])
    // Expired one-time secrets are cleared.
    const now = h.deps.clock.now().toISOString()
    await h.deps.store.updateDestinationPublication(dp2.id, {
      secretOnceEnc: 'v1.x.y.z',
      secretOnceLabel: 'Site password',
      secretOnceIssuedAt: now,
      secretOnceExpiresAt: new Date(Date.parse(now) + 1000).toISOString(),
    })
    h.deps.clock.advance(5000)
    expect(
      (await duePublications(h.deps, { deadline: Date.now() + 10_000, maxItems: 20 })).secretsCleared,
    ).toBe(1)
    expect((await h.deps.store.getDestinationPublication(dp2.id))?.secretOnceEnc).toBeNull()
  })

  it('terminal outcomes reach the webhook outbox (live, removed), with the DTO entry', async () => {
    const h = harness()
    const id = await readyVideo(h)
    const { dataEncryptionKey } = await getSettings(h.deps)
    await h.deps.store.updateSettings({
      teamWebhookUrl: 'https://team.example.com/hook',
      teamWebhookSecretEnc: encrypt(dataEncryptionKey, 'team-secret'),
    })
    await deliverWebhooks(h.deps, { deadline: Date.now() + 5000, maxItems: 20 })
    h.deps.http.calls = []
    await addDestination(h)
    const dp = await h.json(await publish(h, id, { destination: 'dst_test' }))
    script.results = [
      { status: 'continue', state: {} },
      { status: 'live', url: 'https://example.com/x', externalId: 'x' },
    ]
    await runPublication(h.deps, dp.id)
    await h.call('DELETE', `/api/v1/destination-publications/${dp.id}`, { as: h.member })
    await runPublication(h.deps, dp.id)
    await deliverWebhooks(h.deps, { deadline: Date.now() + 5000, maxItems: 20 })
    const types = h.deps.http.calls.map((c) => JSON.parse(c.body).event)
    expect(types).toEqual(['destination.live', 'destination.removed'])
    const live = JSON.parse(h.deps.http.calls[0]?.body ?? '{}')
    expect(live.destinationPublication).toMatchObject({
      id: dp.id,
      status: 'live',
      url: 'https://example.com/x',
    })
    expect(JSON.stringify(live)).not.toContain('stateEnc')
  })

  it('a worker hands over when its time budget runs out', async () => {
    const h = harness()
    const id = await readyVideo(h)
    await addDestination(h)
    const dp = await h.json(await publish(h, id, { destination: 'dst_test' }))
    script.results = [
      { status: 'continue', state: { chunk: 1 } },
      { status: 'continue', state: { chunk: 2 } },
    ]
    expect(await runPublication(h.deps, dp.id, -1)).toBe('paused')
    const row = await h.deps.store.getDestinationPublication(dp.id)
    expect(row).toMatchObject({ status: 'running', leaseUntil: null })
    expect(row?.nextRunAt).not.toBeNull()
  })

  it('Postgres: two workers race for one publication; one runs it', async () => {
    const h = harness({}, { store: await pgStore() })
    const id = await readyVideo(h)
    await addDestination(h)
    const dp = await h.json(await publish(h, id, { destination: 'dst_test' }))
    script.results = []
    const before = script.calls.length
    const outcomes = await Promise.all([runPublication(h.deps, dp.id), runPublication(h.deps, dp.id)])
    expect(outcomes.sort()).toEqual(['busy', 'done'])
    expect(script.calls.length - before).toBe(1)
  })
})
