// Netlify Identity in the browser. The session lives in the nf_jwt cookie, which the API reads; session.ts
// keeps it fresh. With Sign in with Netlify (authProvider 'netlify') the Identity SDK isn't used: the server sets
// an httpOnly session cookie, the current user comes from /api/v1/me, and sign-out is POST /auth/sign-out.
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
import { useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { onCookieSessionLost, setAuthMode, type AuthMode } from './auth-mode'
import { endSession, onSessionLost, refreshIfNeeded, startSession } from './session'
import { clearMediaCache } from './sw/register'

interface AuthState {
  user: User | null
  ready: boolean
  /** How this deployment signs people in. */
  provider: AuthMode
  /** Set when an email link needs one more step (an invite password or a password reset). */
  pending: { kind: 'invite'; token: string } | { kind: 'recovery' } | null
  notice: string | null
  /** 'warn' when the session was ended by the server (team, admin) rather than by the person. */
  noticeTone: 'info' | 'warn'
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

/** The deployment's sign-in provider; Identity when the config can't be read (the default for forks). */
async function readProvider(): Promise<AuthMode> {
  try {
    const res = await fetch('/api/v1/config', { credentials: 'same-origin' })
    const body = (await res.json()) as { authProvider?: unknown }
    return body.authProvider === 'netlify' ? 'netlify' : 'identity'
  } catch {
    return 'identity'
  }
}

/** The signed-in person behind the Sign in with Netlify cookie, or null. */
async function cookieUser(): Promise<User | null> {
  const res = await fetch('/api/v1/me', { credentials: 'same-origin' })
  if (res.status === 401) return null
  if (!res.ok) throw new Error('Could not load your account. Try again shortly.')
  const me = (await res.json()) as { id: string; email: string; name: string | null }
  return { id: me.id, email: me.email, name: me.name ?? undefined } as User
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [ready, setReady] = useState(false)
  const [pending, setPending] = useState<AuthState['pending']>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [noticeTone, setNoticeTone] = useState<'info' | 'warn'>('info')
  const [provider, setProvider] = useState<AuthMode>('identity')
  const qc = useQueryClient()
  const lastUserId = useRef<string | null>(null)
  const signedIn = useRef(false)
  signedIn.current = user !== null

  // Cached responses belong to whoever fetched them, and stay fresh for a while: after sign-out or a switch to
  // someone else, start from an empty cache.
  const userId = user?.id ?? null
  useEffect(() => {
    if (lastUserId.current && lastUserId.current !== userId) void qc.resetQueries()
    lastUserId.current = userId
  }, [userId, qc])

  useEffect(() => {
    if (import.meta.env.VITE_MOCK) {
      // Mock mode: signed in as the first admin (localStorage.mockSignedOut shows the sign-in page); the mock API
      // answers every request.
      let signedOut = false
      try {
        signedOut = localStorage.getItem('mockSignedOut') === '1'
        if (localStorage.getItem('mockAuthProvider') === 'netlify') setProvider('netlify')
      } catch {
        // No storage: signed in, with Identity.
      }
      if (!signedOut) setUser({ id: 'u_sam', email: 'sam@acme.com', name: 'Sam Rivera' })
      setReady(true)
      return undefined
    }
    let cancelled = false
    let stopIdentity: (() => void) | null = null
    void readProvider().then((p) => {
      if (cancelled) return
      setAuthMode(p)
      setProvider(p)
      stopIdentity = p === 'netlify' ? startCookieSession() : startIdentitySession()
    })
    return () => {
      cancelled = true
      stopIdentity?.()
    }

    function startCookieSession() {
      const offLost = onCookieSessionLost((message) => {
        if (!signedIn.current) return
        void clearMediaCache()
        setUser(null)
        setNotice(message ?? 'Your session ended. Sign in again.')
        setNoticeTone('warn')
      })
      void cookieUser()
        .then((u) => {
          setUser(u)
        })
        .catch((e: unknown) => {
          setNotice(e instanceof Error ? e.message : 'Could not load your account.')
          setNoticeTone('warn')
        })
        .finally(() => {
          setReady(true)
        })
      return offLost
    }
  }, [])

  function startIdentitySession() {
    const off = onAuthChange((_e, u) => {
      setUser(u)
    })
    // Identity rejected the session (expired refresh token, deleted account): show the sign-in screen
    // instead of a signed-in shell whose requests all fail.
    const offLost = onSessionLost(() => {
      endSession()
      void clearMediaCache()
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
  }

  const value = useMemo<AuthState>(
    () => ({
      user,
      ready,
      provider,
      pending,
      notice,
      noticeTone,
      login,
      signup,
      logout: async () => {
        // Cached posters and clips belong to this person; the next one to sign in starts empty.
        if (provider === 'netlify') {
          await fetch('/auth/sign-out', { method: 'POST', credentials: 'same-origin' }).catch(() => undefined)
          await clearMediaCache()
          setUser(null)
          return
        }
        endSession()
        await clearMediaCache()
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
        setNoticeTone('info')
      },
    }),
    [user, ready, provider, pending, notice, noticeTone],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth(): AuthState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth outside AuthProvider')
  return v
}
