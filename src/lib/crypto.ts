// HMAC signing for file URLs and webhooks; AES-256-GCM for secrets at rest.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

export const sha256Hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')

export function hmacHex(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('hex')
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/** Signed file URL parameters: HMAC over path and expiry, plus the job's access epoch for private videos. */
export function signPath(secret: string, path: string, expiresAtSec: number, epoch?: number): string {
  return hmacHex(secret, signedString(path, expiresAtSec, epoch))
}

export const signedString = (path: string, exp: number, epoch?: number) =>
  `${path}\n${exp}${epoch === undefined ? '' : `\ne${epoch}`}`

export function verifyPath(
  secret: string,
  path: string,
  expiresAtSec: number,
  sig: string,
  nowSec: number,
): boolean {
  if (!Number.isFinite(expiresAtSec) || expiresAtSec < nowSec) return false
  return safeEqual(signPath(secret, path, expiresAtSec), sig)
}

/** Webhook signature header value: t=<unix>,v1=<hex hmac of "t.body">. */
export function webhookSignature(secret: string, body: string, tSec: number): string {
  return `t=${tSec},v1=${hmacHex(secret, `${tSec}.${body}`)}`
}

export function encrypt(keyB64: string, plaintext: string): string {
  const key = Buffer.from(keyB64, 'base64url')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ct.toString('base64url'),
  ].join('.')
}

export function decrypt(keyB64: string, payload: string): string {
  const [v, iv, tag, ct] = payload.split('.')
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported ciphertext')
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(keyB64, 'base64url'),
    Buffer.from(iv, 'base64url'),
  )
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8')
}
