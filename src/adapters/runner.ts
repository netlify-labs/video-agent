// Agent Runner through nax-agent-runner-sdk. Runs never land (land: 'none').
import { createAgentRunnerSdk, isAgentRunnerSdkError, type Handle, type RunResult, type StartInput } from 'nax-agent-runner-sdk'
import { RunnerError, type RunnerPort, type RunnerSnapshot, type StartRequest } from '../deps.js'
import type { Usage } from '../domain/types.js'

function toInput(siteId: string, r: StartRequest): StartInput & { requestId: string } {
  return {
    siteId,
    prompt: r.prompt,
    agent: r.agent,
    land: 'none',
    requestId: r.requestId,
    deadlineMs: r.deadlineMs,
    ...(r.deployId ? { deployId: r.deployId } : {}),
    ...(r.model ? { model: r.model } : {}),
    ...(r.effort ? { effort: r.effort } : {}),
  }
}

function toUsage(u: { totalCreditsCost?: number; totalTokens?: number; stepsCount?: number } | null): Usage | null {
  if (!u) return null
  const out: Usage = {}
  if (u.totalCreditsCost !== undefined) out.totalCreditsCost = u.totalCreditsCost
  if (u.totalTokens !== undefined) out.totalTokens = u.totalTokens
  if (u.stepsCount !== undefined) out.stepsCount = u.stepsCount
  return out
}

function terminal(result: RunResult): RunnerSnapshot {
  return {
    kind: 'terminal',
    status: result.status,
    resultText: result.status === 'succeeded' ? result.resultText : null,
    usage: toUsage(result.usage),
    failure: result.status === 'failed' ? { category: result.failure.category, code: result.failure.code, message: result.failure.message } : null,
  }
}

export function createRunner(opts: { siteId: string; siteName: string; token: string }): RunnerPort {
  const sdk = createAgentRunnerSdk({ token: opts.token })
  const classify = (e: unknown): RunnerError => {
    if (isAgentRunnerSdkError(e, 'create-ambiguous')) {
      return new RunnerError('ambiguous', e.message, e.window)
    }
    const f = sdk.classifyFailure(e)
    if (/credit/i.test(`${f.code} ${f.message}`)) return new RunnerError('credits', f.message)
    if (f.category === 'capacity' || f.category === 'rate-limit') return new RunnerError('capacity', f.message)
    return new RunnerError('fatal', `${f.title}: ${f.message}`)
  }
  return {
    async start(req) {
      try {
        const h = await sdk.start(toInput(opts.siteId, req))
        return { handle: sdk.serializeHandle(h), runnerId: h.runnerId, sessionId: h.currentSessionId }
      } catch (e) {
        throw classify(e)
      }
    },
    async reconcile(req, window) {
      const res = await sdk.reconcileCreate(toInput(opts.siteId, req), window)
      if (res.kind === 'matched') {
        return { kind: 'matched', handle: sdk.serializeHandle(res.handle), runnerId: res.handle.runnerId, sessionId: res.handle.currentSessionId }
      }
      return { kind: res.kind }
    },
    async snapshot(handle) {
      const snap = await sdk.getSnapshot(sdk.parseHandle(handle) as Handle)
      if (snap.kind === 'terminal') return terminal(snap.result)
      return {
        kind: 'running',
        state: snap.state,
        latestStep: snap.latestStep ?? null,
        usage: toUsage(snap.usage),
      }
    },
    async stop(handle) {
      await sdk.stop(sdk.parseHandle(handle) as Handle)
    },
    runUrl(runnerId, sessionId) {
      return `https://app.netlify.com/projects/${opts.siteName}/agent-runs/${runnerId}${sessionId ? `?session=${sessionId}` : ''}`
    },
  }
}
