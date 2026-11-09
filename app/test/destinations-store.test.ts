// Publish destinations, the store (docs/plans/2026-11-04-publish-destinations.md §2.3-§2.4): the partial unique key,
// the fenced lease, fenced commits, due rows, and the one-time secret's atomic consume, on memory and Postgres.
import { describe, expect, it } from 'vitest'
import type { DestinationPublicationRow } from '../server/domain/types.js'
import { createMemoryStore } from '../server/store/memory.js'
import type { Store } from '../server/store/types.js'
import { pgStore } from './helpers.js'

const T0 = '2026-11-05T10:00:00.000Z'
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString()

export function dpub(over: Partial<DestinationPublicationRow> = {}): DestinationPublicationRow {
  return {
    id: 'dpub_1',
    jobId: 'vid_1',
    versionN: 1,
    kind: 'http',
    destinationId: 'dst_1',
    destinationRevision: 1,
    connectionId: null,
    targetKey: 'site-a',
    target: null,
    options: {},
    instructions: null,
    desired: 'published',
    status: 'queued',
    generation: 1,
    operation: 'publish',
    manifest: { v: 1 },
    stateEnc: null,
    externalId: null,
    url: null,
    message: null,
    warnings: null,
    error: null,
    attempts: 0,
    nextRunAt: T0,
    deadlineAt: at(24 * 60),
    leaseUntil: null,
    leaseFence: 0,
    secretOnceEnc: null,
    secretOnceLabel: null,
    secretOnceIssuedAt: null,
    secretOnceExpiresAt: null,
    secretOnceConsumedAt: null,
    publishedBy: 'u_member',
    createdAt: T0,
    updatedAt: T0,
    liveAt: null,
    removedAt: null,
    ...over,
  }
}

async function scenario(store: Store) {
  // The unique key: one active publication per (job, version, kind, destination, target key).
  await store.insertDestinationPublication(dpub())
  await expect(store.insertDestinationPublication(dpub({ id: 'dpub_2' }))).rejects.toMatchObject({
    code: 'conflict',
  })
  await store.insertDestinationPublication(dpub({ id: 'dpub_3', targetKey: 'site-b' })) // another target: fine
  // YouTube rows have no destination id; coalesce makes two of them on the same channel collide.
  await store.insertDestinationPublication(
    dpub({ id: 'dpub_y1', kind: 'youtube', destinationId: null, targetKey: 'UC1' }),
  )
  await expect(
    store.insertDestinationPublication(
      dpub({ id: 'dpub_y2', kind: 'youtube', destinationId: null, targetKey: 'UC1' }),
    ),
  ).rejects.toMatchObject({ code: 'conflict' })
  expect(
    (
      await store.findActiveDestinationPublication({
        jobId: 'vid_1',
        versionN: 1,
        kind: 'youtube',
        destinationId: null,
        targetKey: 'UC1',
      })
    )?.id,
  ).toBe('dpub_y1')
  // Once removed, the key is free again.
  await store.updateDestinationPublication('dpub_1', { desired: 'removed', status: 'removed' })
  await store.insertDestinationPublication(dpub({ id: 'dpub_4' }))
  expect((await store.listDestinationPublications('vid_1')).map((p) => p.id)).toEqual([
    'dpub_1',
    'dpub_3',
    'dpub_4',
    'dpub_y1',
  ])

  // The fenced lease: one claim at a time; each claim bumps the fence.
  const a = await store.claimDestinationPublication('dpub_4', T0, at(2))
  expect(a?.leaseFence).toBe(1)
  expect(await store.claimDestinationPublication('dpub_4', at(1), at(3))).toBeNull()
  const b = await store.claimDestinationPublication('dpub_4', at(2), at(4)) // a's lease expired
  expect(b?.leaseFence).toBe(2)
  // A commits with its stale fence: refused. B's commit lands.
  const fence = (f: number) => ({ fence: f, generation: 1, desired: 'published' as const })
  expect(await store.commitDestinationPublication('dpub_4', fence(1), { status: 'live' })).toBe(false)
  expect(await store.commitDestinationPublication('dpub_4', fence(2), { status: 'running' })).toBe(true)
  // A newer generation or a changed desired also refuses the commit.
  await store.updateDestinationPublication('dpub_4', { generation: 2 })
  expect(await store.commitDestinationPublication('dpub_4', fence(2), { status: 'live' })).toBe(false)
  await store.updateDestinationPublication('dpub_4', { generation: 1, desired: 'removed' })
  expect(await store.commitDestinationPublication('dpub_4', fence(2), { status: 'live' })).toBe(false)
  expect((await store.getDestinationPublication('dpub_4'))?.status).toBe('running')

  // Due rows: due and unleased, or past their deadline (a callback-only waiting row has no next_run_at).
  await store.insertDestinationPublication(
    dpub({ id: 'dpub_w', targetKey: 'w', status: 'waiting', nextRunAt: null, deadlineAt: at(30) }),
  )
  await store.insertDestinationPublication(
    dpub({ id: 'dpub_l', targetKey: 'l', status: 'live', nextRunAt: T0 }),
  )
  const due = async (min: number) =>
    (await store.listDueDestinationPublications(at(min), 50)).map((p) => p.id).sort()
  expect(await due(0)).toEqual(['dpub_3', 'dpub_y1']) // dpub_4 is leased until +4; dpub_l is live; dpub_w isn't due
  expect(await due(31)).toEqual(['dpub_3', 'dpub_4', 'dpub_w', 'dpub_y1'])

  // One-time secrets: one consume wins, only for the publisher, only before expiry; then gone.
  await store.updateDestinationPublication('dpub_3', {
    secretOnceEnc: 'enc:pw',
    secretOnceLabel: 'Site password',
    secretOnceIssuedAt: T0,
    secretOnceExpiresAt: at(24 * 60),
  })
  expect(await store.consumeSecretOnce('dpub_3', 'u_other', at(1))).toBeNull()
  const both = await Promise.all([
    store.consumeSecretOnce('dpub_3', 'u_member', at(1)),
    store.consumeSecretOnce('dpub_3', 'u_member', at(1)),
  ])
  expect(both.filter(Boolean)).toEqual([{ label: 'Site password', valueEnc: 'enc:pw' }])
  expect(await store.consumeSecretOnce('dpub_3', 'u_member', at(2))).toBeNull()
  const after = await store.getDestinationPublication('dpub_3')
  expect(after?.secretOnceEnc).toBeNull()
  expect(after?.secretOnceConsumedAt).toBe(at(1))
  // An expired secret can't be consumed and is listed for the sweep to clear.
  await store.updateDestinationPublication('dpub_l', {
    secretOnceEnc: 'enc:x',
    secretOnceLabel: 'x',
    secretOnceIssuedAt: T0,
    secretOnceExpiresAt: at(10),
  })
  expect(await store.consumeSecretOnce('dpub_l', 'u_member', at(11))).toBeNull()
  expect((await store.listExpiredSecrets(at(11), 10)).map((p) => p.id)).toEqual(['dpub_l'])

  // Destinations and connections.
  await store.insertDestination({
    id: 'dst_1',
    name: 'Example',
    enabled: true,
    url: 'https://receiver.example.com/hook',
    secretEnc: 'enc',
    optionsSchema: null,
    capabilities: { targets: true, targetNoun: 'site' },
    sharePublisherContact: false,
    revision: 1,
    createdBy: 'u_admin',
    createdAt: T0,
    updatedAt: T0,
  })
  await store.updateDestination('dst_1', { enabled: false, revision: 2 })
  expect(await store.getDestination('dst_1')).toMatchObject({
    enabled: false,
    revision: 2,
    capabilities: { targets: true },
  })
  expect((await store.listDestinationPublicationsFor('dst_1')).length).toBeGreaterThan(0)
  const conn = {
    id: 'dcon_1',
    userId: 'u_member',
    kind: 'youtube' as const,
    accountId: 'UC1',
    accountLabel: 'Mia',
    tokenEnc: 'enc:rt',
    scopes: ['https://www.googleapis.com/auth/youtube.force-ssl'],
    status: 'ok' as const,
    createdAt: T0,
    updatedAt: T0,
    revokedAt: null,
  }
  await store.putDestinationConnection(conn)
  await store.putDestinationConnection({ ...conn, id: 'dcon_2', accountId: 'UC2' }) // replaces
  expect((await store.listUserConnections('u_member')).map((c) => c.id)).toEqual(['dcon_2'])
  expect((await store.getUserConnection('u_member', 'youtube'))?.scopes).toEqual(conn.scopes)
  await store.deleteDestinationConnection('dcon_2')
  expect(await store.getUserConnection('u_member', 'youtube')).toBeNull()
  await store.deleteDestination('dst_1')
  expect(await store.listDestinations()).toEqual([])
}

describe('destination store', () => {
  it('memory', async () => {
    await scenario(createMemoryStore())
  })
  it('Postgres', async () => {
    await scenario(await pgStore())
  })
  it('Postgres: two concurrent claims, one winner', async () => {
    const store = await pgStore()
    await store.insertDestinationPublication(dpub())
    const won = await Promise.all([
      store.claimDestinationPublication('dpub_1', T0, at(2)),
      store.claimDestinationPublication('dpub_1', T0, at(2)),
      store.claimDestinationPublication('dpub_1', T0, at(2)),
    ])
    expect(won.filter(Boolean)).toHaveLength(1)
  })
})
