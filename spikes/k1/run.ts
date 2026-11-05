// Spike K1 (docs/plans/2026-11-04-looks.md §10): can each starter-set registry block be inlined into a contract beat?
//   npx tsx spikes/k1/run.ts [--render] [case…]
// Each case is spikes/k1/cases/<name>/ with index.html, summary.json and edits.json (the editor's ops: a text edit and
// a retime, as EditOp[]). For each case: contract validate → hyperframes check → applyEdits (exactly what the editor
// and the server apply) → validate and hyperframes check again → with --render, render both versions (draft) to
// spikes/out/k1/. One JSON line per step ({step, case, ok, ms, problem}); results to cases/<name>/result.json.
// A case's compositions/ folder (a mounted sub-composition) is copied into the project next to index.html.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyEdits, validate, type EditOp, type Summary } from '../../src/lib/contract.js'

const root = new URL('../..', import.meta.url).pathname
const casesDir = join(root, 'spikes', 'k1', 'cases')
const outDir = join(root, 'spikes', 'out', 'k1')
const VERSION = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  netlifyAgent: { hyperframes: { version: string } }
}).netlifyAgent.hyperframes.version

const args = process.argv.slice(2)
const render = args.includes('--render')
const only = args.filter((a) => !a.startsWith('--'))
const cases = (only.length ? only : readdirSync(casesDir).sort()).filter((c) => existsSync(join(casesDir, c, 'index.html')))

const log = (f: Record<string, unknown>) => console.log(JSON.stringify(f))

/** The case's own extra files (compositions/, assets/) in the temp project. */
function project(c: string, dir: string) {
  for (const extra of ['compositions', 'assets'])
    if (existsSync(join(casesDir, c, extra))) cpSync(join(casesDir, c, extra), join(dir, extra), { recursive: true })
}

interface Finding {
  code?: string
  severity?: string
  message?: string
  selector?: string
}

function hfCheck(c: string, html: string, summary: Summary): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'k1-'))
  try {
    project(c, dir)
    writeFileSync(join(dir, 'index.html'), html)
    writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2))
    for (const f of ['vendor', 'hyperframes.json', 'package.json']) cpSync(join(root, 'video', f), join(dir, f), { recursive: true })
    const r = spawnSync('npx', ['--yes', `hyperframes@${VERSION}`, 'check', '--json', '.'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20 })
    const report = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))) as Record<string, { findings?: Finding[] }>
    const out: string[] = []
    for (const [section, v] of Object.entries(report))
      for (const f of v?.findings ?? [])
        if (f.severity === 'error' || f.severity === 'warning')
          out.push(`${f.severity} ${section} ${f.code}: ${f.message} (${f.selector ?? ''})`)
    return out
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function hfRender(c: string, html: string, summary: Summary, to: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'k1-r-'))
  try {
    project(c, dir)
    writeFileSync(join(dir, 'index.html'), html)
    writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2))
    for (const f of ['vendor', 'hyperframes.json', 'package.json']) cpSync(join(root, 'video', f), join(dir, f), { recursive: true })
    mkdirSync(outDir, { recursive: true })
    const r = spawnSync('npx', ['--yes', `hyperframes@${VERSION}`, 'render', '--quality', 'draft', '--quiet', '--output', to], { cwd: dir, encoding: 'utf8' })
    return r.status === 0 && existsSync(to) ? null : `render failed (exit ${r.status}): ${(r.stderr || r.stdout).slice(-300)}`
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const results: Record<string, unknown>[] = []
for (const c of cases) {
  const dir = join(casesDir, c)
  const html = readFileSync(join(dir, 'index.html'), 'utf8')
  const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as Summary
  const edits = JSON.parse(readFileSync(join(dir, 'edits.json'), 'utf8')) as EditOp[]
  const result: Record<string, unknown> = { case: c, bytes: Buffer.byteLength(html) }
  const step = <T>(name: string, f: () => T): T => {
    const t = Date.now()
    const v = f()
    const problems = Array.isArray(v) ? (v as string[]) : []
    log({ step: name, case: c, ok: problems.length === 0, ms: Date.now() - t, problem: problems.slice(0, 5) })
    result[name] = problems
    return v
  }
  step('contract', () => validate(html, summary))
  step('hf-check', () => hfCheck(c, html, summary))
  let edited: { html: string; summary: Summary } | null = null
  step('edit', () => {
    try {
      edited = applyEdits(html, summary, edits)
      return []
    } catch (e) {
      return [e instanceof Error ? e.message : String(e)]
    }
  })
  if (edited) {
    const e = edited as { html: string; summary: Summary }
    writeFileSync(join(dir, 'edited.html'), e.html)
    step('contract-edited', () => validate(e.html, e.summary))
    step('hf-check-edited', () => hfCheck(c, e.html, e.summary))
    if (render) {
      step('render', () => {
        const p = hfRender(c, html, summary, join(outDir, `${c}.mp4`))
        return p ? [p] : []
      })
      step('render-edited', () => {
        const p = hfRender(c, e.html, e.summary, join(outDir, `${c}-edited.mp4`))
        return p ? [p] : []
      })
    }
  }
  results.push(result)
}
for (const r of results) writeFileSync(join(casesDir, String(r.case), 'result.json'), JSON.stringify(r, null, 2) + '\n')
