// Picks the run engine: the one the run manifest names (render-engines plan §4.2), HyperFrames when it names none.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { engineInfo, isEngineId, type EngineId } from '../../../src/domain/engines.js'
import { StepError } from '../run-tools.js'
import { hyperframesEngine } from './hyperframes.js'
import type { RenderReport, RunEngine } from './types.js'

export function runEngineFor(id: EngineId): RunEngine {
  if (id === 'hyperframes') return hyperframesEngine()
  throw new StepError(`This run can't render ${engineInfo(id).name} videos yet. Stop and report this.`)
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
