// The CLI's runtime for local mode (cli-and-sdk plan §7; bead va-p1th.5.4), built from this repo at CLI build time so a
// run-script fix ships to runners and laptops together (docs/spikes.md C1):
//   <out>/<script>.mjs          each run script the prompts call, bundled with src/lib (shared code in chunks/);
//                               hyperframes, esbuild and
//                               css-tree stay packages (css-tree reads its data files relative to itself)
//   <out>/lib/engines/*.mjs     render engines and <out>/engine.mjs, when the repo has scripts/engine.ts
//   <out>/package.json + package-lock.json   hyperframes, tsx, netlify-agent-kit and css-tree at the repo's pins,
//                               installed per machine with `npm ci`
//   <out>/template/             video/ (the neutral template), context/, the root AGENTS.md and a package.json with
//                               netlifyAgent (agent-kit's config) for each workspace
//   <out>/engines/remotion/     the Remotion template's package.json and lockfile only, when the repo has them
//   <out>/fixture-agent.mjs     the fixture agent and fixture/ (contract1), for --agent fixture
// Missing optional pieces are skipped, so nothing here waits for the plans that add them.
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'

/** Every scripts/<name>.ts a run prompt tells the agent to run (test/cli-runtime.test.ts keeps this in step). */
export const RUNTIME_SCRIPTS = [
  'prepare-run',
  'render-job',
  'checkpoint',
  'check-contract',
  'voice',
  'openverse',
  'narration',
  'narration-stt',
  'recording',
] as const

/** Packages the runtime installs instead of bundling, at the repo's own versions. */
export const RUNTIME_PACKAGES = ['hyperframes', 'tsx', 'netlify-agent-kit', 'css-tree'] as const
const EXTERNAL = ['hyperframes', 'esbuild', 'css-tree']
const VIDEO_TEMPLATE = ['index.html', 'vendor', 'AGENTS.md', 'hyperframes.json', 'package.json', 'meta.json']

export interface RuntimeReport {
  scripts: string[]
  engines: string[]
  pins: Record<string, string>
  remotion: boolean
  bytes: number
}

const ts = (f: string) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.endsWith('.test.ts')

/** The repo's exact version of each runtime package (dependencies or devDependencies). */
export function runtimePins(repo: string): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  return Object.fromEntries(
    RUNTIME_PACKAGES.map((name) => {
      const v = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]
      if (!v || !/^\d+\.\d+\.\d+/.test(v))
        throw new Error(`package.json must pin ${name} to an exact version`)
      return [name, v]
    }),
  )
}

/**
 * Builds the runtime into `out` (emptied first). `lockfile: false` skips `npm install --package-lock-only`, which
 * reads the registry, for tests that only check the bundle.
 */
export async function buildRuntime(o: {
  repo: string
  out: string
  lockfile?: boolean
}): Promise<RuntimeReport> {
  const { repo, out } = o
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const scripts = RUNTIME_SCRIPTS.filter((s) => existsSync(join(repo, 'scripts', `${s}.ts`)))
  const hasEngine = existsSync(join(repo, 'scripts', 'engine.ts'))
  const engineDir = join(repo, 'scripts', 'lib', 'engines')
  const engines = hasEngine && existsSync(engineDir) ? readdirSync(engineDir).filter(ts).sort() : []
  const entryPoints = [
    ...[...scripts, ...(hasEngine ? ['engine'] : [])].map((s) => ({
      in: join(repo, 'scripts', `${s}.ts`),
      out: s,
    })),
    ...engines.map((f) => ({ in: join(engineDir, f), out: `lib/engines/${f.slice(0, -3)}` })),
  ]
  const r = await build({
    entryPoints,
    outdir: out,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    // Shared code (src/lib, parse5, …) once, in chunks/, instead of in every script.
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: EXTERNAL,
    // The CJS dependencies they inline call require().
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
    logLevel: 'error',
    metafile: true,
  })

  const pins = runtimePins(repo)
  writeFileSync(
    join(out, 'package.json'),
    `${JSON.stringify({ name: 'video-agent-runtime', private: true, type: 'module', dependencies: pins }, null, 2)}\n`,
  )
  if (o.lockfile !== false)
    execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: out,
      stdio: ['ignore', 'ignore', 'inherit'],
    })

  const template = join(out, 'template')
  mkdirSync(join(template, 'video'), { recursive: true })
  for (const name of VIDEO_TEMPLATE) {
    const from = join(repo, 'video', name)
    if (existsSync(from)) cpSync(from, join(template, 'video', name), { recursive: true })
  }
  cpSync(join(repo, 'context'), join(template, 'context'), { recursive: true })
  copyFileSync(join(repo, 'AGENTS.md'), join(template, 'AGENTS.md'))
  // netlify-agent-kit reads its config from the workspace's package.json, as on the runner (C1).
  const { netlifyAgent } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as {
    netlifyAgent?: unknown
  }
  writeFileSync(
    join(template, 'package.json'),
    `${JSON.stringify({ name: 'video-agent-local-run', private: true, type: 'module', ...(netlifyAgent ? { netlifyAgent } : {}) }, null, 2)}\n`,
  )

  // The fixture agent (hidden --agent fixture) and its known-good composition, for local mode's CI and tests.
  if (existsSync(join(repo, 'scripts', 'lib', 'fixture-agent.mjs'))) {
    copyFileSync(join(repo, 'scripts', 'lib', 'fixture-agent.mjs'), join(out, 'fixture-agent.mjs'))
    mkdirSync(join(out, 'fixture'), { recursive: true })
    for (const f of ['index.html', 'summary.json'])
      copyFileSync(join(repo, 'test', 'fixtures', 'contract1', f), join(out, 'fixture', f))
    // The media contract1 plays (as spike C1 placed them).
    mkdirSync(join(out, 'fixture', 'assets', 'media'), { recursive: true })
    copyFileSync(
      join(repo, 'test', 'fixtures', 'a169.mp4'),
      join(out, 'fixture', 'assets', 'media', 'med_clip.mp4'),
    )
    writeFileSync(
      join(out, 'fixture', 'assets', 'media', 'med_logo.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="28" fill="#14b8a6"/></svg>\n',
    )
  }

  const remotionDir = join(repo, 'engines', 'remotion', 'template')
  const remotion = existsSync(join(remotionDir, 'package-lock.json'))
  if (remotion) {
    mkdirSync(join(out, 'engines', 'remotion'), { recursive: true })
    for (const f of ['package.json', 'package-lock.json'])
      if (existsSync(join(remotionDir, f)))
        copyFileSync(join(remotionDir, f), join(out, 'engines', 'remotion', f))
  }

  const bytes = Object.values(r.metafile.outputs).reduce((n, x) => n + x.bytes, 0)
  return { scripts, engines: engines.map((f) => f.slice(0, -3)), pins, remotion, bytes }
}
