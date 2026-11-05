// Builds every public workspace package under packages/ (cli-and-sdk plan §3): esbuild bundles src/ to ESM in dist/,
// then tsc writes the .d.ts files. A CLI's src/bin.ts starts with its shebang, which esbuild keeps. Private packages
// (the GitHub Action) build themselves.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'
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
  }
  if (pkg.private || (only.length && !only.includes(dir))) continue
  const started = Date.now()
  rmSync(join(root, 'dist'), { recursive: true, force: true })
  const node = Boolean(pkg.bin)
  await build({
    entryPoints: [join(root, 'src/index.ts'), ...(node ? [join(root, 'src/bin.ts')] : [])],
    outdir: join(root, 'dist'),
    bundle: true,
    format: 'esm',
    platform: node ? 'node' : 'neutral',
    target: node ? 'node22' : 'es2022',
    logLevel: 'warning',
  })
  execFileSync('npx', ['tsc', '-p', join(root, 'tsconfig.build.json')], { stdio: 'inherit' })
  log('package', { name: pkg.name, ms: Date.now() - started })
}
