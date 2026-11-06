// Local mode's agent adapters (cli-and-sdk plan §6.5; beads va-p1th.5.7-5.10, settings from spike C2). The person's
// own coding agent makes the video inside its OS sandbox, which is the boundary (a tool allowlist isn't one):
//   env       only an allowlist reaches the agent (no VIDEO_AGENT_KEY, cloud credentials or tokens)
//   files     reads of the folders below are denied, through the shell and through the agent's own file tools
//   network   only the hosts a run needs: Openverse and its audio hosts, the voice model's hosts, the agent's API
//   config    the person's own hooks, MCP servers, plugins and memory files never load
//   budget    a turn limit and a wall-clock limit; stopping kills the whole process tree
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Log } from './workspace.js'

/** Folders no run may read, relative to the person's home (and the CLI's own config, which holds an nva_ key). */
export const DENY_READ = [
  '.ssh',
  '.aws',
  '.config/gcloud',
  '.azure',
  '.netlify',
  '.npmrc',
  '.config/video-agent',
  '.codex',
  '.gemini',
  '.docker',
  '.kube',
  '.gnupg',
] as const

/** Hosts a run's shell may reach (C2, plus C3's voice-model hosts). The agent's own API host is added per agent. */
export const NETWORK_ALLOW = [
  // Openverse search and the audio it links to (scripts/openverse.ts).
  'api.openverse.org',
  'api.openverse.engineering',
  '*.jamendo.com',
  'freesound.org',
  '*.freesound.org',
  'upload.wikimedia.org',
  'commons.wikimedia.org',
  // Google Fonts: the compiler fetches the bundled families' other weights (C2).
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  // Kokoro's model files (docs/spikes.md C3).
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
] as const

/** Variables that pass to the agent; everything else (keys, tokens, cloud credentials) is dropped. */
const ENV_ALLOW =
  /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z]+|TERM|TMPDIR|TZ|VA_[A-Z_]+|npm_config_[a-z_]+|HYPERFRAMES_[A-Z_]+|XDG_[A-Z_]+|NODE_USE_ENV_PROXY)$/

export function agentEnv(env: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined && ENV_ALLOW.test(k)) out[k] = v
  return { ...out, ...extra }
}

export const denyReadPaths = (home = homedir()) => DENY_READ.map((p) => join(home, p))

export interface AgentCommand {
  cmd: string
  args: string[]
  env: NodeJS.ProcessEnv
  /** Written before the run (settings files the flags point at). */
  files?: Record<string, string>
}

export interface Adapter {
  id: 'claude' | 'codex' | 'gemini' | 'fixture' | 'quick'
  /** The command for one run of `prompt` in workspace `ws`. */
  command(o: { ws: string; prompt: string; env: NodeJS.ProcessEnv; maxTurns: number }): AgentCommand
}

export interface AgentResult {
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  ms: number
  /** The agent's own output (stream-json lines and the like), kept in <ws>/.va/agent.log. */
  logFile: string
}

/**
 * Runs the agent in its own process group, so stopping (timeout, Ctrl-C, abort) kills everything it started: the
 * shell, render-job, Chrome. Output goes to <ws>/.va/agent.log.
 */
export function runAgent(o: {
  adapter: Adapter
  ws: string
  prompt: string
  env: NodeJS.ProcessEnv
  log: Log
  maxTurns?: number
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<AgentResult> {
  const t = Date.now()
  const c = o.adapter.command({ ws: o.ws, prompt: o.prompt, env: o.env, maxTurns: o.maxTurns ?? 200 })
  mkdirSync(join(o.ws, '.va'), { recursive: true })
  for (const [path, body] of Object.entries(c.files ?? {})) {
    mkdirSync(join(path, '..'), { recursive: true })
    // 0600: an adapter may copy the person's own sign-in into its run home (gemini.ts).
    writeFileSync(path, body, { mode: 0o600 })
  }
  const logFile = join(o.ws, '.va', 'agent.log')
  const out = createWriteStream(logFile)
  const child = spawn(c.cmd, c.args, {
    cwd: o.ws,
    env: c.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.pipe(out, { end: false })
  child.stderr.pipe(out, { end: false })
  o.log('local.agent_started', { agent: o.adapter.id, pid: child.pid })
  let timedOut = false
  const killTree = () => {
    const pid = child.pid
    if (pid === undefined || child.exitCode !== null) return
    try {
      process.kill(-pid, 'SIGTERM')
      setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }, 5000).unref()
    } catch {
      // Already gone.
    }
  }
  const timer = setTimeout(
    () => {
      timedOut = true
      killTree()
    },
    o.timeoutMs ?? 40 * 60_000,
  )
  o.signal?.addEventListener('abort', killTree, { once: true })
  return new Promise((resolve, reject) => {
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const r = { code, signal, timedOut, ms: Date.now() - t, logFile }
      o.log('local.agent_done', { agent: o.adapter.id, code, signal, timedOut, ms: r.ms })
      // Resolve once the log is on disk, so a caller reading it sees all of it.
      out.end(() => resolve(r))
    })
  })
}
