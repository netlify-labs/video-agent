// Vendors a look's HyperFrames registry items (plan 2026-11-04-looks §4.5).
//   npm run look:vendor <id>
// For each name in looks/<id>/look.json `registry`, runs the pinned `hyperframes add <name> --json` in a temp project
// with video/hyperframes.json (the registry at the CLI's tag), copies what it wrote into looks/<id>/registry/<name>/
// and writes registry/registry.lock.json (type, upstream path, tag, licence, author, sha256 of each file). Licences
// come from scripts/lib/registry-licences.json (docs/spikes.md K4); an item not listed there is refused. Re-running
// prints what changed, so a moved upstream shows up as a diff to review.
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { sha256Hex as sha256 } from '../src/lib/crypto.js'
import { LookJsonSchema, type RegistryLock } from '../src/lib/looks.js'
import { pinnedHyperframesVersion, repoRoot } from './lib/run-tools.js'

export class LookVendorError extends Error {}

/** What `hyperframes add --json` prints. */
export interface AddResult {
  ok: boolean
  name: string
  type: string
  typeDir: string
  written: string[]
}

interface Licences {
  items: Record<string, { license: string; author: string; exclude?: string[] }>
}

export interface VendorOptions {
  repoRoot: string
  hyperframesVersion: string
  /** Runs `hyperframes add <name> --json` in `projectDir`; tests pass a fake. */
  add?: (name: string, projectDir: string) => AddResult
  licences?: Licences
}

const posix = (p: string) => p.split(sep).join('/')

function runAdd(version: string, name: string, dir: string): AddResult {
  const r = spawnSync('npx', ['--yes', `hyperframes@${version}`, 'add', name, '--json', '--no-clipboard'], {
    cwd: dir,
    encoding: 'utf8',
  })
  const start = r.stdout.indexOf('{')
  if (r.status !== 0 || start < 0)
    throw new LookVendorError(
      `hyperframes add ${name} failed (exit ${r.status}): ${(r.stderr || r.stdout).slice(-400)}`,
    )
  return JSON.parse(r.stdout.slice(start)) as AddResult
}

/** Every file under `dir` (relative, sorted), or none when it doesn't exist. */
function filesUnder(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  if (!existsSync(dir)) return out
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full)
      else out.set(posix(relative(dir, full)), sha256(readFileSync(full)))
    }
  }
  walk(dir)
  return out
}

/** Vendors the look at `lookDir`. Returns the changes as `+ path`, `~ path`, `- path` lines (empty when nothing moved). */
export function vendorLook(lookDir: string, opts: VendorOptions): string[] {
  const look = LookJsonSchema.parse(JSON.parse(readFileSync(join(lookDir, 'look.json'), 'utf8')))
  const licences =
    opts.licences ??
    (JSON.parse(
      readFileSync(join(opts.repoRoot, 'scripts', 'lib', 'registry-licences.json'), 'utf8'),
    ) as Licences)
  const unknown = look.registry.filter((n) => !licences.items[n])
  if (unknown.length)
    throw new LookVendorError(
      `No known licence for ${unknown.join(', ')}: add it to scripts/lib/registry-licences.json after reading its files upstream (docs/spikes.md K4), or replace it with a hand-written move.`,
    )
  const tag = `v${opts.hyperframesVersion}`
  const add = opts.add ?? ((name, dir) => runAdd(opts.hyperframesVersion, name, dir))
  const staged = mkdtempSync(join(tmpdir(), 'look-vendor-'))
  const lock: RegistryLock = { tag, items: [] }
  try {
    for (const name of look.registry) {
      // The real path: hyperframes reports written files by it (on macOS /var is /private/var).
      const project = realpathSync(mkdtempSync(join(tmpdir(), 'look-hf-')))
      try {
        cpSync(join(opts.repoRoot, 'video', 'hyperframes.json'), join(project, 'hyperframes.json'))
        const r = add(name, project)
        if (!r.ok || r.name !== name) throw new LookVendorError(`hyperframes add ${name} didn't install it.`)
        const type = r.type.replace(/^hyperframes:/, '')
        if (type !== 'component' && type !== 'block')
          throw new LookVendorError(`${name} is a ${r.type}, not a component or block.`)
        // Components install into compositions/components/, blocks into compositions/ (some in their own folder).
        const base = join(project, 'compositions', ...(type === 'component' ? ['components'] : []))
        const known = licences.items[name]
        if (!known) throw new LookVendorError(`No known licence for ${name}.`)
        const { license, author, exclude = [] } = known
        const files: { path: string; sha256: string }[] = []
        for (const w of r.written) {
          let rel = posix(relative(base, w))
          if (rel.startsWith('../'))
            throw new LookVendorError(`hyperframes add ${name} wrote outside its folder: ${w}`)
          if (rel.startsWith(`${name}/`)) rel = rel.slice(name.length + 1)
          if (exclude.includes(rel)) continue
          const bytes = readFileSync(w)
          mkdirSync(dirname(join(staged, name, rel)), { recursive: true })
          writeFileSync(join(staged, name, rel), bytes)
          files.push({ path: rel, sha256: sha256(bytes) })
        }
        files.sort((a, b) => (a.path < b.path ? -1 : 1))
        lock.items.push({ name, type, upstream: `registry/${r.typeDir}/${name}`, license, author, files })
      } finally {
        rmSync(project, { recursive: true, force: true })
      }
    }
    writeFileSync(join(staged, 'registry.lock.json'), JSON.stringify(lock, null, 2) + '\n')

    const target = join(lookDir, 'registry')
    const before = filesUnder(target)
    const after = filesUnder(staged)
    const changes: string[] = []
    for (const [p, h] of after) {
      const old = before.get(p)
      if (old === undefined) changes.push(`+ registry/${p}`)
      else if (old !== h) changes.push(`~ registry/${p}`)
    }
    for (const p of before.keys()) if (!after.has(p)) changes.push(`- registry/${p}`)
    rmSync(target, { recursive: true, force: true })
    cpSync(staged, target, { recursive: true })
    return changes
  } finally {
    rmSync(staged, { recursive: true, force: true })
  }
}

if (process.argv[1]?.endsWith('look-vendor.ts')) {
  const id = process.argv[2] ?? ''
  const hyperframesVersion = pinnedHyperframesVersion()
  const dir = join(repoRoot, 'looks', id)
  if (!id || !existsSync(join(dir, 'look.json'))) {
    console.error(`Usage: npm run look:vendor <id> (looks/${id}/look.json not found)`)
    process.exit(1)
  }
  const started = Date.now()
  try {
    const changes = vendorLook(dir, { repoRoot, hyperframesVersion })
    for (const c of changes) console.log(c)
    console.error(
      JSON.stringify({ step: 'look-vendor', look: id, changes: changes.length, ms: Date.now() - started }),
    )
    console.log(changes.length ? `Vendored looks/${id}/registry: review the changes above.` : 'No changes.')
  } catch (e) {
    if (!(e instanceof LookVendorError)) throw e
    console.error(e.message)
    process.exit(1)
  }
}
