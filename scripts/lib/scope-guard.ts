// render-job's scope guard for a scoped revision (redo a scene, docs/plans/2026-11-04-regenerate-beat.md §4.9): before
// anything is validated or rendered, the engine's scope check runs over the frozen parent and video/. Any problem stops
// the render with scope_violated; otherwise the splice's index.html and summary.json are written into video/, so the
// render, the archive and the uploaded hashes are exactly what was checked. It runs before the contract validate (which
// would otherwise fail on stale derived values with less useful messages) and apart from the narration guards, so a
// scoped revision of a narrated parent gets both.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compositionFiles } from '../../app/server/lib/bundle-manifest.js'
import { FROZEN_DIR } from '../../app/server/lib/revoice.js'
import type { RunManifest } from '../../app/server/lib/run-manifest.js'
import { SCOPE_LAYOUT_FILE, SCOPE_VIOLATED } from '../../app/server/lib/scope.js'
import type { RunEngine } from './engines/types.js'
import { log, StepError } from './run-tools.js'

/** Null when this attempt has no scope; otherwise what was verified. Throws StepError on any problem. */
export function scopeGuard(
  root: string,
  attempt: string,
  engine: Pick<RunEngine, 'id' | 'scopeCheck'>,
): { beats: string[]; lengthDelta: number | null; newFiles: string[] } | null {
  const manifestPath = join(root, '.render', 'run-manifest.json')
  if (!existsSync(manifestPath)) return null
  const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as RunManifest
  if (m.attemptId !== attempt || !m.scope) return null
  const started = Date.now()
  const frozen = join(root, FROZEN_DIR)
  const videoDir = join(root, 'video')
  if (!existsSync(join(frozen, 'index.html')))
    throw new StepError(
      'The frozen copy of the parent is missing (prepare-run makes it). Stop and report this.',
    )
  if (!engine.scopeCheck)
    throw new StepError(
      `${SCOPE_VIOLATED}: this video's engine (${engine.id}) can't redo scenes one by one. Stop and report this.`,
    )
  const r = engine.scopeCheck(frozen, videoDir, m.scope.beats) as ReturnType<
    NonNullable<RunEngine['scopeCheck']>
  > & {
    lengthDelta?: number
  }
  if (r.problems.length || !r.files) {
    const problems = r.problems.length ? r.problems : ["The scenes couldn't be put together."]
    for (const p of problems) log('scope.problem', { where: 'render-job', what: p })
    throw new StepError(
      `${SCOPE_VIOLATED}: ${problems[0] ?? ''}\nThis run may change only the scenes ${m.scope.beats.map((b) => `"${b}"`).join(', ')}.\n- ${problems.join('\n- ')}\nRun npx tsx scripts/check-contract.ts --fix, put those parts back, and run render-job again.`,
    )
  }
  for (const [name, bytes] of r.files) writeFileSync(join(videoDir, name), bytes)
  const parent = new Set(compositionFiles(frozen))
  const newFiles = compositionFiles(videoDir).filter((p) => !parent.has(p) && p !== SCOPE_LAYOUT_FILE)
  const verified = { beats: m.scope.beats, lengthDelta: r.lengthDelta ?? null, newFiles }
  log('scope.verified', { ...verified, ms: Date.now() - started })
  return verified
}
