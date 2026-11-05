// Verifying the webhooks a deployment sends (cli-and-sdk plan §4.2 Webhooks). The signature header is
// t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>"> (src/lib/crypto.ts webhookSignature). WebCrypto only, so
// it runs in Node, Deno, Bun, Workers and Netlify Edge Functions. Pass the raw body string, exactly as received.
import { VideoAgentError } from './errors.js'
import type { components } from './generated/schema.js'

export type WebhookEventType =
  | 'video.ready'
  | 'video.failed'
  | 'comment.created'
  | 'version.approved'
  | 'version.changes_requested'
  | 'destination.live'
  | 'destination.failed'
  | 'destination.removed'

/** A verified delivery. `eventId` is the same on redeliveries: dedupe on it. */
export interface WebhookEvent {
  eventId: string
  event: WebhookEventType | (string & {})
  createdAt: string
  /** The video, as GET /api/v1/videos/{id} returns it, when the event is about one. */
  video?: components['schemas']['Video']
  /** The version the event is about, when there is one. */
  version?: number
  /** This delivery's id (x-video-agent-delivery): differs between redeliveries of one event. */
  deliveryId: string | null
  [field: string]: unknown
}

export interface VerifyWebhookOptions {
  /** The webhook secret shown when the key or webhook was made. */
  secret: string
  /** The raw request body, as received (not re-serialized JSON). */
  body: string
  /** The x-video-agent-signature header. */
  signature: string | null | undefined
  /** How old (or how far in the future) a timestamp may be. Default 300 s. */
  toleranceSec?: number
  /** For tests: the current time in seconds. */
  nowSec?: number
}

const enc = new TextEncoder()

const invalid = (message: string) => new VideoAgentError({ status: 0, code: 'invalid_signature', message })

/** Throws VideoAgentError code invalid_signature unless the body was signed with this secret, recently. */
export async function verifyWebhook(o: VerifyWebhookOptions): Promise<void> {
  const parts = new Map(
    (o.signature ?? '').split(',').map((p) => {
      const i = p.indexOf('=')
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const
    }),
  )
  const t = Number(parts.get('t'))
  const v1 = parts.get('v1') ?? ''
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(v1))
    throw invalid('The webhook signature header is missing or malformed.')
  const now = o.nowSec ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - t) > (o.toleranceSec ?? 300))
    throw invalid('The webhook signature is too old (or from the future); a replay is refused.')
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(o.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  // subtle.verify compares in constant time.
  const ok = await crypto.subtle.verify('HMAC', key, hexBytes(v1), enc.encode(`${t}.${o.body}`))
  if (!ok) throw invalid("The webhook signature doesn't match this secret and body.")
}

/** Verifies a delivery, then returns its event with the delivery id. Headers: a Headers object or a plain record. */
export async function parseWebhook(o: {
  secret: string
  body: string
  headers: Headers | Record<string, string | string[] | undefined>
  toleranceSec?: number
  nowSec?: number
}): Promise<WebhookEvent> {
  const header = (name: string): string | null => {
    if (o.headers instanceof Headers) return o.headers.get(name)
    const entry = Object.entries(o.headers).find(([k]) => k.toLowerCase() === name)?.[1]
    return Array.isArray(entry) ? (entry[0] ?? null) : (entry ?? null)
  }
  await verifyWebhook({
    secret: o.secret,
    body: o.body,
    signature: header('x-video-agent-signature'),
    ...(o.toleranceSec !== undefined ? { toleranceSec: o.toleranceSec } : {}),
    ...(o.nowSec !== undefined ? { nowSec: o.nowSec } : {}),
  })
  return { ...(JSON.parse(o.body) as WebhookEvent), deliveryId: header('x-video-agent-delivery') }
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
