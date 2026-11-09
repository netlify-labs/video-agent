// The public snapshot (docs/plans/2026-11-02-going-public.md): exports a ref of this repo with `git archive` into a
// folder, leaves out what's internal, and scans what's left for internal names, ids, private links and secrets. It
// never pushes, creates a repo or changes anyone's visibility: publishing the folder is a separate, human step.
//
//   npm run public-snapshot -- <out dir> [--ref origin/main]   # export (the folder must be new or empty), then scan
//   npm run public-snapshot -- --scan <dir>                     # scan a folder only
//
// Prints each hit as file:line, the rule and the matched text, then a summary. Exits 1 on any hit, 2 on a usage error.
// Runs `gitleaks dir` too when it's installed, and says so when it isn't.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Left out of the snapshot, as git pathspecs relative to the repo root. One entry per path, with why. */
export const EXCLUDES: readonly { path: string; why: string }[] = [
  {
    path: '.beads',
    why: 'the task tracker: reviewer emails, links to private repos and internal site names (stays in this repo)',
  },
  {
    path: 'scripts/how-we-built-it-artifact.ts',
    why: 'publishes the employees-only copy of the How we built it page',
  },
  {
    path: 'scripts/backfill-previews.ts',
    why: 'a one-off for videos rendered before preview variants existed',
  },
  { path: 'scripts/voice-samples.py', why: 'how the bundled voice samples were made, once' },
  {
    path: 'scripts/public-snapshot.ts',
    why: 'this tool: its rules spell out the internal strings it looks for',
  },
  { path: 'scripts/public-snapshot.test.ts', why: "this tool's tests, which use those strings as examples" },
  {
    path: 'docs/plans/2026-11-02-going-public.md',
    why: 'the checklist for making this snapshot; it names the internal strings too',
  },
]

export interface Rule {
  name: string
  re: RegExp
  why: string
}

/** Company names seen in the private video library; add any you know of. Matched as whole words. */
const CUSTOMERS = ['BambooHR']
/** Internal accounts, teams, people's handles and site names. */
const INTERNAL_NAMES = [
  'netliclaw',
  'DavidWells',
  'ai-on-netlify',
  'mcp-gateway',
  'workforce-check',
  'netlify-brand',
  'revenue-engine',
  'site-vendor',
  'smart-ci',
  'ops-stack',
  'agent-sessions',
]

const words = (list: readonly string[]) =>
  new RegExp(
    `(?<![\\w-])(?:${list.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w-])`,
  )

/** What a public file must not contain. Each match is a hit. */
export const RULES: readonly Rule[] = [
  { name: 'company-email', re: /[\w.+-]+@netlify\.com\b/i, why: "an employee's address" },
  {
    name: 'gtm',
    re: /\bgtm-[a-z]/i,
    why: 'an internal team, repo or site (gtm-services, gtm-engineering, …)',
  },
  { name: 'site-id', re: /3a3f4565/, why: "the production site's id" },
  { name: 'nax', re: /\bnax\s/, why: 'an internal CLI' },
  {
    name: 'netlify-id',
    re: /(?<![\w-])[0-9a-f]{24}(?![\w-])/,
    why: 'a Netlify agent run, session or deploy id (24 hex characters)',
  },
  {
    name: 'ci-run-id',
    re: /\b(?:CI )?run \d{9,}\b|\/actions\/runs\/\d+/,
    why: 'a GitHub Actions run in a private repo',
  },
  {
    name: 'private-repo',
    // The repo itself may be named in links: what it's called in public is the owner's decision (the plan's Decide).
    re: /(?<![@\w])netlify-labs\/(?!video-agent(?![\w-]))[\w.-]+/,
    why: 'a link to a private netlify-labs repo',
  },
  { name: 'internal-name', re: words(INTERNAL_NAMES), why: 'an internal account, team, person or site' },
  { name: 'customer', re: words(CUSTOMERS), why: 'a customer name' },
  {
    name: 'home-path',
    re: /\/Users\/(?!(?:runner|me|you|name|user|username)\/)[a-z][\w.-]*\//,
    why: "someone's home directory (GitHub's runner and placeholders like /Users/me/ are fine)",
  },
  {
    name: 'token',
    re: /\b(?:nva[tr]?|nfp|gh[pousr])_[A-Za-z0-9_-]{24,}|\bsk-ant-[A-Za-z0-9-]{20,}/,
    why: 'something shaped like a real token',
  },
]

/** Made-up values tests and mock data use on purpose: a run of one character, or a word that says so. */
export const isFake = (text: string) =>
  /(.)\1{7,}/.test(text) || /notareal|fake|example|abcdefghij/i.test(text)

/** Rules whose made-up values (isFake) aren't hits. */
const FAKES_ALLOWED = new Set(['netlify-id', 'token'])

export interface Hit {
  file: string
  line: number
  rule: string
  text: string
}

/** Hits in one file's text: every rule on every line. */
export function scanText(file: string, text: string): Hit[] {
  const hits: Hit[] = []
  for (const [i, line] of text.split('\n').entries())
    for (const rule of RULES) {
      const m = rule.re.exec(line)
      if (m && !(FAKES_ALLOWED.has(rule.name) && isFake(m[0])))
        hits.push({ file, line: i + 1, rule: rule.name, text: m[0] })
    }
  return hits
}

const BINARY_PROBE = 8000
const MAX_TEXT = 5 * 1024 * 1024

function* files(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* files(p)
    else if (e.isFile()) yield p
  }
}

/** Hits in every text file under `dir` (binary files and files over 5 MB are skipped). */
export function scanDir(dir: string): Hit[] {
  const hits: Hit[] = []
  for (const path of files(dir)) {
    if (statSync(path).size > MAX_TEXT) continue
    const bytes = readFileSync(path)
    if (bytes.subarray(0, BINARY_PROBE).includes(0)) continue
    hits.push(...scanText(relative(dir, path), bytes.toString('utf8')))
  }
  return hits
}

/**
 * gitleaks' findings in `dir` as hits, or null when gitleaks isn't installed. It runs inside `dir`, so paths come out
 * relative, and the snapshot's own .config/gitleaks.toml (the default rules minus the tests' fake secrets) applies.
 */
function gitleaks(dir: string): Hit[] | null {
  if (spawnSync('gitleaks', ['version'], { encoding: 'utf8' }).error) return null
  const report = join(tmpdir(), `public-snapshot-gitleaks-${process.pid}.json`)
  spawnSync(
    'gitleaks',
    [
      'dir',
      '.',
      ...(existsSync(join(dir, '.config', 'gitleaks.toml')) ? ['--config', join('.config', 'gitleaks.toml')] : []),
      '--no-banner',
      '--redact',
      '--exit-code',
      '0',
      '--report-format',
      'json',
      '--report-path',
      report,
    ],
    { cwd: dir, encoding: 'utf8' },
  )
  const found = existsSync(report)
    ? (JSON.parse(readFileSync(report, 'utf8')) as { File: string; StartLine: number; RuleID: string }[])
    : []
  rmSync(report, { force: true })
  return found.map((f) => ({
    file: f.File,
    line: f.StartLine,
    rule: `gitleaks:${f.RuleID}`,
    text: '(redacted)',
  }))
}

function exportRef(ref: string, out: string): void {
  if (existsSync(out) && readdirSync(out).length) throw new UsageError(`${out} isn't empty`)
  mkdirSync(out, { recursive: true })
  const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim()
  const pathspecs = ['.', ...EXCLUDES.map((e) => `:(exclude)${e.path}`)]
  const archive = spawnSync('git', ['archive', '--format=tar', ref, '--', ...pathspecs], {
    cwd: root,
    maxBuffer: 1024 * 1024 * 1024,
  })
  if (archive.status !== 0)
    throw new UsageError(`git archive ${ref} failed: ${archive.stderr.toString().trim()}`)
  const untar = spawnSync('tar', ['-x', '-C', out], { input: archive.stdout })
  if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr.toString().trim()}`)
  const sha = spawnSync('git', ['rev-parse', ref], { cwd: root, encoding: 'utf8' }).stdout.trim()
  console.log(`exported ${ref} (${sha.slice(0, 12)}) to ${out}, without ${EXCLUDES.length} paths`)
}

class UsageError extends Error {}

function main(argv: string[]): number {
  const flag = (name: string) => {
    const i = argv.indexOf(name)
    return i === -1 ? undefined : argv.splice(i, 2)[1]
  }
  const scanOnly = flag('--scan')
  const ref = flag('--ref') ?? 'origin/main'
  const dir = scanOnly ?? argv[0]
  if (!dir) throw new UsageError('usage: public-snapshot <out dir> [--ref <ref>] | --scan <dir>')
  if (!scanOnly) exportRef(ref, dir)

  const hits = scanDir(dir)
  const leaks = gitleaks(dir)
  if (leaks) hits.push(...leaks)
  else console.log('gitleaks: not installed, so secrets were checked only by the token rule')
  for (const h of hits) console.log(`${h.file}:${h.line}  ${h.rule}  ${h.text}`)
  const byRule = new Map<string, number>()
  for (const h of hits) byRule.set(h.rule, (byRule.get(h.rule) ?? 0) + 1)
  console.log(
    hits.length
      ? `${hits.length} hits in ${new Set(hits.map((h) => h.file)).size} files: ${[...byRule].map(([r, n]) => `${r} ${n}`).join(', ')}`
      : `clean: no hits${leaks ? ', gitleaks found nothing' : ''}`,
  )
  return hits.length ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exitCode = e instanceof UsageError ? 2 : 1
  }
}
