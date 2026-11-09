// check-contract's logic (scripts/check-contract.ts parses argv, prints and exits), so tests can call it directly.
// Checks video/ against editing contract v1 (plan v2 §8). With --fix it first rewrites what it can:
//   - no scope: the music's ducking lane (data-va-duck) under the voices and the narration's speech, which a run with
//     locked narration can't edit by hand (plan 2026-11-02 §6.4);
//   - a scoped revision (redo a scene, docs/plans/2026-11-04-regenerate-beat.md §4.9): the splice, which re-lays the
//     scenes and puts back everything outside the scope, saying what it put back.
// With a recorded narration bus in video/ the composition must also last as long as the bus. With recording scenes, the
// recording check runs too (scripts/lib/recording-inputs.ts).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyDucking, load, NARRATION_SRC, save, validate, type Summary } from '../../app/server/lib/contract.js'
import { readPcm16 } from '../../app/server/lib/narration-cleanup.js'
import { FROZEN_DIR } from '../../app/server/lib/revoice.js'
import { isEngineId } from '../../app/server/domain/engines.js'
import { runEngineFor } from './engines/index.js'
import { checkRecordingScenes, hasRecording } from './recording-inputs.js'
import { log } from './run-tools.js'

/** --fix, or its old name --duck. */
export const fixFlag = (argv: readonly string[]) => argv.includes('--fix') || argv.includes('--duck')

export interface CheckResult {
  lines: string[]
  code: 0 | 1
}

/** The scope from .render/run-manifest.json, and its engine; null without one. */
function scopeOf(root: string): { beats: string[]; engine: string } | null {
  const path = join(root, '.render', 'run-manifest.json')
  if (!existsSync(path)) return null
  const m = JSON.parse(readFileSync(path, 'utf8')) as {
    scope?: { beats?: unknown }
    engine?: { id?: unknown }
  }
  const beats = m.scope?.beats
  if (!Array.isArray(beats)) return null
  return {
    beats: beats.filter((b): b is string => typeof b === 'string'),
    engine: typeof m.engine?.id === 'string' ? m.engine.id : 'hyperframes',
  }
}

export function checkContract(root: string, opts: { fix: boolean }): CheckResult {
  const dir = join(root, 'video')
  const indexPath = join(dir, 'index.html')
  const summaryPath = join(dir, 'summary.json')
  const lines: string[] = []
  const scope = scopeOf(root)

  if (scope) {
    const frozen = join(root, FROZEN_DIR)
    if (!existsSync(join(frozen, 'index.html')))
      return {
        lines: ['The frozen copy of the parent is missing (prepare-run makes it). Stop and report this.'],
        code: 1,
      }
    const engine = isEngineId(scope.engine) ? runEngineFor(scope.engine) : null
    if (!engine?.scopeCheck)
      return { lines: ["This video's engine can't redo scenes one by one. Stop and report this."], code: 1 }
    const started = Date.now()
    const r = engine.scopeCheck(frozen, dir, scope.beats) as ReturnType<
      NonNullable<typeof engine.scopeCheck>
    > & {
      putBack?: string[]
      lengthDelta?: number
    }
    const putBack = r.putBack ?? []
    log('scope.splice', {
      beats: scope.beats,
      lengthDelta: r.lengthDelta ?? null,
      putBack: putBack.length,
      problems: r.problems.length - putBack.length,
      ms: Date.now() - started,
    })
    let wrote = false
    if (opts.fix && r.files)
      for (const [name, bytes] of r.files) {
        const path = join(dir, name)
        const text = new TextDecoder().decode(bytes)
        if (!existsSync(path) || readFileSync(path, 'utf8') !== text) {
          writeFileSync(path, text)
          wrote = true
        }
      }
    for (const p of putBack) {
      log('scope.put_back', { what: p })
      lines.push(
        opts.fix ? `Put back: ${p}` : `- ${p} (npx tsx scripts/check-contract.ts --fix puts it back)`,
      )
    }
    const remaining = r.problems.filter((p) => !putBack.includes(p))
    for (const p of remaining) {
      log('scope.problem', { what: p })
      lines.push(`- ${p}`)
    }
    if (putBack.length || remaining.length) {
      if (opts.fix && putBack.length)
        lines.push(
          'Run it again after fixing the rest; if a change belongs outside these scenes, say so in your summary.',
        )
      return { lines, code: 1 }
    }
    if (wrote) lines.push('Re-laid the scenes and synced the captions and ducking.')
  }

  let html = readFileSync(indexPath, 'utf8')
  if (opts.fix && !scope) {
    const d = load(html)
    applyDucking(d)
    const ducked = save(d)
    if (ducked !== html) {
      writeFileSync(indexPath, ducked)
      html = ducked
      lines.push("Rewrote the music's ducking lane.")
    }
  }
  let summary: Summary | undefined
  if (existsSync(summaryPath)) {
    try {
      summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as Summary
    } catch {
      return { lines: [...lines, 'video/summary.json is not valid JSON.'], code: 1 }
    }
  }
  const bus = join(dir, NARRATION_SRC)
  let busSamples: number | null
  try {
    busSamples = existsSync(bus) ? readPcm16(readFileSync(bus)).samples.length : null
  } catch {
    return { lines: [...lines, `video/${NARRATION_SRC} isn't a 24 kHz PCM16 WAV.`], code: 1 }
  }
  const violations = validate(html, summary, busSamples === null ? {} : { narration: { busSamples } })
  // Recording scenes: what their slots name (data files, locked hidden areas, holds), on every invocation.
  if (hasRecording(html))
    for (const p of checkRecordingScenes(root, html))
      violations.push(`${p.scene === '*' ? 'Recording' : `Scene "${p.scene}"`} (${p.rule}): ${p.message}`)
  if (violations.length) return { lines: [...lines, ...violations.map((v) => `- ${v}`)], code: 1 }
  lines.push(scope ? `Contract v1: OK (scope: ${scope.beats.join(', ')})` : 'Contract v1: OK')
  return { lines, code: 0 }
}
