// The HTTP destination (publish destinations §3, contract v1, normative): any HTTPS endpoint an admin adds. Every
// request is signed like a webhook (x-video-agent-signature: t=<unix>,v1=hex(HMAC-SHA256(secret, "<t>." + body))),
// goes through the pinned transport (public addresses only, no redirects, no credentials) and reads a bounded answer.
import type { Deps } from '../../deps.js'
import { decrypt, deriveKey, hmacHex, safeEqual, webhookSignature } from '../../lib/crypto.js'
import { openOptions, parseOptionsSchema } from '../../lib/options-schema.js'
import { getSettings } from '../settings.js'
import type { DestinationPublicationRow, DestinationRow, Target } from '../types.js'
import { publicManifest, type PublishManifest } from './manifest.js'
import { registerKind } from './registry.js'
import { httpsUrl, validateTargets } from './targets.js'
import {
  safeError,
  safeText,
  safeWarnings,
  type DestinationKind,
  type StepCtx,
  type StepResult,
} from './types.js'

export const CONTRACT = 1
export const REQUEST_TIMEOUT_MS = 30_000
export const TARGETS_TIMEOUT_MS = 5_000
export const MAX_RESPONSE_BYTES = 64 * 1024
const MAX_RETRY_AFTER_SEC = 3600

export type HttpEvent = 'publish' | 'remove' | 'targets' | 'ping'

/** The callback token for one operation: derived, so a restarted worker sends the same one (§3.3). */
export function callbackToken(signingSecret: string, publicationId: string, operation: string): string {
  return `dpc_${hmacHex(deriveKey(signingSecret, 'destination-callback-v1'), `${publicationId}:${operation}`)}`
}

export function checkCallbackToken(
  signingSecret: string,
  publicationId: string,
  operation: string,
  token: string,
) {
  return safeEqual(callbackToken(signingSecret, publicationId, operation), token)
}

export const operationId = (p: Pick<DestinationPublicationRow, 'id' | 'operation' | 'generation'>) =>
  `${p.id}:${p.operation}:${p.generation}`

function envelope(
  event: HttpEvent,
  d: DestinationRow,
  publisher: { id: string; name: string | null; email: string } | null,
  now: Date,
) {
  return {
    contract: CONTRACT,
    event,
    sentAt: now.toISOString(),
    destination: { id: d.id, name: d.name },
    publisher: publisher
      ? d.sharePublisherContact
        ? { id: publisher.id, name: publisher.name, email: publisher.email }
        : { id: publisher.id }
      : null,
  }
}

async function send(
  deps: Pick<Deps, 'http' | 'clock' | 'store' | 'ids' | 'blobs'>,
  d: DestinationRow,
  event: HttpEvent,
  payload: object,
  extraHeaders: Record<string, string> = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
) {
  const { dataEncryptionKey } = await getSettings(deps)
  const secret = decrypt(dataEncryptionKey, d.secretEnc)
  const body = JSON.stringify(payload)
  const t = Math.floor(deps.clock.now().getTime() / 1000)
  return deps.http.postJsonForResponse(
    d.url,
    body,
    {
      'content-type': 'application/json; charset=utf-8',
      'x-video-agent-signature': webhookSignature(secret, body, t),
      'x-video-agent-event': event,
      ...extraHeaders,
    },
    { timeoutMs, maxBodyBytes: MAX_RESPONSE_BYTES },
  )
}

const parse = (body: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(body) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const receiverMessage = (j: Record<string, unknown> | null) => {
  const e = j?.error
  return e && typeof e === 'object' ? safeText((e as Record<string, unknown>).message) : null
}

function retryAfterSec(h: string | null): number | undefined {
  if (!h) return undefined
  const n = Number(h)
  if (Number.isFinite(n) && n >= 0) return Math.min(n, MAX_RETRY_AFTER_SEC)
  const at = Date.parse(h)
  return Number.isFinite(at)
    ? Math.min(Math.max(0, (at - Date.now()) / 1000), MAX_RETRY_AFTER_SEC)
    : undefined
}

/** Maps a receiver's answer to a step result (§3.2). */
export function mapResponse(
  action: 'publish' | 'remove',
  res: { status: number; body: string; headers: { retryAfter: string | null } },
): StepResult {
  const j = parse(res.body)
  const s = res.status
  if (s === 408 || s === 429 || s >= 500)
    return {
      status: 'retry',
      error: safeError(`http_${s}`, receiverMessage(j) ?? `The destination answered ${s}.`),
      ...(retryAfterSec(res.headers.retryAfter) !== undefined
        ? { retryAfterSec: retryAfterSec(res.headers.retryAfter) as number }
        : {}),
    }
  if (
    action === 'remove' &&
    (s === 204 || s === 404 || (s === 200 && (j === null || j.status === 'removed')))
  )
    return { status: 'removed' }
  if (s >= 200 && s < 300 && j) {
    if (action === 'publish' && s === 200 && j.status === 'live') {
      const url = j.url == null ? null : httpsUrl(j.url)
      if (j.url != null && url === null)
        return { status: 'failed', error: safeError('bad_response', 'The URL it returned is not https.') }
      const externalId = typeof j.externalId === 'string' ? j.externalId.slice(0, 500) : null
      const warnings = safeWarnings(j.warnings)
      return { status: 'live', url, externalId, ...(warnings ? { warnings } : {}) }
    }
    if (s === 202 && j.status === 'accepted') {
      const msg = safeText(j.message)
      return {
        status: 'waiting',
        checkAfterSec: null,
        ...(typeof j.externalId === 'string' ? { externalId: j.externalId.slice(0, 500) } : {}),
        ...(msg ? { message: msg } : {}),
      }
    }
  }
  if (s >= 200 && s < 300)
    return {
      status: 'failed',
      error: safeError('bad_response', 'The destination sent an answer we could not read.'),
    }
  return {
    status: 'failed',
    error: safeError(`http_${s}`, receiverMessage(j) ?? `The destination answered ${s}.`),
  }
}

async function step(ctx: StepCtx): Promise<StepResult> {
  const d = ctx.destination.row
  if (!d)
    return { status: 'failed', error: safeError('destination_gone', 'This destination no longer exists.') }
  const deps = ctx.deps
  const p = ctx.publication
  const publisher = await deps.store.getUser(p.publishedBy)
  const op = operationId(p)
  const { fileSigningSecret, dataEncryptionKey } = await getSettings(deps)
  const callback = {
    url: `${deps.config.siteUrl}/api/v1/destination-callbacks/${p.id}`,
    token: callbackToken(fileSigningSecret, p.id, op),
    expiresAt: p.deadlineAt,
  }
  const pub = publisher
    ? { id: publisher.id, name: publisher.name, email: publisher.email }
    : { id: p.publishedBy, name: null, email: '' }
  let payload: object
  if (ctx.operation.action === 'publish') {
    const m = ctx.manifest as PublishManifest
    payload = {
      ...envelope('publish', d, pub, deps.clock.now()),
      publication: p.id,
      operation: op,
      options: openOptions(p.options, (s) => decrypt(dataEncryptionKey, s)),
      target: p.target,
      instructions: p.instructions,
      manifest: publicManifest(m, await ctx.files()),
      callback,
    }
  } else {
    payload = {
      ...envelope('remove', d, pub, deps.clock.now()),
      publication: p.id,
      operation: op,
      externalId: p.externalId,
      url: p.url,
      target: p.target,
      callback,
    }
  }
  let res
  try {
    res = await send(deps, d, ctx.operation.action, payload, { 'x-video-agent-delivery': op })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'network error'
    // A redirect is a failure, not a retry (the transport refuses to follow it; §3.2).
    if (/redirect/.test(msg))
      return { status: 'failed', error: safeError('http_3xx', 'The destination tried to redirect.') }
    return { status: 'retry', error: safeError('network', 'Could not reach the destination.') }
  }
  return mapResponse(ctx.operation.action, res)
}

export const httpKind: DestinationKind = {
  kind: 'http',
  optionsSchema: (d) => {
    if (!d.row?.optionsSchema) return null
    const p = parseOptionsSchema(d.row.optionsSchema)
    return p.ok ? p.value : null
  },
  unpublishOptionsSchema: () => null,
  ready: async ({ destination }) =>
    destination.row?.enabled ? { ok: true } : { ok: false, reason: 'This destination is turned off.' },
  step,
}

registerKind(httpKind)

/** The `targets` event (§3.4): this person's targets, validated; a failure returns none plus the reason. */
export async function fetchTargets(
  deps: Deps,
  d: DestinationRow,
  publisher: { id: string; name: string | null; email: string },
  video: { id: string; title: string },
): Promise<{ targets: Target[]; dropped: number; error: string | null }> {
  try {
    const res = await send(
      deps,
      d,
      'targets',
      { ...envelope('targets', d, publisher, deps.clock.now()), video },
      {},
      TARGETS_TIMEOUT_MS,
    )
    const j = parse(res.body)
    if (res.status !== 200 || !j || !Array.isArray(j.targets))
      return { targets: [], dropped: 0, error: `The destination answered ${res.status}.` }
    return { ...validateTargets(j.targets), error: null }
  } catch {
    return { targets: [], dropped: 0, error: 'Could not reach the destination.' }
  }
}

/** The `ping` event (§3.6): reachability plus the capabilities it reports, validated. */
export async function pingDestination(deps: Deps, d: DestinationRow, timeoutMs = REQUEST_TIMEOUT_MS) {
  try {
    const res = await send(deps, d, 'ping', envelope('ping', d, null, deps.clock.now()), {}, timeoutMs)
    const j = parse(res.body)
    const ok = res.status >= 200 && res.status < 300
    return {
      ok,
      status: res.status,
      capabilities: ok ? validCapabilities(j?.capabilities) : null,
      error: ok ? null : (receiverMessage(j) ?? `HTTP ${res.status}`),
    }
  } catch (e) {
    return {
      ok: false,
      status: 0,
      capabilities: null,
      error:
        e instanceof Error && /redirect/.test(e.message)
          ? 'The destination tried to redirect.'
          : 'Could not reach the destination.',
    }
  }
}

export function validCapabilities(raw: unknown): DestinationRow['capabilities'] {
  if (!raw || typeof raw !== 'object') return {}
  const c = raw as Record<string, unknown>
  const text = (v: unknown, max: number) =>
    typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined
  const out: DestinationRow['capabilities'] = {}
  if (c.targets === true) out.targets = true
  if (c.instructions === true) out.instructions = true
  const noun = text(c.targetNoun, 30)
  if (noun) out.targetNoun = noun
  const label = text(c.instructionsLabel, 60)
  if (label) out.instructionsLabel = label
  const hint = text(c.instructionsHint, 200)
  if (hint) out.instructionsHint = hint
  return out
}
