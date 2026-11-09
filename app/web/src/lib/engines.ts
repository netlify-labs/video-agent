// Render engines in the UI (render-engines plan §7): what each engine can make, from GET /api/v1/engines. Fetched only
// when the config lists the 'engines' feature (another engine is on here); otherwise HyperFrames alone, with no request,
// so nothing about other engines renders.
import { $api } from '../api/client'
import type { components } from '../api/schema'

export type EngineId = components['schemas']['Engine']['id']
export type EngineListing = components['schemas']['Engine']
type Capabilities = EngineListing['capabilities']

const NAMES: Record<EngineId, string> = { hyperframes: 'HyperFrames', remotion: 'Remotion' }

export const engineName = (id: EngineId): string => NAMES[id]

/** The engines offered here: HyperFrames only, without a request, unless the 'engines' feature is listed. */
export function useEngines(): { engines: EngineListing[] | null; enabled: EngineId[] } {
  const config = $api.useQuery('get', '/api/v1/config', {}, { staleTime: 60_000 })
  const on = config.data?.features.includes('engines') === true
  const list = $api.useQuery('get', '/api/v1/engines', {}, { enabled: on, staleTime: 60_000 })
  const engines = on ? (list.data?.items ?? null) : null
  return { engines, enabled: engines ? engines.filter((e) => e.enabled).map((e) => e.id) : ['hyperframes'] }
}

/**
 * The engine a create would use (the server's rule, looks plan §4.14): the one asked for, else the look's first
 * enabled engine, else HyperFrames.
 */
export function resolveEngine(
  look: { engines: EngineId[] } | null,
  enabled: EngineId[],
  asked?: EngineId | null,
): EngineId {
  // A choice counts only while it's still possible: on here, and listed by the look (a look change can rule it out).
  if (asked && enabled.includes(asked) && (!look || look.engines.includes(asked))) return asked
  return look?.engines.find((e) => enabled.includes(e)) ?? 'hyperframes'
}

/** What an engine can make, from the listing; HyperFrames' full set when there's no listing (only it is on). */
export function capabilitiesOf(engines: EngineListing[] | null, id: EngineId): Capabilities | null {
  return engines?.find((e) => e.id === id)?.capabilities ?? null
}

/** The Sound choices an engine allows: 'music' engines have no Music + effects (§4.1). */
export function soundsFor(c: Pick<Capabilities, 'sound'> | null): ('silent' | 'music' | 'music_sfx')[] {
  if (!c || c.sound === 'all') return ['silent', 'music', 'music_sfx']
  return c.sound === 'music' ? ['silent', 'music'] : ['silent']
}
