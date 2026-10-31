// Webhook outbox v2 (plan v2 §3, §14 rules 10–11): events with one delivery per destination, own secrets,
// send-time access checks.
import { readdirSync, readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { describe, expect, it } from 'vitest'
import * as schema from '../db/schema.js'
import { encrypt, webhookSignature } from '../src/lib/crypto.js'
import { getSettings } from '../src/domain/settings.js'
import { deliverWebhooks } from '../src/domain/webhooks.js'
import { createDrizzleStore } from '../src/store/drizzle.js'
import { harness, type Harness } from './helpers.js'

const PROMPT = 'A short launch video for org webhooks, with three beats and an end card.'
const MIGRATIONS = new URL('../netlify/database/migrations/', import.meta.url)

async function pgClient(upTo?: string) {
  const pg = new PGlite()
  for (const m of readdirSync(MIGRATIONS).sort()) {
    if (upTo && m >= upTo) break
    const sql = readFileSync(new URL(`${m}/migration.sql`, MIGRATIONS), 'utf8')
    for (const stmt of sql.split('--> statement-breakpoint')) if (stmt.trim()) await pg.exec(stmt)
  }
  return pg
}

async function setPersonal(h: Harness, userId: string, url: string, secret: string) {
  const { dataEncryptionKey } = await getSettings(h.deps)
  const now = h.deps.clock.now().toISOString()
  await h.deps.store.putUserWebhook({
    userId,
    url,
    secretEnc: encrypt(dataEncryptionKey, secret),
    createdAt: now,
    updatedAt: now,
  })
}

async function setTeam(h: Harness, url: string, secret: string) {
  const { dataEncryptionKey } = await getSettings(h.deps)
  await h.deps.store.updateSettings({
    teamWebhookUrl: url,
    teamWebhookSecretEnc: encrypt(dataEncryptionKey, secret),
  })
}

const deliver = (h: Harness) => deliverWebhooks(h.deps, { deadline: Date.now() + 5000, maxItems: 20 })

function signedBy(call: { body: string; headers: Record<string, string> } | undefined, secret: string) {
  const sig = call?.headers['x-video-agent-signature'] ?? ''
  const t = Number(/t=(\d+)/.exec(sig)?.[1])
  return sig === webhookSignature(secret, call?.body ?? '', t)
}

describe('webhook outbox', () => {
  it('fans out to the per-video, personal and team webhooks, each signed with its own secret', async () => {
    const h = harness()
    await h.call('GET', '/api/v1/me', { as: h.member })
    await setPersonal(h, 'u_member', 'https://me.example.com/hook', 'personal-secret')
    await setTeam(h, 'https://team.example.com/hook', 'team-secret')
    const key = await h.json(await h.call('POST', '/api/v1/keys', { as: h.member, body: { name: 'ci' } }))
    await h.call('POST', '/api/v1/videos', {
      key: key.key,
      origin: null,
      body: { prompt: PROMPT, webhookUrl: 'https://ci.example.com/hook' },
    })
    await h.drive(4)
    expect(await deliver(h)).toBe(3)
    const byUrl = Object.fromEntries(h.deps.http.calls.map((c) => [c.url, c]))
    expect(signedBy(byUrl['https://ci.example.com/hook'], key.webhookSecret)).toBe(true)
    expect(signedBy(byUrl['https://me.example.com/hook'], 'personal-secret')).toBe(true)
    expect(signedBy(byUrl['https://team.example.com/hook'], 'team-secret')).toBe(true)
    const events = new Set(h.deps.http.calls.map((c) => JSON.parse(c.body).eventId))
    expect(events.size).toBe(1)
    // Delivered once: another sweep sends nothing.
    expect(await deliver(h)).toBe(0)
  })

  it('videos made in the web app emit events too (no API key needed)', async () => {
    const h = harness()
    await h.call('GET', '/api/v1/me', { as: h.member })
    await setPersonal(h, 'u_member', 'https://me.example.com/hook', 's')
    await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } })
    await h.drive(4)
    expect(await deliver(h)).toBe(1)
    expect(JSON.parse(h.deps.http.calls[0]?.body ?? '{}').event).toBe('video.ready')
  })

  it('a delivery is dropped when its recipient loses access before it is sent', async () => {
    const h = harness()
    const bob = h.deps.identity.addUser({ id: 'u_bob', email: 'bob@acme.com', name: 'Bob' }).cookie
    const video = await h.json(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
    )
    await h.drive(4)
    // Bob revises Alice's (Mia's) video through his API key with a webhook; Mia also has a personal webhook.
    await setPersonal(h, 'u_member', 'https://mia.example.com/hook', 's')
    const key = await h.json(await h.call('POST', '/api/v1/keys', { as: bob, body: { name: 'ci' } }))
    const rev = await h.call('POST', `/api/v1/videos/${video.id}/versions`, {
      key: key.key,
      origin: null,
      body: { prompt: 'Make the end card orange', webhookUrl: 'https://bob.example.com/hook' },
    })
    expect(rev.status).toBe(202)
    await deliver(h) // the v1 event for Mia
    h.deps.http.calls.length = 0
    await h.drive(4)
    // Before delivery: Mia makes the video private (Bob loses access) and transfers it away (Mia isn't owner).
    await h.call('PATCH', `/api/v1/videos/${video.id}`, { as: h.member, body: { private: true } })
    await h.deps.store.updateJob(video.id, { ownerId: 'u_admin' })
    expect(await deliver(h)).toBe(0)
    expect(h.deps.http.calls).toHaveLength(0)
    expect(h.deps.logs.join('\n')).toMatch(/recipient lost access/)
    expect(h.deps.logs.join('\n')).toMatch(/no longer the owner/)
  })

  it('the team webhook receives private videos in full', async () => {
    const h = harness()
    await setTeam(h, 'https://team.example.com/hook', 't')
    const video = await h.json(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
    )
    await h.call('PATCH', `/api/v1/videos/${video.id}`, { as: h.member, body: { private: true } })
    await h.drive(4)
    expect(await deliver(h)).toBe(1)
    const body = JSON.parse(h.deps.http.calls[0]?.body ?? '{}')
    expect(body.video.private).toBe(true)
    expect(body.video.versions[0].prompt).toBe(PROMPT)
  })

  it('claims are leased, so two sweeps never send the same delivery', async () => {
    const h = harness()
    await setTeam(h, 'https://team.example.com/hook', 't')
    await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } })
    await h.drive(4)
    const now = h.deps.clock.now()
    const lease = new Date(now.getTime() + 60_000).toISOString()
    const first = await h.deps.store.claimDueWebhookDeliveries(now.toISOString(), lease, 10)
    const second = await h.deps.store.claimDueWebhookDeliveries(now.toISOString(), lease, 10)
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
    // A duplicate (event, destination) is ignored.
    await h.deps.store.insertWebhookDelivery({ ...(first[0] as NonNullable<(typeof first)[0]>), id: 'dup' })
    h.deps.clock.advance(120_000)
    expect(
      await h.deps.store.claimDueWebhookDeliveries(h.deps.clock.now().toISOString(), lease, 10),
    ).toHaveLength(1)
  })

  it('works on Postgres (SKIP LOCKED claim)', async () => {
    const pg = await pgClient()
    const h = harness({}, { store: createDrizzleStore(drizzle({ client: pg, schema })) })
    await h.call('GET', '/api/v1/me', { as: h.member })
    await setPersonal(h, 'u_member', 'https://me.example.com/hook', 's')
    await setTeam(h, 'https://team.example.com/hook', 't')
    await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } })
    await h.drive(4)
    expect(await deliver(h)).toBe(2)
    expect(await deliver(h)).toBe(0)
  })
})

describe('outbox migration', () => {
  it('moves pending deliveries from old events into delivery rows', async () => {
    const target = readdirSync(MIGRATIONS)
      .sort()
      .find((m) => m.endsWith('_webhook_deliveries')) as string
    const pg = await pgClient(target)
    await pg.query(
      `INSERT INTO webhook_events (event_id, job_id, version_n, attempt_id, type, payload, api_key_id, url,
         lease_until, next_retry_at, deliver_until, attempts, last_result, delivered_at)
       VALUES ('e1', 'vid_1', 1, 'a1', 'video.ready', '{}', 'k1', 'https://x.example.com', null,
         '2026-10-30T00:00:00.000Z', '2026-10-31T00:00:00.000Z', 2, 'HTTP 500', null)`,
    )
    for (const m of readdirSync(MIGRATIONS)
      .sort()
      .filter((m) => m >= target)) {
      const sql = readFileSync(new URL(`${m}/migration.sql`, MIGRATIONS), 'utf8')
      for (const stmt of sql.split('--> statement-breakpoint')) if (stmt.trim()) await pg.exec(stmt)
    }
    const d = await pg.query<Record<string, unknown>>('SELECT * FROM webhook_deliveries')
    expect(d.rows).toEqual([
      expect.objectContaining({
        event_id: 'e1',
        dest_kind: 'version_key',
        dest_ref: 'k1',
        url: 'https://x.example.com',
        attempts: 2,
        next_retry_at: '2026-10-30T00:00:00.000Z',
      }),
    ])
    const e = await pg.query<Record<string, unknown>>('SELECT created_at FROM webhook_events')
    expect(e.rows[0]?.created_at).toBe('2026-10-30T00:00:00.000Z')
  })
})
