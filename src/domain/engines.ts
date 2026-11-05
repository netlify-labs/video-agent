// Render engines (docs/plans/2026-11-04-render-engines.md §4.1): the one place that names an engine and what it
// supports, so REST, MCP, the UI and the other plans agree. Pure TypeScript with no HyperFrames or Remotion imports,
// so the app build and Functions never depend on either package. Phase 1 knows only HyperFrames as enabled; the
// Remotion entry exists so its capabilities are fixed in one place, and Phase 2 adds ENGINES and the admin setting.
import type { Deps } from '../deps.js'
import type { EditOp } from '../lib/contract.js'
import { ApiError } from '../lib/errors.js'
import { REMOTION_LICENSE_NOTICE } from '../lib/remotion-notice.js'
import type { RunEngine } from '../lib/run-manifest.js'

export type EngineId = 'hyperframes' | 'remotion'

export const ENGINE_IDS = ['hyperframes', 'remotion'] as const satisfies readonly EngineId[]

export function isEngineId(x: unknown): x is EngineId {
  return typeof x === 'string' && (ENGINE_IDS as readonly string[]).includes(x)
}

/** Op names: the contract's EditOp union plus the ops the screen-recording plan adds (span, camera, cursor, redact). */
export type EditOpName = EditOp['op'] | 'span' | 'camera' | 'cursor' | 'redact'

export interface EngineCapabilities {
  /** Ops the editor may offer on this engine. */
  editOps: EditOpName[]
  /** The editor's sandboxed preview plays drafts. */
  liveDraftPreview: boolean
  /** What Sound may be: music is a bed only; all allows music_sfx too. */
  sound: 'none' | 'music' | 'all'
  /** scripts/voice.ts per-beat lines. */
  voiceover: boolean
  /** Change a voiced line in the editor. */
  revoice: boolean
  /** Edit → Narration, fit to narration. */
  recordedNarration: boolean
  /** Redo a scene (regenerate-beat plan): true once a ScopeCheck is registered for the engine. */
  scopedRevision: boolean
  /** Screen-recording demos (screen-recording plan). */
  recording: boolean
}

export interface EngineInfo {
  id: EngineId
  /** The name people see: "HyperFrames", "Remotion". */
  name: string
  license: { kind: 'open'; spdx: 'Apache-2.0' } | { kind: 'remotion'; url: string }
  capabilities: EngineCapabilities
}

/**
 * A scoped revision's check and splice in one: the problems (anything outside `beats` that changed) and, when there
 * are none, the spliced files (the parent's, with the scoped beats' parts taken from the agent's result). render-job
 * and finalize both use these bytes, so they can't splice differently.
 */
export type ScopeCheck = (
  parent: Map<string, Uint8Array>,
  agent: Map<string, Uint8Array>,
  beats: string[],
) => { problems: string[]; files: Map<string, Uint8Array> | null }

// Editing contract v1's eight ops. A Record keyed by every op, so a new EditOp that isn't listed fails the typecheck.
const CONTRACT_OPS: Record<EditOp['op'], true> = {
  text: true,
  retime: true,
  reorder: true,
  delete: true,
  color: true,
  media: true,
  audio: true,
  voice: true,
}

/** Every op name an engine may list, for the API schema: the contract's eight, then the screen-recording plan's. */
export const EDIT_OP_NAMES = [
  ...(Object.keys(CONTRACT_OPS) as EditOp['op'][]),
  'span',
  'camera',
  'cursor',
  'redact',
] as const satisfies readonly EditOpName[]

const scopeChecks = new Map<EngineId, ScopeCheck>()

/** The regenerate-beat plan registers HyperFrames' check here; scopedRevision follows it. */
export function registerScopeCheck(id: EngineId, check: ScopeCheck): void {
  scopeChecks.set(id, check)
}

/** Tests only: forget every registered check. */
export function resetScopeChecks(): void {
  scopeChecks.clear()
}

export function scopeCheckFor(id: EngineId): ScopeCheck | null {
  return scopeChecks.get(id) ?? null
}

function capabilities(id: EngineId): EngineCapabilities {
  const scopedRevision = scopeChecks.has(id)
  if (id === 'hyperframes')
    return {
      // The contract's ops, then the recording scenes' (screen-recording plan §5.3).
      editOps: [...(Object.keys(CONTRACT_OPS) as EditOpName[]), 'span', 'camera', 'cursor', 'redact'],
      liveDraftPreview: true,
      sound: 'all',
      voiceover: true,
      revoice: true,
      recordedNarration: true,
      scopedRevision,
      recording: true,
    }
  // Remotion as Phase 2 builds it (§4.1's table): authoring with a music bed, not yet editable.
  return {
    editOps: [],
    liveDraftPreview: false,
    sound: 'music',
    voiceover: false,
    revoice: false,
    recordedNarration: false,
    scopedRevision,
    recording: false,
  }
}

export function engineInfo(id: EngineId): EngineInfo {
  if (id === 'hyperframes')
    return {
      id,
      name: 'HyperFrames',
      license: { kind: 'open', spdx: 'Apache-2.0' },
      capabilities: capabilities(id),
    }
  return {
    id,
    name: 'Remotion',
    license: { kind: 'remotion', url: 'https://www.remotion.dev/docs/license' },
    capabilities: capabilities(id),
  }
}

/** Whether this deployment lists Remotion in ENGINES: the only thing that makes any Remotion UI appear (§7). */
export const remotionConfigured = (deps: Pick<Deps, 'config'>) => deps.config.engines.includes('remotion')

/**
 * Engines enabled for new videos (§7): HyperFrames always; Remotion only when ENGINES lists it, an admin switched it
 * on and recorded a license tier, and a Company License has its key set.
 */
export async function enabledEngines(deps: Pick<Deps, 'config' | 'store'>): Promise<EngineInfo[]> {
  const out = [engineInfo('hyperframes')]
  if (!remotionConfigured(deps)) return out
  const s = await deps.store.getSettings()
  const ack = s?.remotionLicenseAck ?? null
  if (s?.remotionEnabled && ack && (ack.tier === 'free' || deps.config.remotionKeySet))
    out.push(engineInfo('remotion'))
  return out
}

/** A version's engine; a row written before engines existed is HyperFrames. */
export const engineOf = (v: { engine?: EngineId | undefined } | null | undefined): EngineId =>
  v?.engine ?? 'hyperframes'

/**
 * A video's engine never changes (render-engines plan §4.2): revisions, remixes, edit renders and incorporated
 * feedback take their parent's. Only a bug can get here, so it's logged as an error and refused.
 */
export function assertSameEngine(
  deps: Pick<Deps, 'log'>,
  parent: { jobId: string; n: number; engine?: EngineId | undefined },
  child: { jobId: string; n: number; engine?: EngineId | undefined },
): void {
  const [want, got] = [engineOf(parent), engineOf(child)]
  if (want === got) return
  deps.log.error('engine.mismatch', {
    jobId: child.jobId,
    n: child.n,
    parentN: parent.n,
    parentEngine: want,
    engine: got,
  })
  throw new ApiError(
    'engine_mismatch',
    `Version ${child.n} would be made with ${engineInfo(got).name}, but it comes from a ${engineInfo(want).name} version. A video keeps one engine.`,
  )
}

/**
 * Refuses what an engine can't make yet (render-engines plan §4.2, §6): 409 engine_unsupported, naming the capability.
 * Called with what the version would actually get (the request's choices, the plan's and the parent's), so a Remotion
 * video can't end up with sound effects, a voice-over or recorded narration by any route.
 */
export function assertCapabilities(
  id: EngineId,
  want: { sound?: string | null | undefined; voiceover?: unknown; recordedNarration?: boolean | undefined },
): void {
  const { name, capabilities: c } = engineInfo(id)
  const refuse = (capability: string, what: string) => {
    throw new ApiError('engine_unsupported', `${name} videos can't have ${what} yet.`, { capability })
  }
  if (want.sound === 'music_sfx' && c.sound !== 'all')
    refuse('sound', 'sound effects (choose music or silent)')
  if (want.sound && want.sound !== 'silent' && c.sound === 'none') refuse('sound', 'sound')
  if (want.voiceover && !c.voiceover) refuse('voiceover', 'a voice-over')
  if (want.recordedNarration && !c.recordedNarration) refuse('recordedNarration', 'recorded narration')
}

/**
 * A run's engine entry for its manifest (render-engines plan §4.2), or why this deployment can't run it (§7). Remotion
 * needs ENGINES to list it (or the run can't install it), a recorded license tier (which picks the key the render
 * reports with) and, for a Company License, its key. The admin switch isn't checked: turning Remotion off stops new
 * videos only, and never strands work on existing ones. HyperFrames: no entry, so its manifests keep their bytes.
 */
export async function runEngineEntry(
  deps: Pick<Deps, 'config' | 'store'>,
  id: EngineId,
): Promise<{ engine: RunEngine | undefined } | { unavailable: string }> {
  if (id === 'hyperframes') return { engine: undefined }
  if (!remotionConfigured(deps))
    return {
      unavailable:
        "Remotion isn't installed on this deployment (ENGINES doesn't include remotion). An admin can add it back, then retry.",
    }
  const ack = (await deps.store.getSettings())?.remotionLicenseAck ?? null
  if (!ack)
    return {
      unavailable:
        'No Remotion license is recorded on this deployment. An admin can record one in Admin, then retry.',
    }
  if (ack.tier === 'company' && !deps.config.remotionKeySet)
    return {
      unavailable:
        "VIDEO_AGENT_REMOTION_KEY isn't set, and this deployment's Remotion license is a Company License. Set it on the project, then retry.",
    }
  return {
    engine: { id, tier: ack.tier, ...(deps.config.remotionDevelopmentRenders ? { development: true } : {}) },
  }
}

/** What a Remotion video costs over a HyperFrames one, in credits, once the POC measures it (E1); null until then. */
export const REMOTION_EXTRA_CREDITS: number | null = null

export interface EngineListing extends EngineInfo {
  enabled: boolean
  /** What anyone choosing it is told (Remotion's license notice); null for HyperFrames. */
  notice: string | null
  extraCredits: number | null
}

/**
 * The engines people can choose from here (GET /api/v1/engines): HyperFrames always, Remotion only when ENGINES lists
 * it, with whether it's on, its license notice and its extra cost. Never the admin's license record.
 */
export async function listEngines(deps: Pick<Deps, 'config' | 'store'>): Promise<EngineListing[]> {
  const on = new Set((await enabledEngines(deps)).map((e) => e.id))
  const out: EngineListing[] = [
    { ...engineInfo('hyperframes'), enabled: true, notice: null, extraCredits: null },
  ]
  if (remotionConfigured(deps))
    out.push({
      ...engineInfo('remotion'),
      enabled: on.has('remotion'),
      notice: REMOTION_LICENSE_NOTICE,
      extraCredits: REMOTION_EXTRA_CREDITS,
    })
  return out
}
