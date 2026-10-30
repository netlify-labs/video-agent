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
}
