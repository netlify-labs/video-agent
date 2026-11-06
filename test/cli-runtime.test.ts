// The CLI's local-mode runtime (cli-and-sdk plan §7; bead va-p1th.5.4): every run script a prompt calls is bundled,
// the pins match the repo's, the template is copied, and the optional engine and Remotion pieces are picked up only
// when they exist. The lockfile step reads the registry, so these build with lockfile: false (the CLI build makes it).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildRuntime, RUNTIME_PACKAGES, RUNTIME_SCRIPTS } from '../scripts/lib/cli-runtime.js'
import { repoRoot } from '../scripts/lib/run-tools.js'

/** Every scripts/<name>.ts the server's code tells an agent to run (the prompts and their helpers). */
function promptScripts(): string[] {
  const found = new Set<string>()
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts'))
        for (const m of readFileSync(p, 'utf8').matchAll(/tsx scripts\/([a-z-]+)\.ts/g)) found.add(m[1]!)
    }
  }
  walk(join(repoRoot, 'src'))
  return [...found].sort()
}

const write = (file: string, text: string) => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
}

describe('the CLI runtime', () => {
  it('bundles every run script a prompt calls', () => {
    // scripts/engine.ts is bundled whenever it exists (with lib/engines), so it isn't listed.
    const missing = promptScripts().filter(
      (s) => s !== 'engine' && !(RUNTIME_SCRIPTS as readonly string[]).includes(s),
    )
    expect(missing, 'add these to RUNTIME_SCRIPTS in scripts/lib/cli-runtime.ts').toEqual([])
  })

  it('builds from this repo: scripts, pins, template', { timeout: 120_000 }, async () => {
    const out = mkdtempSync(join(tmpdir(), 'va-runtime-'))
    const r = await buildRuntime({ repo: repoRoot, out, lockfile: false })
    expect(r.scripts).toEqual([...RUNTIME_SCRIPTS])
    for (const s of RUNTIME_SCRIPTS) expect(existsSync(join(out, `${s}.mjs`)), s).toBe(true)
    if (existsSync(join(repoRoot, 'scripts', 'engine.ts')))
      expect(existsSync(join(out, 'engine.mjs'))).toBe(true)
    const repoPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    const pins = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8')).dependencies
    for (const name of RUNTIME_PACKAGES)
      expect(pins[name], name).toBe(repoPkg.dependencies?.[name] ?? repoPkg.devDependencies?.[name])
    for (const f of ['video/index.html', 'video/AGENTS.md', 'video/vendor', 'context/BRAND.md', 'AGENTS.md'])
      expect(existsSync(join(out, 'template', f)), f).toBe(true)
    // The composition-specific files never come along.
    expect(existsSync(join(out, 'template', 'video', 'summary.json'))).toBe(false)
    // About 1.5 MB with shared chunks (C1 measured 2.1 MB without); a jump means something big got inlined.
    expect(r.bytes).toBeLessThan(3 * 1024 * 1024)
    // The bundle runs on its own: hyperframes is a package, not inlined.
    expect(readFileSync(join(out, 'render-job.mjs'), 'utf8')).not.toContain('node_modules/hyperframes/dist')
  })

  it('picks up engines and the Remotion lockfile when they exist, and builds without them', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'va-repo-'))
    write(
      join(repo, 'package.json'),
      JSON.stringify({
        dependencies: { hyperframes: '0.8.222', 'css-tree': '3.2.1' },
        devDependencies: { tsx: '4.23.15', 'netlify-agent-kit': '0.4.0' },
      }),
    )
    write(join(repo, 'scripts', 'prepare-run.ts'), "console.log('prepare')\n")
    write(join(repo, 'video', 'index.html'), '<div></div>\n')
    write(join(repo, 'context', 'BRAND.md'), '# Brand\n')
    write(join(repo, 'AGENTS.md'), '# Rules\n')
    const bare = mkdtempSync(join(tmpdir(), 'va-runtime-'))
    expect(await buildRuntime({ repo, out: bare, lockfile: false })).toMatchObject({
      scripts: ['prepare-run'],
      engines: [],
      remotion: false,
    })

    write(join(repo, 'scripts', 'engine.ts'), "import './lib/engines/x.js'\n")
    write(join(repo, 'scripts', 'lib', 'engines', 'x.ts'), 'export const x = 1\n')
    write(join(repo, 'scripts', 'lib', 'engines', 'x.test.ts'), 'export {}\n')
    write(join(repo, 'engines', 'remotion', 'template', 'package.json'), '{}\n')
    write(join(repo, 'engines', 'remotion', 'template', 'package-lock.json'), '{}\n')
    write(join(repo, 'engines', 'remotion', 'template', 'node_modules', 'big', 'index.js'), '\n')
    const out = mkdtempSync(join(tmpdir(), 'va-runtime-'))
    expect(await buildRuntime({ repo, out, lockfile: false })).toMatchObject({
      engines: ['x'],
      remotion: true,
    })
    expect(existsSync(join(out, 'engine.mjs'))).toBe(true)
    expect(existsSync(join(out, 'lib', 'engines', 'x.mjs'))).toBe(true)
    expect(existsSync(join(out, 'lib', 'engines', 'x.test.mjs'))).toBe(false)
    expect(readdirSync(join(out, 'engines', 'remotion')).sort()).toEqual([
      'package-lock.json',
      'package.json',
    ])
  })

  it(
    'a bundled script runs from a workspace shim, with VA_REPO_ROOT as its workspace',
    { timeout: 120_000 },
    async () => {
      const out = mkdtempSync(join(tmpdir(), 'va-runtime-'))
      await buildRuntime({ repo: repoRoot, out, lockfile: false })
      // A workspace's scripts/<name>.ts is one line that imports the bundle (docs/spikes.md C1), so the scripts'
      // "am I the entry point" checks still see <name>.ts.
      const ws = mkdtempSync(join(tmpdir(), 'va-ws-'))
      write(join(ws, 'scripts', 'checkpoint.ts'), `import '${join(out, 'checkpoint.mjs')}'\n`)
      // With no arguments it prints its usage and exits 0 (a checkpoint never fails a run).
      const text = execFileSync('npx', ['tsx', join(ws, 'scripts', 'checkpoint.ts')], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, VA_REPO_ROOT: ws },
      })
      expect(text).toContain('checkpoint skipped: usage')
    },
  )
})
