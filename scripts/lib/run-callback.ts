// The attempt's callback token on the runner, never in the prompt or on a command line. With VIDEO_AGENT_RUN_SECRET in
// the env, render-job and checkpoint derive it (app/server/lib/run-auth.ts). Without it, the server puts the attempt's token
// in the run manifest, prepare-run writes it here (mode 0600, under .va-run/, which is never archived, uploaded,
// checkpointed or committed), and render-job and checkpoint read it back.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RUN_SECRET_ENV, runAttemptToken } from '../../app/server/lib/run-auth.js'

export const CALLBACK_FILE = join('.va-run', 'callback.json')

/** Writes the attempt's token for render-job and checkpoint, readable by this user only. */
export function writeCallback(root: string, cb: { attemptId: string; token: string }): void {
  mkdirSync(join(root, '.va-run'), { recursive: true, mode: 0o700 })
  const file = join(root, CALLBACK_FILE)
  writeFileSync(file, JSON.stringify(cb), { mode: 0o600 })
  chmodSync(file, 0o600)
}

/** Where the attempt's token came from, for the run's log (never the token). */
export type TokenSource = 'run-secret' | 'file' | 'env' | 'flag' | 'none'

/**
 * The attempt's token: derived from VIDEO_AGENT_RUN_SECRET when the run has it, else .va-run/callback.json (for this
 * attempt), else VA_CALLBACK_TOKEN, else a --token flag (deprecated: prompts before template 26 passed it).
 */
export function callbackAuth(
  root: string,
  attemptId: string,
  flag?: string,
): { token: string; source: TokenSource } {
  const secret = process.env[RUN_SECRET_ENV]?.trim()
  if (secret && secret.length >= 32 && attemptId)
    return { token: runAttemptToken(secret, attemptId), source: 'run-secret' }
  const file = join(root, CALLBACK_FILE)
  if (existsSync(file)) {
    try {
      const cb = JSON.parse(readFileSync(file, 'utf8')) as { attemptId?: unknown; token?: unknown }
      if (cb.attemptId === attemptId && typeof cb.token === 'string' && cb.token)
        return { token: cb.token, source: 'file' }
    } catch {
      // A broken file falls through to the other sources.
    }
  }
  if (process.env.VA_CALLBACK_TOKEN) return { token: process.env.VA_CALLBACK_TOKEN, source: 'env' }
  return flag ? { token: flag, source: 'flag' } : { token: '', source: 'none' }
}

export const callbackToken = (root: string, attemptId: string, flag?: string) =>
  callbackAuth(root, attemptId, flag).token

/** Whether the platform lists the run secret among the env vars it masks in a run's output (names only). */
export const runSecretMasked = () =>
  (process.env.NETLIFY_SENSITIVE_ENV_KEYS ?? '').split(/[\s,]+/).includes(RUN_SECRET_ENV)
