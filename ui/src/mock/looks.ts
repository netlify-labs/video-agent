// Mock mode: the looks routes (plan 2026-11-04-looks §6), layered over installMock()'s fetch so they mirror the server
// (src/domain/looks.ts) without growing server.ts. The catalog is the real one (src/generated/looks.ts) and the
// posters and clips are the real looks/<id>/ files, bundled only into mock builds.
//
// localStorage switches, set before the app loads:
//   mockLookDefault=<id>      the admin default look
//   mockLooksDisabled=a,b     looks an admin turned off
//   mockNoLooks=1             the deployment has no looks feature (the pickers hide)
//   mockLookUpdated=<id>      that look changed since the mock's versions were made (a newer catalog hash)
import cleanMp4 from '../../../looks/clean/preview.mp4?url'
import cleanPoster from '../../../looks/clean/poster.webp?url'
import kineticMp4 from '../../../looks/kinetic/preview.mp4?url'
import kineticPoster from '../../../looks/kinetic/poster.webp?url'
import terminalMp4 from '../../../looks/terminal/preview.mp4?url'
import terminalPoster from '../../../looks/terminal/poster.webp?url'
import { looksCatalog } from '../../../src/generated/looks'
import type { Look } from '../lib/looks'
import { videos } from './data'

const PREVIEWS: Record<string, Look['preview']> = {
  clean: { mp4: cleanMp4, poster: cleanPoster },
  kinetic: { mp4: kineticMp4, poster: kineticPoster },
  terminal: { mp4: terminalMp4, poster: terminalPoster },
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const fail = (status: number, code: string, message: string) => json({ error: { code, message } }, status)

const setting = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** The admin's look settings; PATCH /api/v1/admin/settings changes them. */
export const lookSettings = {
  defaultLook: setting('mockLookDefault'),
  disabledLooks: (setting('mockLooksDisabled') ?? '').split(',').filter(Boolean),
}

export function mockLooks(): Look[] {
  return looksCatalog.map((l) => ({
    id: l.id,
    name: l.name,
    description: l.description,
    tags: l.tags,
    bestFor: l.bestFor,
    aspects: l.aspects,
    engines: l.engines,
    // The same JSON; only exactOptionalPropertyTypes tells the zod output and the OpenAPI type apart.
    recording: (l.recording ?? null) as Look['recording'],
    hash: setting('mockLookUpdated') === l.id ? `${l.hash.slice(0, -4)}beef` : l.hash,
    enabled: !lookSettings.disabledLooks.includes(l.id),
    preview: PREVIEWS[l.id] ?? { mp4: null, poster: null },
  }))
}

const ref = (l: Look) => ({ id: l.id, name: l.name, hash: l.hash })

/** The server's refusals for a picked look (resolveLook): unknown 400, turned off 409. */
function refusePick(look: unknown): Response | null {
  if (typeof look !== 'string') return null
  const entry = mockLooks().find((l) => l.id === look)
  if (!entry) return fail(400, 'unknown_look', `There's no look called "${look}".`)
  if (!entry.enabled) return fail(409, 'look_disabled', `An admin has turned the ${entry.name} look off.`)
  return null
}

/** The admin patch's checks (checkLookSettings): known ids, and the default never turned off. */
function patchSettings(b: { defaultLook?: string | null; disabledLooks?: string[] }): Response | null {
  const known = new Set(looksCatalog.map((l) => l.id))
  for (const id of b.disabledLooks ?? [])
    if (!known.has(id)) return fail(400, 'invalid_request', `There's no look called "${id}" to turn off.`)
  const next = {
    defaultLook: b.defaultLook === undefined ? lookSettings.defaultLook : b.defaultLook,
    disabledLooks: b.disabledLooks ?? lookSettings.disabledLooks,
  }
  if (next.defaultLook !== null) {
    const entry = looksCatalog.find((l) => l.id === next.defaultLook)
    if (!entry)
      return fail(400, 'invalid_request', `There's no look called "${next.defaultLook}" to make the default.`)
    if (next.disabledLooks.includes(entry.id))
      return fail(
        400,
        'invalid_request',
        b.defaultLook === undefined
          ? `${entry.name} is the default look. Pick another default first, or None.`
          : `${entry.name} is turned off; turn it on to make it the default.`,
      )
  }
  lookSettings.defaultLook = next.defaultLook
  lookSettings.disabledLooks = looksCatalog.filter((l) => next.disabledLooks.includes(l.id)).map((l) => l.id)
  return null
}

const readJson = async (init?: RequestInit, input?: RequestInfo | URL): Promise<Record<string, unknown>> => {
  try {
    if (typeof init?.body === 'string') return JSON.parse(init.body) as Record<string, unknown>
    if (input instanceof Request) return (await input.clone().json()) as Record<string, unknown>
  } catch {
    // no body
  }
  return {}
}

/** Installs the looks routes over the mock API (call after installMock). */
export function installLooksMock() {
  const inner = window.fetch.bind(window)
  const off = setting('mockNoLooks') === '1'
  window.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      window.location.origin,
    )
    const p = url.pathname
    if (!p.startsWith('/api/')) return inner(input, init)
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()

    if (p === '/api/v1/looks' && method === 'GET') {
      if (off) return fail(404, 'not_found', 'Not found.')
      await new Promise((r) => setTimeout(r, 120))
      return json({ looks: mockLooks(), default: lookSettings.defaultLook })
    }
    if (p === '/api/v1/config') {
      const res = await inner(input, init)
      const body = (await res.json()) as { features: string[] }
      return json({ ...body, features: off ? body.features : [...body.features, 'looks'] }, res.status)
    }
    if (p === '/api/v1/admin/settings') {
      if (method === 'PATCH') {
        const b = (await readJson(init, input)) as { defaultLook?: string | null; disabledLooks?: string[] }
        const refused = patchSettings(b)
        if (refused) return refused
      }
      const res = await inner(input, init)
      if (!res.ok) return res
      const body = (await res.json()) as Record<string, unknown>
      return json({ ...body, ...lookSettings })
    }

    const create = p === '/api/v1/videos' && method === 'POST'
    const revise = /^\/api\/v1\/videos\/([^/]+)\/versions$/.exec(p)
    const remix = /^\/api\/v1\/videos\/([^/]+)\/remix$/.exec(p)
    if (method !== 'POST' || !(create || revise || remix)) return inner(input, init)
    const b = await readJson(init, input)
    const refused = refusePick(b.look)
    if (refused) return refused
    if (revise?.[1] && b.look !== undefined) {
      if (b.scope !== undefined && b.scope !== null)
        return fail(
          400,
          'look_not_allowed',
          "Redoing a scene keeps the video's look; pick a look with a full revision.",
        )
      // A restyle of a version with recorded narration (assertRestyleAllowed).
      const vid = videos.find((v) => v.id === revise[1])
      const base =
        vid?.versions.find((v) => v.n === (b.fromVersion as number | undefined)) ??
        vid?.versions.find((v) => v.status === 'ready')
      const restyle = (typeof b.look === 'string' ? b.look : null) !== (base?.look?.id ?? null)
      if (restyle && base?.links.narrationAudio)
        return fail(
          409,
          'look_not_allowed',
          "Restyle isn't available for videos with recorded narration yet.",
        )
    }
    const res = await inner(input, init)
    if (!remix?.[1] || !res.ok) return res
    // The remix's version: the picked look, None, or (omitted) the source version's own.
    const made = (await res.json()) as (typeof videos)[number]
    const src = videos.find((v) => v.id === remix[1])
    const from = src?.versions.find((v) => v.n === made.remixOf?.n)
    const picked = typeof b.look === 'string' ? mockLooks().find((l) => l.id === b.look) : null
    const look = b.look === undefined ? (from?.look ?? null) : picked ? ref(picked) : null
    const stored = videos.find((v) => v.id === made.id)
    for (const v of [...made.versions, ...(stored?.versions ?? [])]) v.look = look
    return json(made, res.status)
  }
}
