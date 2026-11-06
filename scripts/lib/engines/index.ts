// Picks the run engine: the one the run manifest names (render-engines plan §4.2), HyperFrames when it names none.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isEngineId, type EngineId } from '../../../src/domain/engines.js'
import { log as runLog, StepError } from '../run-tools.js'
import { hyperframesEngine } from './hyperframes.js'
import { remotionEngine } from './remotion.js'
import type { RenderReport, RunEngine } from './types.js'

const RUN_ENGINES: Record<EngineId, () => RunEngine> = {
  hyperframes: () => hyperframesEngine(),
  remotion: () => remotionEngine(),
}

export function runEngineFor(id: EngineId): RunEngine {
  // An id from a manifest this code doesn't know never falls back to another engine's install.
  const make = (RUN_ENGINES as Partial<Record<string, () => RunEngine>>)[id]
  if (!make) throw new StepError(`The run manifest names an unknown engine (${id}). Stop and report this.`)
  return make()
}

/** The engine for this attempt from .render/run-manifest.json; HyperFrames without one, or one for another attempt. */
export function runEngineIdFromManifest(root: string, attempt: string): EngineId {
  const path = join(root, '.render', 'run-manifest.json')
  if (!existsSync(path)) return 'hyperframes'
  const m = JSON.parse(readFileSync(path, 'utf8')) as { attemptId?: unknown; engine?: { id?: unknown } }
  if (m.attemptId !== attempt || m.engine === undefined) return 'hyperframes'
  const id = m.engine.id
  if (!isEngineId(id)) throw new StepError(`The run manifest names an unknown engine (${String(id)}).`)
  return id
}

/** What render-job's manifest says about the engine: next to `tools.hyperframes`, which stays for older readers. */
export function engineReport(
  engine: Pick<RunEngine, 'id'>,
  version: string,
  report: RenderReport,
): { id: EngineId; version: string; renders?: NonNullable<RenderReport['renders']> } {
  return { id: engine.id, version, ...(report.renders ? { renders: report.renders } : {}) }
}

/**
 * An engine with its own checks (Remotion) must pass them before anything renders (render-engines plan §5.1); its
 * errors stop render-job with engine_check_failed and the command that shows them. HyperFrames has none here.
 */
export async function checkBeforeRender(
  engine: Pick<RunEngine, 'check'>,
  videoDir: string,
  log: typeof runLog = runLog,
): Promise<void> {
  if (!engine.check) return
  const checked = await engine.check(videoDir)
  if (checked.errors.length)
    throw new StepError(
      `engine_check_failed: run npx tsx scripts/engine.ts check and fix:\n- ${checked.errors.join('\n- ')}`,
    )
  log('engine.check_ok', { warnings: checked.warnings.length })
}
