// A new deployment invites the people in ADMIN_EMAILS to Netlify Identity, from the setup check.
import { describe, expect, it } from 'vitest'
import { harness } from './helpers.js'

type Health = { ready: boolean; checks: { id: string; status: string; detail: string; fix?: string }[] }
const health = async (h: ReturnType<typeof harness>) =>
  h.json<Health>(await h.call('GET', '/api/health?fresh=1'))
const invites = (r: Health) => r.checks.find((c) => c.id === 'admin-invites')

describe('admin invites', () => {
  it('invites each admin Identity does not know, once', async () => {
    const h = harness({ ADMIN_EMAILS: 'new@acme.com,admin@acme.com' })
    const first = await health(h)
    // admin@acme.com already has an Identity account (the harness adds it), so only the new address is emailed.
    expect(h.deps.identity.invites).toEqual(['new@acme.com'])
    expect(invites(first)).toMatchObject({
      status: 'ok',
      detail: expect.stringContaining('Invited new@acme.com'),
    })
    const second = await health(h)
    expect(h.deps.identity.invites).toEqual(['new@acme.com'])
    expect(invites(second)).toBeUndefined()
  })

  it('invites nobody once the app has a user', async () => {
    const h = harness({ ADMIN_EMAILS: 'new@acme.com,admin@acme.com' })
    expect((await h.call('GET', '/api/v1/me', { as: h.admin })).status).toBe(200)
    expect(invites(await health(h))).toBeUndefined()
    expect(h.deps.identity.invites).toEqual([])
  })

  it('says who it could not invite, and tries again on the next check', async () => {
    const h = harness({ ADMIN_EMAILS: 'new@acme.com' })
    h.deps.identity.inviteFails = true
    const failed = await health(h)
    expect(invites(failed)).toMatchObject({
      status: 'warn',
      detail: 'Could not invite new@acme.com.',
      fix: expect.stringContaining('/identity'),
    })
    h.deps.identity.inviteFails = false
    expect(invites(await health(h))).toMatchObject({ status: 'ok' })
    expect(h.deps.identity.invites).toEqual(['new@acme.com'])
  })

  it('invites nobody when Identity is off or the app uses Sign in with Netlify', async () => {
    const off = harness({ ADMIN_EMAILS: 'new@acme.com' })
    off.deps.identity.settingsValue = null
    expect(invites(await health(off))).toBeUndefined()
    expect(off.deps.identity.invites).toEqual([])
    const netlify = harness({ ADMIN_EMAILS: 'new@acme.com', AUTH_PROVIDER: 'netlify' })
    expect(invites(await health(netlify))).toBeUndefined()
    expect(netlify.deps.identity.invites).toEqual([])
  })
})
