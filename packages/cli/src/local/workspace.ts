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
 * it without touching the network; a changed lockfile (a rebuilt CLI of the same version) reinstalls.
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
  const scripts = readdirSync(o.runtime)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => f.slice(0, -4))
    .sort()
  for (const s of scripts)
    writeFileSync(join(dir, 'scripts', `${s}.ts`), `import ${JSON.stringify(join(o.runtime, `${s}.mjs`))}\n`)
  symlinkSync(join(o.runtime, 'node_modules'), join(dir, 'node_modules'))
  symlinkSync(join(o.runtime, 'node_modules'), join(dir, 'video', 'node_modules'))
  const kitHome = join(o.cache, 'agent-kit-home')
  mkdirSync(kitHome, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...o.env,
    ...npmEnv(o.cache, o.offline),
    // Pinned tools first: the runtime's bins (hyperframes, tsx), then agent-kit's ffmpeg and ffprobe.
    PATH: [join(o.runtime, 'node_modules', '.bin'), join(kitHome, '.local', 'bin'), o.env.PATH ?? ''].join(
      delimiter,
    ),
    VA_REPO_ROOT: dir,
    VA_NETLIFY_CLI: 'off',
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
