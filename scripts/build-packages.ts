// Builds every public workspace package under packages/ (cli-and-sdk plan §3): esbuild bundles src/ to ESM in dist/,
// then tsc writes the .d.ts files. A CLI's src/bin.ts starts with its shebang, which esbuild keeps. Private packages
// (the GitHub Action) build themselves. The CLI also gets its local-mode runtime in dist/runtime/
// (scripts/lib/cli-runtime.ts).
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'
import { buildRuntime } from './lib/cli-runtime.js'
import { packageBuildOptions } from './lib/player-build.js'
import { repoRoot } from './lib/run-tools.js'

const log = (step: string, f: Record<string, unknown> = {}) => console.log(JSON.stringify({ step, ...f }))
const only = process.argv.slice(2)

for (const dir of readdirSync(join(repoRoot, 'packages')).sort()) {
  const root = join(repoRoot, 'packages', dir)
  if (!existsSync(join(root, 'package.json'))) continue
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    name: string
    private?: boolean
    bin?: Record<string, string>
    exports?: Record<string, { types?: string }>
    dependencies?: Record<string, string>
  }
  if (pkg.private || (only.length && !only.includes(dir))) continue
  const started = Date.now()
  rmSync(join(root, 'dist'), { recursive: true, force: true })
  const node = Boolean(pkg.bin)
  // A package's own dependencies stay packages: css-tree, for one, reads its data files relative to itself and breaks
  // when bundled (docs/spikes.md C1).
  await build({
    ...packageBuildOptions(root, node),
    outdir: join(root, 'dist'),
    // ...and Playwright, which video-agent record loads from the person's own install when they record (it says how to
    // get it otherwise): too big to ship, and esbuild can't bundle it.
    external: [...Object.keys(pkg.dependencies ?? {}), ...(dir === 'cli' ? ['playwright', 'playwright-core'] : [])],
  })
  // Declarations only for packages that export types (the CLI is a command, not a library).
  if (pkg.exports?.['.']?.types)
    execFileSync('npx', ['tsc', '-p', join(root, 'tsconfig.build.json')], { stdio: 'inherit' })
  if (dir === 'cli') {
    const runtime = await buildRuntime({ repo: repoRoot, out: join(root, 'dist', 'runtime') })
    log('cli.runtime', { ...runtime, ms: Date.now() - started })
  }
  log('package', { name: pkg.name, ms: Date.now() - started })
}
