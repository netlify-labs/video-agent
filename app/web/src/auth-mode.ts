// Which sign-in the deployment uses (/api/v1/config authProvider). With Sign in with Netlify the session is an
// httpOnly cookie the server rotates, so there is nothing to refresh here: a 401 means the session ended.
export type AuthMode = 'identity' | 'netlify'

let mode: AuthMode = 'identity'
const lostListeners = new Set<(message: string | null) => void>()

export const authMode = () => mode

export function setAuthMode(m: AuthMode) {
  mode = m
}

/** Called with the server's message when a Sign in with Netlify session ends (sign-out elsewhere, team, admin). */
export function onCookieSessionLost(listener: (message: string | null) => void): () => void {
  lostListeners.add(listener)
  return () => lostListeners.delete(listener)
}

export function cookieSessionLost(message: string | null) {
  for (const listener of lostListeners) listener(message)
}
