// Netlify Identity events. userValidate enforces admission at sign-up; the API re-checks on every request.
import type { UserValidateEvent } from '@netlify/functions'
import { readConfig } from '../../app/server/deps.js'
import { emailDomain } from '../../app/server/domain/auth.js'

export default {
  userValidate(event: UserValidateEvent) {
    const mode = readConfig(process.env).allowedEmailDomains
    const email = event.user.email ?? ''
    if (mode === null || mode === 'invite-only') {
      // Invited users are created by an admin, not by self sign-up.
      if (event.user.invitedAt) return undefined
      return event.deny()
    }
    if (!mode.includes(emailDomain(email))) return event.deny()
    return undefined
  },
}
