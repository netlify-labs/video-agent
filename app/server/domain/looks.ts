// Looks on the server (plan 2026-11-04-looks §4.3, §4.14): which look a new version gets, whether that's a restyle,
// which engine it renders with, and a notice when a look wasn't made for the video's shape. Catalog lookups go through
// deps.looks, so tests can change the catalog between a version and its retry.
import type { Deps } from '../deps.js'
import { ApiError } from '../lib/errors.js'
import type { LookCatalogEntry } from '../lib/looks.js'
import type { EngineId } from './engines.js'
import { lookSettings } from './look-settings.js'
import type { Aspect, VersionLook } from './types.js'

export const getLook = (deps: Pick<Deps, 'looks'>, id: string): LookCatalogEntry | null =>
  deps.looks.catalog().find((l) => l.id === id) ?? null

export type ResolvedLook =
  | { kind: 'none' }
  /** The parent's snapshot, unchanged: no copy, no restyle. */
  | { kind: 'inherit'; look: VersionLook }
  /** A catalog look's current version: a new snapshot. */
  | { kind: 'pick'; entry: LookCatalogEntry }

export interface ResolveContext {
  /** Present (null for none) when the version has a parent or source: revise, remix, render-unchanged, fit, redo. */
  inherited?: VersionLook | null
  /** The frozen plan's look (create only). */
  planLook?: string | null
  /** The admin's default look (settings.default_look). */
  defaultLook: string | null
  /** Looks an admin has turned off (settings.disabled_looks). */
  disabled: string[]
}

/**
 * The look a new version gets (§4.3's table). An explicit null is always "no look"; an explicit id must be in the
 * catalog and enabled. Omitted with a parent: the parent's value, none included (the default is never consulted).
 * Omitted on create: the plan's look, else the admin default, else none; a plan look or default that has since left
 * the catalog or been turned off falls through to the next source, so a create never fails over a setting the person
 * didn't make in this request.
 */
export function resolveLook(
  deps: Pick<Deps, 'looks' | 'log'>,
  input: { look?: string | null | undefined },
  ctx: ResolveContext,
): ResolvedLook {
  if (input.look === null) return { kind: 'none' }
  if (input.look !== undefined) {
    const entry = getLook(deps, input.look)
    if (!entry) throw new ApiError('unknown_look', `There's no look called "${input.look}".`)
    if (ctx.disabled.includes(entry.id))
      throw new ApiError('look_disabled', `An admin has turned the ${entry.name} look off.`)
    return { kind: 'pick', entry }
  }
  if (ctx.inherited !== undefined)
    return ctx.inherited ? { kind: 'inherit', look: ctx.inherited } : { kind: 'none' }
  for (const [from, id] of [
    ['plan', ctx.planLook],
    ['default', ctx.defaultLook],
  ] as const) {
    if (!id) continue
    const entry = getLook(deps, id)
    const reason = !entry ? 'unknown' : ctx.disabled.includes(id) ? 'disabled' : null
    if (!reason && entry) return { kind: 'pick', entry }
    deps.log.warn('look.fallback', { from, id, reason })
  }
  return { kind: 'none' }
}

/** The look's hash a resolution leads to (null for none). */
const hashOf = (r: ResolvedLook) =>
  r.kind === 'none' ? null : r.kind === 'inherit' ? r.look.hash : r.entry.hash

/**
 * A restyle is a version whose look snapshot differs from its parent's: another id, the same id at a newer catalog
 * hash, or a look where the parent had none. The parent's own look at the same hash isn't one, and neither is none.
 */
export function isRestyle(parent: VersionLook | null, resolved: ResolvedLook): boolean {
  const next = hashOf(resolved)
  return next !== null && next !== (parent?.hash ?? null)
}

/**
 * The engine a version renders with (§4.14): the requested one, if the look lists it and it's enabled; else the look's
 * first listed engine that's enabled; else HyperFrames.
 */
export function chooseEngine(o: {
  requestEngine?: EngineId | undefined
  look: Pick<LookCatalogEntry, 'name' | 'engines'> | null
  enabled: EngineId[]
}): EngineId {
  if (o.requestEngine) {
    if (o.look && !o.look.engines.includes(o.requestEngine))
      throw new ApiError(
        'engine_not_supported_by_look',
        `The ${o.look.name} look doesn't support the ${o.requestEngine} engine.`,
      )
    if (!o.enabled.includes(o.requestEngine))
      throw new ApiError('engine_disabled', `The ${o.requestEngine} engine is turned off on this deployment.`)
    return o.requestEngine
  }
  return o.look?.engines.find((e) => o.enabled.includes(e)) ?? 'hyperframes'
}

/** A restyle keeps the version's engine, so the new look must list it. */
export function assertLookSupportsEngine(look: Pick<LookCatalogEntry, 'name' | 'engines'>, engine: EngineId) {
  if (!look.engines.includes(engine))
    throw new ApiError(
      'engine_not_supported_by_look',
      `The ${look.name} look doesn't support the ${engine} engine.`,
    )
}

/** A note for the version when the look doesn't cover its shape; looks are never refused for it. */
export function aspectNotice(
  look: Pick<LookCatalogEntry, 'name' | 'aspects'>,
  aspect: Aspect,
): string | null {
  return look.aspects.includes(aspect) ? null : `${look.name} wasn't made for ${aspect}.`
}

/**
 * Where a look is never accepted (looks plan §4.3): an edit render, a fit to recorded narration, a scoped revision
 * (redo a scene). The regenerate-beat plan calls this with its scope.
 */
export function assertLookAllowed(o: { look?: string | null | undefined; scope?: unknown; what?: string }) {
  if (o.look === undefined) return
  if (o.scope !== undefined && o.scope !== null)
    throw new ApiError(
      'look_not_allowed',
      "Redoing a scene keeps the video's look; pick a look with a full revision.",
    )
  if (o.what) throw new ApiError('look_not_allowed', `${o.what} keeps the version's look.`)
}

/** A restyle of a version with recorded narration isn't possible yet (§4.3): its scenes must keep their exact lengths. */
export function assertRestyleAllowed(restyle: boolean, narrated: boolean) {
  if (restyle && narrated)
    throw new ApiError(
      'look_not_allowed',
      "Restyle isn't available for videos with recorded narration yet.",
      undefined,
      { status: 409 },
    )
}

/** GET /api/v1/looks (§4.9): every catalog look with whether it's on (no look is secret), and the admin default. */
export async function listLooks(deps: Pick<Deps, 'looks' | 'store'>) {
  const { defaultLook, disabledLooks } = await lookSettings(deps)
  return {
    looks: deps.looks.catalog().map((l) => ({
      id: l.id,
      name: l.name,
      description: l.description,
      tags: l.tags,
      bestFor: l.bestFor,
      aspects: l.aspects,
      engines: l.engines,
      recording: l.recording ?? null,
      hash: l.hash,
      enabled: !disabledLooks.includes(l.id),
      preview: l.preview,
    })),
    default: defaultLook,
  }
}

/**
 * The look settings as they'd be after an admin's patch (§6), checked: every id is a catalog look, the default isn't
 * turned off (nor turned off by this patch: pick another default first), and the default has an enabled engine.
 * Returns the disabled list de-duplicated in catalog order. Refusals are 400 invalid_request naming the look.
 */
export function checkLookSettings(
  deps: Pick<Deps, 'looks'>,
  current: { defaultLook: string | null; disabledLooks: string[] },
  patch: { defaultLook?: string | null | undefined; disabledLooks?: string[] | undefined },
  enabledEngines: EngineId[],
): { defaultLook: string | null; disabledLooks: string[] } {
  const catalog = deps.looks.catalog()
  const known = new Set(catalog.map((l) => l.id))
  const next = {
    defaultLook: patch.defaultLook === undefined ? current.defaultLook : patch.defaultLook,
    disabledLooks: patch.disabledLooks ?? current.disabledLooks,
  }
  for (const id of patch.disabledLooks ?? [])
    if (!known.has(id)) throw new ApiError('invalid_request', `There's no look called "${id}" to turn off.`)
  // A stored id a later deploy removed stays (harmless); only ids in this patch must exist.
  const disabledLooks = [
    ...catalog.filter((l) => next.disabledLooks.includes(l.id)).map((l) => l.id),
    ...next.disabledLooks.filter((id, i, all) => !known.has(id) && all.indexOf(id) === i),
  ]
  if (next.defaultLook !== null) {
    const entry = getLook(deps, next.defaultLook)
    if (patch.defaultLook !== undefined && !entry)
      throw new ApiError(
        'invalid_request',
        `There's no look called "${next.defaultLook}" to make the default.`,
      )
    if (entry && disabledLooks.includes(entry.id))
      throw new ApiError(
        'invalid_request',
        patch.defaultLook === undefined
          ? `${entry.name} is the default look. Pick another default first, or None.`
          : `${entry.name} is turned off, so it can't be the default.`,
      )
    if (entry && !entry.engines.some((e) => enabledEngines.includes(e)))
      throw new ApiError(
        'invalid_request',
        `${entry.name} needs an engine that's turned off, so it can't be the default.`,
      )
  }
  return { defaultLook: next.defaultLook, disabledLooks }
}
