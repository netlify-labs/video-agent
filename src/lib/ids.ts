import { randomBytes, randomUUID } from 'node:crypto'
import { ulid } from 'ulid'

export interface Ids {
  videoId(): string
  keyId(): string
  uuid(): string
  slug(): string
  secret(bytes?: number): string
}

const SLUG_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'

export const ids: Ids = {
  videoId: () => `vid_${ulid().toLowerCase()}`,
  keyId: () => `key_${ulid().toLowerCase()}`,
  uuid: () => randomUUID(),
  slug: () => {
    const bytes = randomBytes(10)
    let out = ''
    for (const b of bytes) out += SLUG_ALPHABET[b % SLUG_ALPHABET.length]
    return out
  },
  secret: (n = 32) => randomBytes(n).toString('base64url'),
}
