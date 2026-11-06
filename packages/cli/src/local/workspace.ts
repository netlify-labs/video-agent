// Local mode's runtime and workspace (cli-and-sdk plan §7; bead va-p1th.5.5), as spike C1 proved them (docs/spikes.md):
//   runtime    <cache>/runtime/<cli version>/: the CLI's bundled runtime (dist/runtime) copied once, then `npm ci` from
//              its lockfile with an empty npm config, so the person's ~/.npmrc (registries, tokens) never applies
//   workspace  <cache>/runs/<run id>/: the video/ template, context/ (--context, else ./context, else the neutral
//              one), the root AGENTS.md, scripts/<name>.ts shims that import runtime/<name>.mjs (each script's "am I
//              the entry point" check matches <name>.ts), and node_modules links into the runtime
//   agent-kit  netlify-agent-kit install --force in the workspace with HOME redirected to <cache>/agent-kit-home, so it
//              never writes the person's ~/.cache or links into their ~/.local/bin; that home's .local/bin joins PATH
// <cache> is $XDG_CACHE_HOME/video-agent, else ~/.cache/video-agent. Every step logs one JSON line through `log`.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Log = (event: string, fields?: Record<string, unknown>) => void
/** Runs a command; resolves to its exit code and output. Injectable so tests see every call. */
export type Runner = (
  cmd: string,
  args: string[],
  o: { cwd: string; env: NodeJS.ProcessEnv },
) => { status: number | null; output: string }

export const spawnRunner: Runner = (cmd, args, o) => {
  const r = spawnSync(cmd, args, { ...o, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { status: r.status, output: `${r.stdout}${r.stderr}` }
}

export function cacheDir(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'video-agent')
}

/** dist/runtime next to the bundled CLI (dist/bin.js). */
export const bundledRuntime = () => join(dirname(fileURLToPath(import.meta.url)), 'runtime')

const lockHash = (dir: string) =>
  createHash('sha256')
    .update(readFileSync(join(dir, 'package-lock.json')))
    .digest('hex')

/** The npm settings every local install uses: an empty config file and our own cache. */
export function npmEnv(cache: string, offline = false): NodeJS.ProcessEnv {
  const userconfig = join(cache, 'empty-npmrc')
  mkdirSync(cache, { recursive: true })
  if (!existsSync(userconfig)) writeFileSync(userconfig, '')
  return {
    npm_config_userconfig: userconfig,
    npm_config_cache: join(cache, 'npm-cache'),
    npm_config_update_notifier: 'false',
    ...(offline ? { npm_config_offline: 'true' } : {}),
  }
}

/**
 * The installed runtime for this CLI version, installing it on first use. A later run with the same lockfile reuses
 * the packages without touching the network (the scripts and template are refreshed from the CLI each time); a changed
 * lockfile reinstalls.
 */
export function ensureRuntime(o: {
  source: string
  cache: string
  version: string
  env: NodeJS.ProcessEnv
  log: Log
  run?: Runner
  offline?: boolean
}): string {
  const t = Date.now()
  const dir = join(o.cache, 'runtime', o.version)
  const stamp = join(dir, '.installed')
  const want = lockHash(o.source)
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === want) {
    // The installed packages are current; the scripts and template always come from this CLI.
    cpSync(o.source, dir, { recursive: true, force: true })
    o.log('local.runtime', { dir, cached: true, ms: Date.now() - t })
    return dir
  }
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dirname(dir), { recursive: true })
  cpSync(o.source, dir, { recursive: true })
  const r = (o.run ?? spawnRunner)('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: dir,
    env: { ...o.env, ...npmEnv(o.cache, o.offline) },
  })
  if (r.status !== 0) {
    o.log('local.runtime', { dir, ok: false, ms: Date.now() - t })
    throw new Error(`Installing the video-agent runtime failed (npm ci in ${dir}):\n${r.output.slice(-1500)}`)
  }
  writeFileSync(stamp, want)
  o.log('local.runtime', { dir, cached: false, ms: Date.now() - t })
  return dir
}

export interface Workspace {
  dir: string
  /** The environment the agent and every run script get. */
  env: NodeJS.ProcessEnv
  kitHome: string
}

/**
 * <ws>/node_modules: a link to each runtime package, and a .bin of links except tsx. The tsx CLI listens on a unix
 * socket in the temp folder, which agent sandboxes refuse (docs/spikes.md C2), so `npx tsx` gets a wrapper that runs
 * node with tsx's loader instead: same TypeScript, no socket.
 */
function linkNodeModules(runtime: string, ws: string) {
  const from = join(runtime, 'node_modules')
  const to = join(ws, 'node_modules')
  mkdirSync(join(to, '.bin'), { recursive: true })
  for (const name of readdirSync(from))
    if (name !== '.bin' && !name.startsWith('.package-lock')) symlinkSync(join(from, name), join(to, name))
  const bin = join(from, '.bin')
  if (existsSync(bin))
    for (const name of readdirSync(bin))
      if (name !== 'tsx') symlinkSync(join(bin, name), join(to, '.bin', name))
  const tsx = join(to, '.bin', 'tsx')
  writeFileSync(
    tsx,
    `#!/bin/sh\nexec node --import ${JSON.stringify(join(from, 'tsx', 'dist', 'loader.mjs'))} "$@"\n`,
  )
  chmodSync(tsx, 0o755)
}

/** A fresh workspace for one run, from the runtime's template. */
export function buildWorkspace(o: {
  runtime: string
  cache: string
  runId: string
  env: NodeJS.ProcessEnv
  log: Log
  /** --context, or ./context when the caller found one; else the neutral context from the template. */
  context?: string | undefined
  offline?: boolean
}): Workspace {
  const t = Date.now()
  const dir = join(o.cache, 'runs', o.runId)
  rmSync(dir, { recursive: true, force: true })
  cpSync(join(o.runtime, 'template'), dir, { recursive: true })
  if (o.context) {
    rmSync(join(dir, 'context'), { recursive: true, force: true })
    cpSync(o.context, join(dir, 'context'), { recursive: true })
  }
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, '.tmp'), { recursive: true })
  const scripts = readdirSync(o.runtime)
    // The fixture agent isn't a run script.
    .filter((f) => f.endsWith('.mjs') && f !== 'fixture-agent.mjs')
    .map((f) => f.slice(0, -4))
    .sort()
  for (const s of scripts)
    writeFileSync(join(dir, 'scripts', `${s}.ts`), `import ${JSON.stringify(join(o.runtime, `${s}.mjs`))}\n`)
  linkNodeModules(o.runtime, dir)
  symlinkSync(join(dir, 'node_modules'), join(dir, 'video', 'node_modules'))
  const kitHome = join(o.cache, 'agent-kit-home')
  mkdirSync(kitHome, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...o.env,
    ...npmEnv(o.cache, o.offline),
    // Pinned tools first: the runtime's bins (hyperframes, tsx), then agent-kit's ffmpeg and ffprobe.
    PATH: [join(dir, 'node_modules', '.bin'), join(kitHome, '.local', 'bin'), o.env.PATH ?? ''].join(
      delimiter,
    ),
    VA_REPO_ROOT: dir,
    VA_RUNTIME: o.runtime,
    VA_NETLIFY_CLI: 'off',
    // render-job asks the CLI to render, outside the agent's sandbox (scripts/lib/render-broker.ts).
    VA_RENDER_BROKER: 'file',
    // Sandboxes route the shell's network through a proxy (HTTPS_PROXY); Node's fetch (Openverse) honours it only
    // with this (docs/spikes.md C2).
    NODE_USE_ENV_PROXY: '1',
    // prepare-run reads inputs from here; the prompt's command is the runner's, with no --inputs.
    VA_INPUTS_DIR: join(dir, '.va-inputs'),
    // Temp files stay in the workspace, which is all the sandboxed shell may write.
    TMPDIR: join(dir, '.tmp'),
    // hyperframes caches fonts under ~/.cache, which the sandboxed shell can't write.
    HYPERFRAMES_FONT_CACHE_DIR: join(dir, '.tmp', 'fonts'),
  }
  o.log('local.workspace', {
    dir,
    scripts,
    context: o.context ? 'custom' : 'neutral',
    ms: Date.now() - t,
  })
  return { dir, env, kitHome }
}

/** netlify-agent-kit install --force in the workspace, with HOME redirected; returns the skills it installed. */
export function installAgentKit(o: { ws: Workspace; runtime: string; log: Log; run?: Runner }): string[] {
  const t = Date.now()
  const r = (o.run ?? spawnRunner)(
    join(o.runtime, 'node_modules', '.bin', 'netlify-agent-kit'),
    ['install', '--force'],
    {
      cwd: o.ws.dir,
      env: { ...o.ws.env, HOME: o.ws.kitHome },
    },
  )
  if (r.status !== 0) {
    o.log('local.agent_kit', { ok: false, ms: Date.now() - t })
    throw new Error(`netlify-agent-kit install failed in ${o.ws.dir}:\n${r.output.slice(-1500)}`)
  }
  const skillsDir = join(o.ws.dir, '.claude', 'skills')
  const skills = existsSync(skillsDir) ? readdirSync(skillsDir).sort() : []
  o.log('local.agent_kit', { ok: true, skills, ms: Date.now() - t })
  return skills
}

/**
 * Kokoro's venv for voice-overs (docs/spikes.md C3): <cache>/kokoro-venv from the newest python3.13 … 3.10, with
 * kokoro-onnx>=0.6 installed and the person's pip config ignored. Returns the venv's python (VA_PYTHON), or null with
 * the reason when there's no usable Python (local voice-over is then unavailable; ElevenLabs still works).
 */
export function ensureVoiceVenv(o: {
  cache: string
  env: NodeJS.ProcessEnv
  log: Log
  run?: Runner
}): { python: string } | { python: null; reason: string } {
  const t = Date.now()
  const run = o.run ?? spawnRunner
  const venv = join(o.cache, 'kokoro-venv')
  const python = join(venv, 'bin', 'python')
  const env = { ...o.env, PIP_CONFIG_FILE: '/dev/null', PIP_USER: '0', PIP_DISABLE_PIP_VERSION_CHECK: '1' }
  if (
    existsSync(python) &&
    run(python, ['-c', 'import kokoro_onnx, soundfile'], { cwd: o.cache, env }).status === 0
  ) {
    o.log('local.voice_venv', { python, cached: true, ms: Date.now() - t })
    return { python }
  }
  const base = ['python3.13', 'python3.12', 'python3.11', 'python3.10'].find(
    (p) => run(p, ['--version'], { cwd: o.cache, env }).status === 0,
  )
  if (!base) return { python: null, reason: 'No Python 3.10 to 3.13 found (Kokoro needs one).' }
  mkdirSync(o.cache, { recursive: true })
  for (const [cmd, args] of [
    [base, ['-m', 'venv', venv]],
    [python, ['-m', 'pip', 'install', '--quiet', 'kokoro-onnx>=0.6', 'soundfile']],
  ] as const) {
    const r = run(cmd, [...args], { cwd: o.cache, env })
    if (r.status !== 0) {
      o.log('local.voice_venv', { ok: false, step: args[1], ms: Date.now() - t })
      return { python: null, reason: `${cmd} ${args.join(' ')} failed:\n${r.output.slice(-800)}` }
    }
  }
  o.log('local.voice_venv', { python, cached: false, base, ms: Date.now() - t })
  return { python }
}
