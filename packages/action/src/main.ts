// The action's run (github-action plan §3): read the event, decide, and act. Everything it touches comes in through
// ActionDeps, so tests run it in-process against the real app and a fake GitHub with a fake clock.
import { lookup } from 'node:dns/promises'
import { readFile } from 'node:fs/promises'
import { readContext, type RunContext } from './context.js'
import { envCore, type Core } from './core.js'
import { createLog, type Log } from './log.js'
import { isVideoAgentError, type VideoAgent } from '../../sdk/src/index.js'
import { COMMANDS, parseCommand, react } from './commands.js'
import {
  client,
  handleDispatch,
  handlePr,
  handleRelease,
  setupError,
  type Ctx,
  type PrAction,
  type PrInfo,
} from './flows.js'
import { createGitHub, GitHubError, type GitHub } from './github.js'
import { checkConnection, checkVisibility, InputError, readInputs, type Inputs } from './inputs.js'
import { route } from './router.js'
import { ACTION_VERSION, type OutputName } from './spec.js'
import { isFork, Trust } from './trust.js'

export interface ActionDeps {
  env: Record<string, string | undefined>
  core: Core
  /** For the Video Agent API (the SDK's fetch). */
  fetch: typeof fetch
  /** For the GitHub API. */
  ghFetch: typeof fetch
  /** For screenshots linked from a PR description (never sent a token, except GitHub's signed image URLs). */
  imageFetch: typeof fetch
  /** A host's addresses, to refuse images on private networks (self-hosted runners can reach them). */
  resolve: (host: string) => Promise<string[]>
  now: () => number
  sleep: (ms: number) => Promise<void>
  readFile: (path: string) => Promise<Uint8Array>
  /** The workspace (GITHUB_WORKSPACE), where screenshot globs resolve. */
  cwd: string
  /** Called at named points of a run; tests hold a run there to interleave two (the post-create race check). */
  hook?: (point: string) => Promise<void>
}

export function productionDeps(env: Record<string, string | undefined> = process.env): ActionDeps {
  const f = globalThis.fetch.bind(globalThis)
  return {
    env,
    core: envCore(env),
    fetch: f,
    ghFetch: f,
    imageFetch: f,
    resolve: async (host) => (await lookup(host, { all: true })).map((a) => a.address),
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
  const done = (status: string): RunResult => {
    if (!r.outputs.status) setOutputs(r, { status })
    return { status: r.outputs.status ?? status, outputs: r.outputs }
  }
  let inputs: Inputs
  try {
    inputs = readInputs(deps.core)
  } catch (e) {
    deps.core.setFailed(`video-agent: ${e instanceof Error ? e.message : String(e)}`)
    return done('error')
  }
  log.addSecret(inputs.apiKey)
  log.addSecret(inputs.githubToken)
  let host = '(none)'
  try {
    host = inputs.url ? new URL(inputs.url).host : host
  } catch {
    host = '(invalid)'
  }
  // The host is logged so a changed url variable is visible in every job log (§4.2).
  log.line({
    host,
    action: ACTION_VERSION,
    event: ctx.eventName || 'unknown',
    run: `${ctx.runId}.${ctx.runAttempt}`,
    dry: inputs.dryRun || undefined,
  })
  const decision = route(ctx, inputs)
  log.decision(decision.kind, {
    reason: decision.reason,
    pr: 'pr' in decision ? decision.pr : undefined,
    tag: 'tag' in decision ? decision.tag : undefined,
  })
  if (decision.kind === 'none') return done('skipped')
  const gh = createGitHub({
    token: inputs.githubToken,
    repository: ctx.repository,
    apiUrl: ctx.apiUrl,
    fetch: deps.ghFetch,
    log,
    now: deps.now,
  })
  let va: VideoAgent | undefined
  try {
    if (inputs.look) log.warn('look is not supported by this action version yet; ignored')
    if (inputs.baseVideo) log.warn('base-video is not supported by this action version yet; ignored')
    const repoInfo = obj(ctx.event.repository)
    const repoPrivate =
      typeof repoInfo.private === 'boolean'
        ? repoInfo.private
        : (await gh.request<{ private: boolean }>('GET /repos/{owner}/{repo}')).data.private
    checkVisibility(inputs, repoPrivate)
    const trust = new Trust(gh, log)
    const sender = str(obj(ctx.event.sender).login)

    if (decision.kind === 'release' || decision.kind === 'dispatch') {
      checkConnection(inputs)
      if (!(await trust.check('sender', sender)).trusted) return done('refused')
      va = client(r, inputs)
      const features = (await va.config.get()).features
      const flow: Ctx = { run: r, inputs, gh, va, features }
      if (decision.kind === 'dispatch') {
        if (inputs.prompt.length < 10)
          throw new InputError(
            'prompt',
            'is required for a one-off video (workflow_dispatch with no target), at least 10 characters',
          )
        return done((await handleDispatch(flow)).status)
      }
      const rel = await gh
        .request<{
          id: number
          tag_name: string
          name: string | null
          body: string | null
          html_url: string
          upload_url: string
        }>('GET /repos/{owner}/{repo}/releases/tags/{tag}', { path: { tag: decision.tag } })
        .catch((e: unknown) => {
          if (e instanceof GitHubError && e.status === 404) return null
          throw e
        })
      if (!rel) {
        log.warn(`no release ${decision.tag}`)
        return done('skipped')
      }
      const out = await handleRelease(flow, {
        id: rel.data.id,
        tag: rel.data.tag_name,
        name: rel.data.name,
        body: rel.data.body ?? '',
        url: rel.data.html_url,
        uploadUrl: rel.data.upload_url.replace(/\{.*\}$/, ''),
      })
      return done(out.status)
    }

    // Pull requests: the event's or the target's.
    const commentId = 'commentId' in decision ? decision.commentId : null
    const pull = await getPull(gh, decision.pr)
    const fork = isFork(pull)
    if (fork) {
      if (decision.kind !== 'command' || inputs.trust !== 'forks') {
        // Checked before url and api-key: pull_request runs from forks get no secrets, and that's not a failure.
        log.decision('skipped', { reason: 'Videos for fork PRs are off', pr: decision.pr })
        if (commentId !== null) await react(gh, commentId, 'confused')
        return done(commentId !== null ? 'refused' : 'skipped')
      }
    }
    if (decision.kind === 'command-refused') {
      log.decision('refused', { reason: decision.reason, pr: decision.pr })
      await react(gh, decision.commentId, 'confused')
      return done('refused')
    }
    checkConnection(inputs)
    const actor = decision.kind === 'command' ? decision.commenter : sender
    if (!(await trust.check(decision.kind === 'command' ? 'commenter' : 'sender', actor)).trusted) {
      if (commentId !== null) await react(gh, commentId, 'confused')
      return done('refused')
    }
    let action: PrAction
    if (decision.kind === 'command') {
      const parsed = parseCommand(decision.body, decision.commentId)
      if (parsed.kind === 'unknown') {
        log.warn(`unknown command /video ${parsed.word}; try ${COMMANDS.join(', ')}`)
        await react(gh, decision.commentId, 'confused')
        return done('none')
      }
      action = parsed
      await react(gh, decision.commentId, 'eyes')
    } else action = { kind: decision.kind === 'pr-push' ? 'push' : 'label' }
    // The author's words (description, commits, screenshots) only from a trusted author; never a fork's (§4.4).
    const author = await trust.check('author', pull.user?.login ?? '', pull.author_association ?? '')
    const info = await prInfo(gh, pull, author.trusted && !fork)
    va = client(r, inputs)
    const features = (await va.config.get()).features
    const out = await handlePr({ run: r, inputs, gh, va, features }, info, action, commentId)
    if (!out.ok && out.message) log.warn(out.message)
    if (commentId !== null) await react(gh, commentId, out.ok ? '+1' : 'confused')
    return done(out.status)
  } catch (e) {
    let message = e instanceof Error ? e.message : String(e)
    if (isVideoAgentError(e)) message = (await setupError({ run: r, va }, e)) ?? `${e.code}: ${e.message}`
    deps.core.setFailed(`video-agent: ${message}`)
    return done('error')
  }
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {})
const str = (v: unknown) => (typeof v === 'string' ? v : '')

interface Pull {
  number: number
  title: string
  body: string | null
  user: { login: string } | null
  author_association?: string
  head: { sha: string; repo: { full_name: string } | null }
  base: { repo: { full_name: string } }
  changed_files?: number
}

async function getPull(gh: GitHub, n: number): Promise<Pull> {
  return (
    await gh.request<Pull>('GET /repos/{owner}/{repo}/pulls/{pull_number}', { path: { pull_number: n } })
  ).data
}

/** At most this many changed files are read (the brief lists ten); the count comes from changed_files. */
const MAX_FILES = 300

async function prInfo(gh: GitHub, pull: Pull, authorTrusted: boolean): Promise<PrInfo> {
  const commits: string[] = []
  const files: string[] = []
  if (authorTrusted)
    for await (const c of gh.paginate<{ commit: { message: string } }>(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/commits',
      {
        path: { pull_number: pull.number },
      },
    ))
      commits.push(c.commit.message)
  for await (const f of gh.paginate<{ filename: string }>(
    'GET /repos/{owner}/{repo}/pulls/{pull_number}/files',
    {
      path: { pull_number: pull.number },
    },
  )) {
    files.push(f.filename)
    if (files.length >= MAX_FILES) break
  }
  return {
    number: pull.number,
    title: pull.title,
    body: authorTrusted ? (pull.body ?? '') : '',
    headSha: pull.head.sha,
    commits,
    files,
    filesTotal: pull.changed_files ?? files.length,
    authorTrusted,
  }
}
