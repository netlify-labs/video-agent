// Render engines (docs/plans/2026-11-04-render-engines.md §4.1): the one place that names an engine and what it
// supports, so REST, MCP, the UI and the other plans agree. Pure TypeScript with no HyperFrames or Remotion imports,
// so the app build and Functions never depend on either package. Phase 1 knows only HyperFrames as enabled; the
// Remotion entry exists so its capabilities are fixed in one place, and Phase 2 adds ENGINES and the admin setting.
import type { Deps } from '../deps.js'
import type { EditOp } from '../lib/contract.js'
import { ApiError } from '../lib/errors.js'

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
      editOps: Object.keys(CONTRACT_OPS) as EditOpName[],
      liveDraftPreview: true,
      sound: 'all',
      voiceover: true,
      revoice: true,
      recordedNarration: true,
      scopedRevision,
      recording: false,
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

/**
 * Engines enabled for new videos on this deployment. Phase 1: HyperFrames only. Phase 2 adds ENGINES and the
 * admin's Remotion acknowledgment (§7); it's async now so callers don't change then.
 */
export const enabledEngines: (deps: Deps) => Promise<EngineInfo[]> = async () => [engineInfo('hyperframes')]

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
