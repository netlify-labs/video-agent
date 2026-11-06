// What GitHub tells a running action about the workflow run: the event, the repository and the run ids.
import { readFileSync } from 'node:fs'

export interface RunContext {
  eventName: string
  /** The webhook payload of the event that started the workflow. */
  event: Record<string, unknown>
  /** owner/repo. */
  repository: string
  /** Stays the same across re-runs of a run, so idempotency keys built on it survive a re-run. */
  runId: string
  runAttempt: string
  serverUrl: string
  apiUrl: string
}

export function readContext(
  env: Record<string, string | undefined>,
  read = (p: string) => readFileSync(p, 'utf8'),
) {
  let event: Record<string, unknown> = {}
  if (env.GITHUB_EVENT_PATH) {
    try {
      event = JSON.parse(read(env.GITHUB_EVENT_PATH)) as Record<string, unknown>
    } catch {
      event = {}
    }
  }
  return {
    eventName: env.GITHUB_EVENT_NAME ?? '',
    event,
    repository: env.GITHUB_REPOSITORY ?? '',
    runId: env.GITHUB_RUN_ID ?? '0',
    runAttempt: env.GITHUB_RUN_ATTEMPT ?? '1',
    serverUrl: (env.GITHUB_SERVER_URL ?? 'https://github.com').replace(/\/+$/, ''),
    apiUrl: (env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, ''),
  } satisfies RunContext
}
