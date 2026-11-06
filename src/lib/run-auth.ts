// How a run proves it's the attempt it says, with nothing secret in its prompt or on a command line. With
// VIDEO_AGENT_RUN_SECRET set (a secret env var for builds and functions), the server and the run each derive the
// attempt's token from it and never write it down. Without it, the attempt's own random token reaches the run through
// the run manifest (prepare-run puts it in .va-run/callback.json), and /setup warns.
import { hmacHex, safeEqual, sha256Hex } from './crypto.js'

export const RUN_SECRET_ENV = 'VIDEO_AGENT_RUN_SECRET'

/** The attempt's token, derived from the run secret: only this attempt's callback and checkpoints accept it. */
export const runAttemptToken = (secret: string, attemptId: string) =>
  hmacHex(secret, `video-agent-run:v1:${attemptId}`)

/** Whether a run's bearer token is this attempt's: derived from the run secret, or the attempt's own random token. */
export function runTokenOk(
  token: string | null,
  attempt: { id: string; callbackTokenHash: string | null },
  runSecret: string | null,
): boolean {
  if (!token) return false
  if (runSecret && safeEqual(runAttemptToken(runSecret, attempt.id), token)) return true
  return !!attempt.callbackTokenHash && safeEqual(attempt.callbackTokenHash, sha256Hex(token))
}
