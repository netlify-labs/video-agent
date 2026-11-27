// Netlify Identity through @netlify/identity. getUser() reads the request's nf_jwt cookie from the
// Netlify runtime, so the Request argument is unused here.
import { AuthError, MissingIdentityError, admin, getSettings, getUser, type User } from '@netlify/identity'
import type { IdentityPort, IdentityUser } from '../deps.js'

const toUser = (u: User): IdentityUser => ({
  id: u.id,
  email: (u.email ?? '').toLowerCase(),
  name: u.name ?? null,
  confirmed: Boolean(u.confirmedAt),
  invited: Boolean(u.invitedAt),
})

export const netlifyIdentity: IdentityPort = {
  async sessionUser() {
    const u = await getUser()
    return u ? toUser(u) : null
  },
  async liveUser(id) {
    try {
      return toUser(await admin.getUser(id))
    } catch (e) {
      if (e instanceof AuthError && (e.status === 404 || /not found/i.test(e.message))) return null
      throw e
    }
  },
  async settings() {
    try {
      const s = await getSettings()
      return { autoconfirm: s.autoconfirm, disableSignup: s.disableSignup }
    } catch (e) {
      if (e instanceof MissingIdentityError) return null
      throw e
    }
  },
  // The library has no invite call, so this is Identity's own POST /invite with the operator token the Netlify
  // runtime gives each function (the same one the library's admin calls use).
  async invite(email) {
    const ctx = (globalThis as { netlifyIdentityContext?: { url?: string; token?: string } })
      .netlifyIdentityContext
    if (!ctx?.url || !ctx.token) throw new Error('Identity has no operator token in this context')
    const res = await fetch(`${ctx.url}/invite`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(8000),
    })
    if (res.ok) return 'invited'
    const body = (await res.json().catch(() => ({}))) as { msg?: string }
    if (res.status === 422 && /already|registered|exists/i.test(body.msg ?? '')) return 'exists'
    throw new Error(`Identity invite returned ${String(res.status)}`)
  },
}
