// Receiver callbacks and fresh links (publish destinations §3.3, §3.5). Public routes (no session, no API key): a
// derived token per operation authenticates them. A callback is scoped to its operation: an older operation's
// callback is acknowledged and ignored, so it can never undo what the person wants now. A callback may arrive before
// the worker has saved the receiver's 202; applying a terminal result bumps the lease fence, so that worker's late
// commit is refused.
import type { Deps } from '../../deps.js'
import { encrypt } from '../../lib/crypto.js'
import { ApiError } from '../../lib/errors.js'
import { getSettings } from '../settings.js'
import type { DestinationPublicationRow } from '../types.js'
import { checkCallbackToken, operationId } from './http-kind.js'
import { publicManifest, type PublishManifest } from './manifest.js'
import { emitTerminal, manifestLinks } from './run.js'
import { httpsUrl } from './targets.js'
import { safeError, safeText, safeWarnings } from './types.js'

export const SECRET_TTL_MS = 24 * 3600_000
const ACTIVE = ['queued', 'running', 'waiting', 'removing']

// Best-effort rate limit per publication (per function instance): 60 calls a minute.
const hits = new Map<string, { n: number; at: number }>()
function rateLimit(id: string) {
  const now = Date.now()
  const h = hits.get(id)
  if (!h || now - h.at > 60_000) hits.set(id, { n: 1, at: now })
  else if (++h.n > 60) throw new ApiError('rate_limited', 'Too many callbacks for this publication.')
  if (hits.size > 5000) hits.clear()
}

function parseOperation(op: unknown, id: string) {
  if (typeof op !== 'string') return null
  const m = /^(.+):(publish|remove):(\d+)$/.exec(op)
  if (!m || m[1] !== id) return null
  return { action: m[2] as 'publish' | 'remove', generation: Number(m[3]) }
}

async function authorize(deps: Deps, p: DestinationPublicationRow | null, token: string | null, op: unknown) {
  if (!p) throw new ApiError('not_found', 'Unknown publication.')
  const parsed = parseOperation(op, p.id)
  if (!parsed || !token) throw new ApiError('unauthorized', 'Bad or expired token.')
  const { fileSigningSecret } = await getSettings(deps)
  if (!checkCallbackToken(fileSigningSecret, p.id, op as string, token))
    throw new ApiError('unauthorized', 'Bad or expired token.')
  return parsed
}

export interface CallbackBody {
  operation?: unknown
  status?: unknown
  url?: unknown
  externalId?: unknown
  message?: unknown
  warnings?: unknown
  error?: unknown
  secretOnce?: unknown
}

/** Returns the HTTP status to answer with (204 applied or duplicate; errors are thrown). */
export async function receiveDestinationCallback(
  deps: Deps,
  id: string,
  token: string | null,
  body: CallbackBody,
): Promise<204> {
  rateLimit(id)
  const { dataEncryptionKey } = await getSettings(deps)
  await deps.store.tx(async (repo) => {
    const p = await repo.getDestinationPublication(id, { lock: true })
    const op = await authorize(deps, p, token, body.operation)
    if (!p) return
    const now = deps.clock.now().toISOString()
    // An older operation's callback: acknowledged, ignored.
    if (op.generation < p.generation) return
    if (op.generation > p.generation || op.action !== p.operation)
      throw new ApiError('unauthorized', 'Bad or expired token.')
    if (now > p.deadlineAt) throw new ApiError('unauthorized', 'Bad or expired token.')
    const allowed = op.action === 'publish' ? ['working', 'live', 'failed'] : ['working', 'removed', 'failed']
    const status = typeof body.status === 'string' ? body.status : ''
    if (!allowed.includes(status))
      throw new ApiError('conflict', `"${status}" is not allowed for this operation.`)
    if (p.status === 'removed') {
      if (status === 'removed') return
      throw new ApiError('gone', 'This publication was removed.')
    }
    // Already finished: the first terminal answer wins; repeats change nothing.
    if (!ACTIVE.includes(p.status)) return
    const message = safeText(body.message)
    if (status === 'working') {
      if (message) await repo.updateDestinationPublication(p.id, { message, updatedAt: now })
      return
    }
    const patch: Partial<DestinationPublicationRow> = {
      updatedAt: now,
      leaseUntil: null,
      leaseFence: p.leaseFence + 1,
      nextRunAt: null,
      // A progress message ("Creating the site") belongs to the work; a finished publication keeps only the final
      // callback's own message, like a synchronous answer does (run.ts).
      message: message ?? null,
    }
    if (status === 'live') {
      const url = body.url == null ? null : httpsUrl(body.url)
      if (body.url != null && url === null) throw new ApiError('invalid_request', 'url must be https.')
      const warnings = safeWarnings(body.warnings)
      Object.assign(patch, {
        status: 'live',
        url,
        externalId: typeof body.externalId === 'string' ? body.externalId.slice(0, 500) : p.externalId,
        warnings: warnings ?? null,
        error: null,
        liveAt: now,
      })
      const s = body.secretOnce as { label?: unknown; value?: unknown } | undefined
      if (s && typeof s === 'object' && p.secretOnceIssuedAt === null) {
        const value =
          typeof s.value === 'string' && s.value.length > 0 && s.value.length <= 500 ? s.value : null
        if (value) {
          Object.assign(patch, {
            secretOnceEnc: encrypt(dataEncryptionKey, value),
            secretOnceLabel: safeText(s.label, 40) ?? 'Secret',
            secretOnceIssuedAt: now,
            secretOnceExpiresAt: new Date(Date.parse(now) + SECRET_TTL_MS).toISOString(),
          })
        }
      }
    } else if (status === 'removed') {
      Object.assign(patch, { status: 'removed', removedAt: now, error: null })
    } else {
      const e = body.error as { code?: unknown; message?: unknown } | undefined
      Object.assign(patch, {
        status: 'failed',
        error: safeError(
          typeof e?.code === 'string' ? e.code : 'receiver_failed',
          safeText(e?.message) ?? message ?? 'The destination reported a failure.',
        ),
      })
    }
    await repo.updateDestinationPublication(p.id, patch)
    await emitTerminal(repo, deps, { ...p, ...patch })
    deps.log.info('destination.callback', { id: p.id, operation: operationId(p), status })
  })
  return 204
}

/** Fresh signed links for an active publish operation (§3.5). */
export async function destinationFiles(deps: Deps, id: string, token: string | null, body: CallbackBody) {
  rateLimit(id)
  const p = await deps.store.getDestinationPublication(id)
  const op = await authorize(deps, p, token, body.operation)
  if (!p) throw new ApiError('not_found', 'Unknown publication.')
  const now = deps.clock.now().toISOString()
  if (
    op.action !== 'publish' ||
    op.generation !== p.generation ||
    p.operation !== 'publish' ||
    !['queued', 'running', 'waiting'].includes(p.status) ||
    now > p.deadlineAt
  )
    throw new ApiError('conflict', 'Fresh links are only for an active publish.')
  const m = p.manifest as PublishManifest
  const links = await manifestLinks(deps, p, m)
  return { files: publicManifest(m, links).files }
}
