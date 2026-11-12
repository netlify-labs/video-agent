// What the Publish dialog leans on (2026-11-11): a private video is shared with the team in the publish request
// itself, a password the publisher chooses reaches the receiver but is encrypted at rest, an option behind a switch
// counts only while the switch is on, and capabilities refresh on their own (no manual Test).
import { describe, expect, it } from 'vitest'
import { refreshCapabilities } from '../server/domain/destinations/admin.js'
import { runPublication } from '../server/domain/destinations/run.js'
import { parseOptionsSchema, validateOptions } from '../server/lib/options-schema.js'
import { harness, readyVideo, type Harness } from './helpers.js'

const FORM = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Site name', maxLength: 40 },
    password: { type: 'boolean', title: 'Password-protect the site', default: false },
    sitePassword: {
      type: 'string',
      format: 'password',
      showIf: 'password',
      title: 'Password',
      minLength: 8,
      maxLength: 64,
    },
  },
}

async function setup(h: Harness) {
  const res = await h.call('POST', '/api/v1/admin/destinations', {
    as: h.admin,
    body: { name: 'Sites', url: 'https://receiver.example.com/hook', optionsSchema: FORM },
  })
  expect(res.status).toBe(201)
  return h.json<{ id: string }>(res)
}

/** A receiver that answers every event and keeps what it was sent (signatures are covered elsewhere). */
function receiver(h: Harness, capabilities: object | null = { targets: true, instructions: true }) {
  const seen: { event: string; body: Record<string, any> }[] = []
  h.deps.http.receiver = ({ body, headers }) => {
    const event = headers['x-video-agent-event'] ?? ''
    seen.push({ event, body: JSON.parse(body) })
    if (event === 'ping' && capabilities === null) return new Error('timeout')
    return {
      status: event === 'publish' ? 202 : 200,
      body: JSON.stringify(event === 'ping' ? { capabilities } : { status: 'accepted' }),
      headers: { contentType: 'application/json', retryAfter: null },
    }
  }
  return seen
}

const publish = (h: Harness, id: string, body: object) =>
  h.call('POST', `/api/v1/videos/${id}/versions/1/destinations`, { as: h.member, body })
const isPrivate = async (h: Harness, id: string) =>
  (await h.json(await h.call('GET', `/api/v1/videos/${id}`, { as: h.member }))).private as boolean

describe('the Publish dialog', () => {
  it('a private video is shared with the team by the publish request, only when it asks', async () => {
    const h = harness()
    const id = await readyVideo(h)
    const dest = await setup(h)
    receiver(h)
    await h.call('PATCH', `/api/v1/videos/${id}`, { as: h.member, body: { private: true } })
    // Without the flag: refused as before, and still private.
    const refused = await publish(h, id, { destination: dest.id })
    expect(refused.status).toBe(403)
    expect(await isPrivate(h, id)).toBe(true)
    // With it, a request that fails its own checks changes nothing either.
    const bad = await publish(h, id, { destination: dest.id, makeVisible: true, options: { nope: 1 } })
    expect(bad.status).toBe(400)
    expect(await isPrivate(h, id)).toBe(true)
    // With it: published, and visible to the team.
    const ok = await publish(h, id, { destination: dest.id, makeVisible: true, options: { name: 'acme' } })
    expect(ok.status).toBe(200)
    expect(await isPrivate(h, id)).toBe(false)
  })

  it('a chosen password reaches the receiver, and is encrypted at rest', async () => {
    const h = harness()
    const id = await readyVideo(h)
    const dest = await setup(h)
    const seen = receiver(h)
    const short = await publish(h, id, {
      destination: dest.id,
      options: { name: 'acme', password: true, sitePassword: 'short' },
    })
    expect(short.status).toBe(400)
    expect((await h.json(short)).error.message).toContain('at least 8 characters')
    const res = await publish(h, id, {
      destination: dest.id,
      options: { name: 'acme', password: true, sitePassword: 'correct-horse-9' },
    })
    expect(res.status).toBe(200)
    const dp = await h.json(res)
    const row = await h.deps.store.getDestinationPublication(dp.id)
    expect(JSON.stringify(row)).not.toContain('correct-horse-9')
    expect(row?.options).toMatchObject({ name: 'acme', password: true })
    expect(JSON.stringify(dp)).not.toContain('correct-horse-9')
    await runPublication(h.deps, dp.id)
    expect(seen.find((s) => s.event === 'publish')?.body.options).toEqual({
      name: 'acme',
      password: true,
      sitePassword: 'correct-horse-9',
    })
  })

  it('an option behind a switch counts only while the switch is on', () => {
    const p = parseOptionsSchema(FORM)
    if (!p.ok) throw new Error(p.error)
    expect(validateOptions(p.value, { name: 'a', sitePassword: 'x' })).toEqual({
      ok: true,
      value: { name: 'a', password: false },
    })
    expect(validateOptions(p.value, { password: true })).toEqual({ ok: true, value: { password: true } })
    expect(
      parseOptionsSchema({ type: 'object', properties: { a: { type: 'string', showIf: 'b' } } }),
    ).toMatchObject({ ok: false, error: 'properties.a.showIf must name a boolean option.' })
    expect(
      parseOptionsSchema({ type: 'object', properties: { a: { type: 'string', format: 'secret' } } }),
    ).toMatchObject({ ok: false })
  })

  it('capabilities refresh on their own: soon after adding, then hourly; a silent receiver keeps the last answer', async () => {
    const h = harness()
    const dest = await setup(h)
    const budget = () => ({ deadline: Date.now() + 10_000 })
    const caps = async () =>
      (await h.json(await h.call('GET', '/api/v1/destinations', { as: h.member }))).items.find(
        (d: { id: string }) => d.id === dest.id,
      ).capabilities
    expect(await caps()).toMatchObject({ targets: false, instructions: false })
    const seen = receiver(h, {
      targets: true,
      targetNoun: 'site',
      instructions: true,
      instructionsLabel: 'What?',
    })
    expect(await refreshCapabilities(h.deps, budget())).toBe(1)
    expect(await caps()).toMatchObject({ targets: true, instructions: true, instructionsLabel: 'What?' })
    // Not again within the hour.
    expect(await refreshCapabilities(h.deps, budget())).toBe(0)
    expect(seen).toHaveLength(1)
    // An hour on, the receiver is down: what it last said stays, and it's asked again five minutes later.
    h.deps.clock.advance(3600_000 + 1000)
    receiver(h, null)
    expect(await refreshCapabilities(h.deps, budget())).toBe(1)
    expect(await caps()).toMatchObject({ targets: true, instructionsLabel: 'What?' })
    expect(await refreshCapabilities(h.deps, budget())).toBe(0)
    h.deps.clock.advance(5 * 60_000 + 1000)
    receiver(h, { instructions: true, instructionsLabel: 'New words' })
    expect(await refreshCapabilities(h.deps, budget())).toBe(1)
    expect(await caps()).toMatchObject({ targets: false, instructionsLabel: 'New words' })
    // The admin list never shows our bookkeeping.
    const admin = await h.json(await h.call('GET', '/api/v1/admin/destinations', { as: h.admin }))
    expect(admin.items[0].capabilities).toEqual({ instructions: true, instructionsLabel: 'New words' })
  })
})
