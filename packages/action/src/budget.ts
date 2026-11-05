// Spending caps checked before anything that starts a run (github-action plan §5, bead va-mg4i.2.14): new videos,
// revisions, remixes and retries all cost a full authoring run, so they all count.
import type { VideoAgent } from '../../sdk/src/index.js'
import type { Inputs } from './inputs.js'
import type { Run } from './main.js'
import type { Video } from './state.js'

export type BudgetResult =
  | { ok: true }
  | { ok: false; kind: 'limit'; cap: 'max-versions'; used: number; limit: number }
  | {
      ok: false
      kind: 'budget'
      cap: 'max-runs-per-day' | 'max-credits-per-month'
      used: number
      limit: number
    }

const DAY = 24 * 3600_000
/** CI videos live with their PR: the daily count looks at videos made in the last 30 days (a documented gap). */
const LOOKBACK = 30 * DAY

/** Runs this account started in the last 24 hours: versions created in the window, plus retried attempts. */
export async function runsToday(va: VideoAgent, now: number): Promise<number> {
  const since = now - DAY
  const oldest = now - LOOKBACK
  let count = 0
  let cursor: string | undefined
  for (;;) {
    const page = await va.videos.list({ owner: 'me', limit: 50, ...(cursor ? { cursor } : {}) })
    let done = false
    for (const v of page.items) {
      if (Date.parse(v.createdAt) < oldest) {
        done = true
        break
      }
      for (const x of v.versions) {
        if (Date.parse(x.createdAt) >= since) count++
        // A retry is a new attempt of the same version; its latest attempt's queue time says when.
        if (x.attempts > 1 && x.timings && Date.parse(x.timings.queuedAt) >= since) count++
      }
    }
    cursor = page.nextCursor ?? undefined
    if (done || !cursor) return count
  }
}

/** Whether another run may start now. `video` is the one a revise or retry would add to. */
export async function checkBudget(
  run: Run,
  va: VideoAgent,
  inputs: Inputs,
  o: { video?: Video | null; newVersion: boolean },
): Promise<BudgetResult> {
  if (o.video && o.newVersion && o.video.versions.length >= inputs.maxVersions) {
    run.log.line({
      budget: 'limit',
      cap: 'max-versions',
      used: o.video.versions.length,
      limit: inputs.maxVersions,
    })
    return {
      ok: false,
      kind: 'limit',
      cap: 'max-versions',
      used: o.video.versions.length,
      limit: inputs.maxVersions,
    }
  }
  const runs = await runsToday(va, run.deps.now())
  run.log.line({ budget: 'runs-per-day', used: runs, limit: inputs.maxRunsPerDay })
  if (runs >= inputs.maxRunsPerDay)
    return { ok: false, kind: 'budget', cap: 'max-runs-per-day', used: runs, limit: inputs.maxRunsPerDay }
  if (inputs.maxCreditsPerMonth !== null) {
    const usage = await va.me.usage()
    const used = Math.round(usage.runs.credits)
    run.log.line({ budget: 'credits-per-month', used, limit: inputs.maxCreditsPerMonth })
    if (usage.runs.unknown)
      run.log.warn("some runs' credits aren't known yet, so this month's figure may be low")
    if (used >= inputs.maxCreditsPerMonth)
      return {
        ok: false,
        kind: 'budget',
        cap: 'max-credits-per-month',
        used,
        limit: inputs.maxCreditsPerMonth,
      }
  }
  return { ok: true }
}
