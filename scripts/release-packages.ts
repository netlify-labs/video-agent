// Release the public packages (cli-and-sdk plan §10; beads va-p1th.8.1, 8.2), run by .github/workflows/release.yml.
//   npx tsx scripts/release-packages.ts pack [--out <dir>]     npm pack each public package into <dir> (default
//                                                               a temp folder), with a manifest.json of names, versions,
//                                                               file counts, sizes and sha256s: the internal tarballs
//   npx tsx scripts/release-packages.ts publish --confirm       npm publish --provenance each public package whose
//                                                               version isn't on npmjs yet (trusted publishing in CI)
// Public packages are packages/* without "private". The repo has no npm workspaces (they broke Agent Runner deploys),
// so Changesets can't find the packages; versions are bumped by hand in each package.json, with a CHANGELOG.md entry.
// A tarball must hold only dist/ (plus package.json, README, LICENSE): anything else fails before publishing.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { repoRoot } from './lib/run-tools.js'

export interface PublicPackage {
  dir: string
  name: string
  version: string
}

export function publicPackages(root = repoRoot): PublicPackage[] {
  return readdirSync(join(root, 'packages'))
    .sort()
    .map((d) => join(root, 'packages', d))
    .filter((dir) => existsSync(join(dir, 'package.json')))
    .map((dir) => ({
      dir,
      pkg: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>,
    }))
    .filter(({ pkg }) => !pkg.private)
    .map(({ dir, pkg }) => ({ dir, name: String(pkg.name), version: String(pkg.version) }))
}

/** A file a public tarball may hold. */
export const ALLOWED = /^(package\.json|README(\.md)?|LICENSE(\.md)?|CHANGELOG\.md|dist\/.+)$/

interface PackResult {
  filename: string
  size: number
  files: { path: string }[]
}

function pack(dir: string, out: string): PackResult {
  const raw = execFileSync('npm', ['pack', '--json', '--pack-destination', out], {
    cwd: dir,
    encoding: 'utf8',
  })
  const [r] = JSON.parse(raw) as PackResult[]
  if (!r) throw new Error(`npm pack wrote nothing in ${dir}`)
  const stray = r.files.map((f) => f.path).filter((p) => !ALLOWED.test(p))
  if (stray.length) throw new Error(`${dir}: files outside dist/ in the tarball: ${stray.join(', ')}`)
  return r
}

const log = (step: string, f: Record<string, unknown> = {}) => console.log(JSON.stringify({ step, ...f }))

function main() {
  const [cmd, ...args] = process.argv.slice(2)
  const flag = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined)
  const packages = publicPackages()
  if (cmd === 'pack') {
    // Absolute: npm pack runs in each package's folder.
    const out = resolve(flag('out') ?? join(tmpdir(), 'video-agent-release'))
    mkdirSync(out, { recursive: true })
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    const tarballs = packages.map((p) => {
      const r = pack(p.dir, out)
      const sha256 = createHash('sha256')
        .update(readFileSync(join(out, r.filename)))
        .digest('hex')
      log('packed', {
        name: p.name,
        version: p.version,
        file: r.filename,
        files: r.files.length,
        bytes: r.size,
      })
      return {
        name: p.name,
        version: p.version,
        file: r.filename,
        files: r.files.length,
        bytes: r.size,
        sha256,
      }
    })
    writeFileSync(join(out, 'manifest.json'), `${JSON.stringify({ commit, tarballs }, null, 2)}\n`)
    return
  }
  if (cmd === 'publish') {
    if (!args.includes('--confirm')) throw new Error('publish needs --confirm')
    for (const p of packages) {
      let seen = ''
      try {
        seen = execFileSync('npm', ['view', `${p.name}@${p.version}`, 'version', '--prefer-online'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
      } catch {
        // E404: not published yet.
      }
      if (seen === p.version) {
        log('skipped', { name: p.name, version: p.version, reason: 'already on npmjs' })
        continue
      }
      pack(p.dir, join(tmpdir(), 'video-agent-release')) // the same file check, before anything is published
      execFileSync('npm', ['publish', '--provenance', '--access', 'public'], { cwd: p.dir, stdio: 'inherit' })
      log('published', { name: p.name, version: p.version })
    }
    return
  }
  throw new Error('Usage: release-packages.ts pack [--out <dir>] | publish --confirm')
}

if (process.argv[1]?.endsWith('release-packages.ts')) main()
