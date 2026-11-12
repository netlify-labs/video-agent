// Admin management of HTTP destinations (publish destinations §3.6, §6.1): add, change, rotate the secret (shown
// once), test (ping + capabilities), disable, delete. The publisher's name and email go out only where an admin turned
// that on.
import type { Deps } from '../../deps.js'
import { encrypt } from '../../lib/crypto.js'
import { ApiError } from '../../lib/errors.js'
import { parseOptionsSchema } from '../../lib/options-schema.js'
import { assertCan, type Principal } from '../policy.js'
import { getSettings } from '../settings.js'
import type { DestinationRow } from '../types.js'
import { pingDestination } from './http-kind.js'

export interface DestinationInput {
  name?: string | undefined
  url?: string | undefined
  enabled?: boolean | undefined
  optionsSchema?: unknown
  sharePublisherContact?: boolean | undefined
}

function checkUrl(url: string) {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new ApiError('invalid_request', 'Enter a full https:// URL.')
  }
  if (u.protocol !== 'https:') throw new ApiError('invalid_request', 'Destination URLs must use https.')
  if (u.username || u.password)
    throw new ApiError('invalid_request', 'Destination URLs must not carry credentials.')
  if (url.length > 2000) throw new ApiError('invalid_request', 'That URL is too long.')
}

function checkName(name: string) {
  if (!name.trim() || name.length > 60)
    throw new ApiError('invalid_request', 'Give it a name of 1 to 60 characters.')
}

function checkSchema(raw: unknown) {
  if (raw == null) return null
  const p = parseOptionsSchema(raw)
  if (!p.ok) throw new ApiError('invalid_request', `Options form: ${p.error}`)
  return p.value
}

/** What the receiver said, without our own bookkeeping (when to ask again). */
function shownCapabilities(c: DestinationRow['capabilities']) {
  const out = { ...c }
  delete out.nextCheckAt
  return out
}

const newSecret = (deps: Pick<Deps, 'ids'>) => `dsec_${deps.ids.secret(24)}`

export function adminDto(
  d: DestinationRow,
  counts: { live: number; failed: number } = { live: 0, failed: 0 },
) {
  return {
    id: d.id,
    name: d.name,
    url: d.url,
    enabled: d.enabled,
    optionsSchema: d.optionsSchema ?? null,
    capabilities: shownCapabilities(d.capabilities),
    sharePublisherContact: d.sharePublisherContact,
    revision: d.revision,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    live: counts.live,
    failed: counts.failed,
  }
}

export async function listAdminDestinations(deps: Deps, p: Principal) {
  assertCan(p, 'settings:manage')
  const rows = await deps.store.listDestinations()
  return Promise.all(
    rows.map(async (d) => {
      const pubs = await deps.store.listDestinationPublicationsFor(d.id)
      return adminDto(d, {
        live: pubs.filter((x) => x.status === 'live').length,
        failed: pubs.filter((x) => x.status === 'failed').length,
      })
    }),
  )
}

export async function createDestination(deps: Deps, p: Principal, input: DestinationInput) {
  assertCan(p, 'settings:manage')
  const name = input.name ?? ''
  const url = input.url ?? ''
  checkName(name)
  checkUrl(url)
  const optionsSchema = checkSchema(input.optionsSchema)
  const { dataEncryptionKey } = await getSettings(deps)
  const secret = newSecret(deps)
  const now = deps.clock.now().toISOString()
  const row: DestinationRow = {
    id: `dst_${deps.ids.uuid().replace(/-/g, '').slice(0, 16)}`,
    name: name.trim(),
    enabled: input.enabled ?? true,
    url,
    secretEnc: encrypt(dataEncryptionKey, secret),
    optionsSchema,
    capabilities: {},
    sharePublisherContact: input.sharePublisherContact ?? false,
    revision: 1,
    createdBy: p.userId,
    createdAt: now,
    updatedAt: now,
  }
  await deps.store.insertDestination(row)
  deps.log.info('destination.created', { id: row.id, by: p.userId })
  return { ...adminDto(row), secret }
}

export async function updateDestination(deps: Deps, p: Principal, id: string, input: DestinationInput) {
  assertCan(p, 'settings:manage')
  const cur = await deps.store.getDestination(id)
  if (!cur) throw new ApiError('not_found', 'Destination not found.')
  const patch: Partial<DestinationRow> = {}
  if (input.name !== undefined) {
    checkName(input.name)
    patch.name = input.name.trim()
  }
  if (input.url !== undefined) {
    checkUrl(input.url)
    patch.url = input.url
    // A new URL may be a new receiver: what the old one said it supports no longer holds.
    if (input.url !== cur.url) patch.capabilities = {}
  }
  if (input.enabled !== undefined) patch.enabled = input.enabled
  if (input.optionsSchema !== undefined) patch.optionsSchema = checkSchema(input.optionsSchema)
  if (input.sharePublisherContact !== undefined) patch.sharePublisherContact = input.sharePublisherContact
  patch.revision = cur.revision + 1
  patch.updatedAt = deps.clock.now().toISOString()
  await deps.store.updateDestination(id, patch)
  return adminDto({ ...cur, ...patch })
}

export async function rotateDestinationSecret(deps: Deps, p: Principal, id: string) {
  assertCan(p, 'settings:manage')
  const cur = await deps.store.getDestination(id)
  if (!cur) throw new ApiError('not_found', 'Destination not found.')
  const { dataEncryptionKey } = await getSettings(deps)
  const secret = newSecret(deps)
  const updatedAt = deps.clock.now().toISOString()
  await deps.store.updateDestination(id, {
    secretEnc: encrypt(dataEncryptionKey, secret),
    revision: cur.revision + 1,
    updatedAt,
  })
  return { ...adminDto({ ...cur, revision: cur.revision + 1, updatedAt }), secret }
}

export async function deleteDestination(deps: Deps, p: Principal, id: string) {
  assertCan(p, 'settings:manage')
  const cur = await deps.store.getDestination(id)
  if (!cur) throw new ApiError('not_found', 'Destination not found.')
  const active = (await deps.store.listDestinationPublicationsFor(id)).filter((x) => x.status !== 'removed')
  if (active.length)
    throw new ApiError('conflict', 'Remove its publications first (Remove from everywhere), then delete it.')
  await deps.store.deleteDestination(id)
}

/** Sends a ping; stores the capabilities it reports (dropping invalid fields). */
export async function testDestination(deps: Deps, p: Principal, id: string) {
  assertCan(p, 'settings:manage')
  const cur = await deps.store.getDestination(id)
  if (!cur) throw new ApiError('not_found', 'Destination not found.')
  const r = await pingDestination(deps, cur)
  if (r.ok && r.capabilities) {
    await deps.store.updateDestination(id, {
      capabilities: { ...r.capabilities, nextCheckAt: later(deps, CHECK_EVERY_MS) },
      updatedAt: deps.clock.now().toISOString(),
    })
  }
  deps.log.info('destination.test', { id, ok: r.ok, status: r.status })
  return r
}

const CHECK_EVERY_MS = 3600_000
const CHECK_AGAIN_MS = 5 * 60_000
const later = (deps: Pick<Deps, 'clock'>, ms: number) =>
  new Date(deps.clock.now().getTime() + ms).toISOString()

/**
 * The sweep's part: asks each enabled destination what it supports (existing targets, instructions and their
 * wording), hourly, and within a minute of being added or pointed at a new URL. Without this the Publish dialog
 * showed neither until an admin pressed Test. A receiver that doesn't answer keeps what it last said and is asked
 * again in five minutes.
 */
export async function refreshCapabilities(
  deps: Deps,
  budget: { deadline: number },
  max = 3,
): Promise<number> {
  const now = deps.clock.now().toISOString()
  let checked = 0
  for (const d of await deps.store.listDestinations()) {
    if (checked >= max || Date.now() > budget.deadline) break
    if (!d.enabled || (d.capabilities.nextCheckAt ?? '') > now) continue
    const r = await pingDestination(deps, d, 5_000)
    await deps.store.updateDestination(d.id, {
      capabilities:
        r.ok && r.capabilities
          ? { ...r.capabilities, nextCheckAt: later(deps, CHECK_EVERY_MS) }
          : { ...d.capabilities, nextCheckAt: later(deps, CHECK_AGAIN_MS) },
    })
    if (!r.ok) deps.log.warn('destination.capabilities_failed', { id: d.id, status: r.status })
    checked++
  }
  return checked
}
