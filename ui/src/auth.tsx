// Netlify Identity in the browser. The session lives in the nf_jwt cookie, which the API reads; session.ts
// keeps it fresh.
import {
  acceptInvite,
  login,
  logout,
  onAuthChange,
  requestPasswordRecovery,
  signup,
  updateUser,
  type User,
} from '@netlify/identity'
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { endSession, onSessionLost, refreshIfNeeded, startSession } from './session'

interface AuthState {
  user: User | null
  ready: boolean
  /** Set when an email link needs one more step (an invite password or a password reset). */
  pending: { kind: 'invite'; token: string } | { kind: 'recovery' } | null
  notice: string | null
  login: typeof login
  signup: typeof signup
  logout: typeof logout
  requestPasswordRecovery: typeof requestPasswordRecovery
  acceptInvite: (password: string) => Promise<void>
  recoverPassword: (password: string) => Promise<void>
  clearNotice: () => void
}

const Ctx = createContext<AuthState | null>(null)
const AUTH_HASH = /^#(confirmation_token|recovery_token|invite_token|email_change_token|access_token)=/

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [ready, setReady] = useState(false)
  const [pending, setPending] = useState<AuthState['pending']>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (import.meta.env.VITE_MOCK) {
      // Mock mode: signed in as the first admin; the mock API answers every request.
      setUser({ id: 'u_sam', email: 'sam@acme.com', name: 'Sam Rivera' })
      setReady(true)
      return undefined
    }
    const off = onAuthChange((_e, u) => {
      setUser(u)
    })
    // Identity rejected the session (expired refresh token, deleted account): show the sign-in screen
    // instead of a signed-in shell whose requests all fail.
    const offLost = onSessionLost(() => {
      endSession()
      void logout().catch(() => undefined)
      setUser(null)
      setNotice('Your session ended. Sign in again.')
    })
    // A tab that slept past the token's expiry refreshes as soon as it's used again.
    const wake = () => {
      if (document.visibilityState === 'visible') void refreshIfNeeded()
    }
    window.addEventListener('focus', wake)
    document.addEventListener('visibilitychange', wake)
    void (async () => {
      try {
        // Process email links before anything else (confirmation, invite, recovery, email change).
        const isLink = AUTH_HASH.test(window.location.hash)
        const { user: u, callback: res } = await startSession(isLink)
        if (isLink) {
          history.replaceState(null, '', window.location.pathname + window.location.search)
          if (res?.type === 'invite' && res.token) setPending({ kind: 'invite', token: res.token })
          else if (res?.type === 'recovery') setPending({ kind: 'recovery' })
          else if (res?.type === 'confirmation') setNotice('Your email is confirmed. Welcome.')
          else if (res?.type === 'email_change') setNotice('Your email address was changed.')
        }
        if (u) setUser(u)
      } catch (e) {
        setNotice(e instanceof Error ? e.message : 'Sign-in link failed. Ask for a new one.')
      } finally {
        setReady(true)
      }
    })()
    return () => {
      off()
      offLost()
      window.removeEventListener('focus', wake)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [])

  const value = useMemo<AuthState>(
    () => ({
      user,
      ready,
      pending,
      notice,
      login,
      signup,
      logout: async () => {
        endSession()
        await logout()
      },
      requestPasswordRecovery,
      acceptInvite: async (password) => {
        if (pending?.kind !== 'invite') return
        setUser(await acceptInvite(pending.token, password))
        setPending(null)
      },
      recoverPassword: async (password) => {
        // The recovery link already signed the user in; set the new password on that session.
        setUser(await updateUser({ password }))
        setPending(null)
      },
      clearNotice: () => {
        setNotice(null)
      },
    }),
    [user, ready, pending, notice],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth(): AuthState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth outside AuthProvider')
  return v
}
