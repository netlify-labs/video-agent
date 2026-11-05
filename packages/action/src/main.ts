// The action's run (github-action plan §3): read the event, decide, and act. Everything it touches comes in through
// ActionDeps, so tests run it in-process against the real app and a fake GitHub with a fake clock.
import { readFile } from 'node:fs/promises'
import { readContext, type RunContext } from './context.js'
import { envCore, type Core } from './core.js'
import { createLog, type Log } from './log.js'
import type { OutputName } from './spec.js'

export interface ActionDeps {
  env: Record<string, string | undefined>
  core: Core
  /** For the Video Agent API (the SDK's fetch). */
  fetch: typeof fetch
  /** For the GitHub API. */
  ghFetch: typeof fetch
  /** For screenshots linked from a PR description (never sent a token, except GitHub's signed image URLs). */
  imageFetch: typeof fetch
  now: () => number
  sleep: (ms: number) => Promise<void>
  readFile: (path: string) => Promise<Uint8Array>
  /** The workspace (GITHUB_WORKSPACE), where screenshot globs resolve. */
  cwd: string
}

export function productionDeps(env: Record<string, string | undefined> = process.env): ActionDeps {
  const f = globalThis.fetch.bind(globalThis)
  return {
    env,
    core: envCore(env),
    fetch: f,
    ghFetch: f,
    imageFetch: f,
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    readFile: (p) => readFile(p),
    cwd: env.GITHUB_WORKSPACE ?? process.cwd(),
  }
}

export type Outputs = Partial<Record<OutputName, string>>

export interface RunResult {
  status: string
  outputs: Outputs
}

/** What every step of a run shares. */
export interface Run {
  deps: ActionDeps
  ctx: RunContext
  log: Log
  outputs: Outputs
}

export function setOutputs(run: Run, values: Outputs) {
  for (const [k, v] of Object.entries(values)) {
    run.outputs[k as OutputName] = v
    run.deps.core.setOutput(k, v)
  }
}

/** Runs the action. Never throws: setup errors fail the step, everything else warns and sets outputs.status. */
export async function run(deps: ActionDeps = productionDeps()): Promise<RunResult> {
  const ctx = readContext(deps.env)
  const log = createLog(deps.core, { json: deps.env.VIDEO_AGENT_LOG === 'json' })
  const r: Run = { deps, ctx, log, outputs: {} }
  try {
    log.decision('none', { reason: `nothing to do for event ${ctx.eventName || 'unknown'}` })
    setOutputs(r, { status: 'none' })
    return { status: 'none', outputs: r.outputs }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    deps.core.setFailed(`video-agent: ${message}`)
    return { status: 'error', outputs: r.outputs }
  }
}
