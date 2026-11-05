// The browser half of look:check (plan 2026-11-04-looks §9): the look's example in a temp HyperFrames project with
// video/'s vendor files and config, through the pinned `hyperframes check` (lint, runtime, layout, motion, contrast).
// CI only: the Netlify build has no browser, so it runs `look:check --static`.
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export class NoBrowserError extends Error {}

interface Finding {
  code?: string
  severity?: string
  message?: string
}
type Report = { browserSkipped?: boolean } & Record<string, unknown>

/** The error findings of a `hyperframes check --json` report, as `hyperframes check: <section> <code>: <message>`. */
export function reportProblems(report: Report): string[] {
  if (report.browserSkipped) throw new NoBrowserError('hyperframes check found no browser.')
  const out: string[] = []
  for (const [section, value] of Object.entries(report)) {
    const findings = (value as { findings?: unknown } | null)?.findings
    if (!Array.isArray(findings)) continue
    for (const f of findings as Finding[])
      if (f.severity === 'error')
        out.push(`hyperframes check: ${section} ${f.code ?? ''}: ${f.message ?? ''}`.trim())
  }
  return out
}

export interface BrowserCheckOptions {
  repoRoot: string
  hyperframesVersion: string
  /** Runs the check; tests pass a fake. Returns the parsed --json report. */
  run?: (projectDir: string) => Report
}

function runHyperframes(version: string, dir: string): Report {
  const r = spawnSync('npx', ['--yes', `hyperframes@${version}`, 'check', '--json', '.'], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const start = r.stdout.indexOf('{')
  if (start < 0)
    throw new Error(`hyperframes check printed no report (exit ${r.status}): ${r.stderr.slice(-400)}`)
  return JSON.parse(r.stdout.slice(start)) as Report
}

/** Problems hyperframes check finds in the example of the look folder `dir`. Throws NoBrowserError without Chrome. */
export function checkLookBrowser(dir: string, opts: BrowserCheckOptions): string[] {
  const project = mkdtempSync(join(tmpdir(), 'look-hf-'))
  try {
    cpSync(join(dir, 'example'), project, { recursive: true })
    for (const f of ['vendor', 'hyperframes.json', 'package.json'])
      cpSync(join(opts.repoRoot, 'video', f), join(project, f), { recursive: true })
    const report = (opts.run ?? ((p) => runHyperframes(opts.hyperframesVersion, p)))(project)
    return reportProblems(report)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
}
