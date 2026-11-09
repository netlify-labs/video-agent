// HyperFrames as a run engine: thin wrappers over the commands render-job ran before engines existed, with the same
// messages, so a HyperFrames run behaves exactly as it did.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compositionFiles } from '../../../app/server/lib/bundle-manifest.js'
import { validate, type Summary } from '../../../app/server/lib/contract.js'
import { hyperframesScopeCheck, SCOPE_LAYOUT_FILE } from '../../../app/server/lib/scope.js'
import { RenderProgressReporter } from '../render-progress.js'
import { run, runStreaming } from '../run-tools.js'
import type { RunEngine } from './types.js'

/** The commands it runs, injectable so tests don't spawn npx. */
export interface Exec {
  run: typeof run
  runStreaming: typeof runStreaming
}

export function hyperframesEngine(exec: Exec = { run, runStreaming }): RunEngine {
  return {
    id: 'hyperframes',
    entryProblems: (videoDir) =>
      existsSync(join(videoDir, 'index.html'))
        ? []
        : ['video/index.html does not exist. Write the composition first.'],
    contract(videoDir) {
      // Editing contract v1 (plan v2 §8): a composition that declares it must keep it, or the editor can't open it.
      const html = readFileSync(join(videoDir, 'index.html'), 'utf8')
      if (!/data-va-contract\s*=\s*["']1["']/.test(html)) return null
      let summary: Summary | undefined
      try {
        summary = JSON.parse(readFileSync(join(videoDir, 'summary.json'), 'utf8')) as Summary
      } catch {
        summary = undefined
      }
      const violations = validate(html, summary)
      if (violations.length)
        return [
          `The composition breaks the editing contract (see "Editing contract v1" in video/AGENTS.md):\n- ${violations.join('\n- ')}`,
        ]
      if (/data-va-revoice/.test(html))
        return [
          'Some narration lines are still marked for re-voicing (data-va-revoice). Run npx tsx scripts/voice.ts revoice first.',
        ]
      return []
    },
    async render(videoDir, out, quality, onProgress) {
      // Its machine lines (@hf-progress) carry the percent; render-job decides which ones to report.
      const lines = new RenderProgressReporter(onProgress, Date.now, 0, 1)
      // A screen recording's frames are extracted as PNG: the default (JPEG) rings around text, which a zoom magnifies.
      const index = join(videoDir, 'index.html')
      const recording = existsSync(index) && /class="[^"]*\bva-recording\b/.test(readFileSync(index, 'utf8'))
      const frames = recording ? ['--video-frame-format', 'png'] : []
      await exec.runStreaming(
        'npx',
        ['-y', 'hyperframes', 'render', '--quality', quality, ...frames, '--output', out],
        {
          cwd: videoDir,
          timeoutMs: 20 * 60_000,
          onOutput: (chunk) => {
            lines.line(chunk)
          },
        },
      )
      lines.end()
      return {}
    },
    // Redo a scene: the splice and every check, over the frozen parent and video/ (app/server/lib/scope.ts).
    scopeCheck: (frozenDir, dir, beats) => {
      // The frozen copy also holds prepare-run's scope.json, which isn't one of the parent's files.
      const parent = filesOf(frozenDir)
      parent.delete(SCOPE_LAYOUT_FILE)
      return hyperframesScopeCheck(parent, filesOf(dir), beats)
    },
    version: (videoDir) =>
      exec.run('npx', ['-y', 'hyperframes', '--version'], { cwd: videoDir }).trim().split('\n').pop() ?? '',
  }
}

/** A composition's files as bytes, with the same exclusions as its bundle (no caches, renders, feedback stills). */
export function filesOf(dir: string): Map<string, Uint8Array> {
  return new Map(compositionFiles(dir).map((p) => [p, readFileSync(join(dir, p))]))
}
