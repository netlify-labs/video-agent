// Targets (publish destinations §2.2, §3.4): generic on purpose. The app checks shapes and limits, shows name,
// description and url, and passes metadata back untouched. It never knows what a target is.
import type { Target } from '../types.js'

export const TARGETS_MAX = 100
const META_KEYS_MAX = 20
const META_BYTES_MAX = 2048

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : null

export function httpsUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 2000) return null
  try {
    const u = new URL(v)
    return u.protocol === 'https:' && !u.username && !u.password ? u.toString() : null
  } catch {
    return null
  }
}

/** One target, or null when it breaks a rule. */
export function validTarget(raw: unknown): Target | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const id = str(r.id, 200)
  const name = str(r.name, 200)
  if (!id || !name) return null
  const description = r.description == null ? null : str(r.description, 500)
  if (r.description != null && description === null) return null
  const url = r.url == null ? null : httpsUrl(r.url)
  if (r.url != null && url === null) return null
  let metadata: Target['metadata'] = null
  if (r.metadata != null) {
    if (typeof r.metadata !== 'object' || Array.isArray(r.metadata)) return null
    const entries = Object.entries(r.metadata as Record<string, unknown>)
    if (entries.length > META_KEYS_MAX) return null
    for (const [k, v] of entries) {
      if (k.length > 100) return null
      if (!(v === null || ['string', 'number', 'boolean'].includes(typeof v))) return null
      if (typeof v === 'number' && !Number.isFinite(v)) return null
    }
    metadata = Object.fromEntries(entries) as Target['metadata']
    if (Buffer.byteLength(JSON.stringify(metadata)) > META_BYTES_MAX) return null
  }
  return { id, name, description, url, metadata }
}

/** A receiver's targets list: bad entries dropped (counted), at most 100, the receiver's order kept. */
export function validateTargets(raw: unknown): { targets: Target[]; dropped: number } {
  if (!Array.isArray(raw)) return { targets: [], dropped: 0 }
  const targets: Target[] = []
  let dropped = 0
  const seen = new Set<string>()
  for (const r of raw) {
    const t = validTarget(r)
    if (!t || seen.has(t.id) || targets.length >= TARGETS_MAX) {
      dropped++
      continue
    }
    seen.add(t.id)
    targets.push(t)
  }
  return { targets, dropped }
}
