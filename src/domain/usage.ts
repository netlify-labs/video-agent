// Usage views (plan v2 §4, §14 rule 17): agent-run credits from attempts, planning credits from gateway_calls (which
// outlive plans). Planning credits are estimates; calls with an ambiguous outcome count as unknown, never as zero.
import type { Deps } from '../deps.js'
import { isoWeek } from '../store/memory.js'
import { assertCan, type Principal } from './policy.js'
import type { GatewayCallRow } from './types.js'

export interface PlanningUsage {
  credits: number
  calls: number
  unknown: number
}

export function planningByUserWeek(
  rows: GatewayCallRow[],
): Map<string, PlanningUsage & { userId: string; week: string }> {
  const out = new Map<string, PlanningUsage & { userId: string; week: string }>()
  for (const r of rows) {
    const week = isoWeek(r.at)
    const k = `${r.callerId}|${week}`
    const row = out.get(k) ?? { userId: r.callerId, week, credits: 0, calls: 0, unknown: 0 }
    row.calls++
    if (r.credits === null) row.unknown++
    else row.credits += r.credits
    out.set(k, row)
  }
  return out
}

const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()

/** Your runs and planning this calendar month (UTC). */
export async function myUsage(deps: Deps, p: Principal) {
  assertCan(p, 'video:read')
  const since = monthStart(deps.clock.now())
  const [runs, calls] = await Promise.all([
    deps.store.usageSince(since),
    deps.store.listGatewayCalls({ since, callerId: p.userId }),
  ])
  const mine = runs.filter((r) => r.userId === p.userId)
  const runCredits = mine.reduce((t, r) => t + (r.credits ?? 0), 0)
  const planning = planningByUserWeek(calls)
  let pc = 0
  let pcalls = 0
  let unknown = 0
  for (const r of planning.values()) {
    pc += r.credits
    pcalls += r.calls
    unknown += r.unknown
  }
  return {
    since,
    runs: {
      credits: Math.round(runCredits * 100) / 100,
      videos: mine.reduce((t, r) => t + r.videos, 0),
      unknown: mine.some((r) => r.credits === null),
    },
    planning: { credits: Math.round(pc * 100) / 100, calls: pcalls, unknown },
  }
}
