// Planning models and credit pricing (plan v2 §14 rules 14 and 17). Prices are list prices in US$ per million tokens
// (estimates: the Gateway bills from provider pricing at 180 credits per US$).
import type { GatewayUsage } from '../deps.js'

export const PLAN_MODELS = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5-5'] as const
export type PlanModel = (typeof PLAN_MODELS)[number]
export const DEFAULT_DEEP_MODEL: PlanModel = 'claude-sonnet-5'
export const FAST_MODEL: PlanModel = 'claude-haiku-4-5'

const PRICES: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  'claude-haiku-4-5': { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-sonnet-5': { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-opus-5-5': { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  // jev routing calls are tiny; priced conservatively.
  jev: { in: 0.5, out: 1.5, cacheRead: 0, cacheWrite: 0 },
}
export const CREDITS_PER_USD = 180

/** Clamps a model to the allowlist (the deep model is an admin setting; anything else falls back to the default). */
export const clampModel = (m: string | null | undefined): PlanModel =>
  (PLAN_MODELS as readonly string[]).includes(m ?? '') ? (m as PlanModel) : DEFAULT_DEEP_MODEL

/** Estimated credits for one call, or null when the model has no known price. */
export function estimateCredits(model: string, u: GatewayUsage): number | null {
  const p = PRICES[model.startsWith('jev') ? 'jev' : model]
  if (!p) return null
  const usd =
    (u.inputTokens * p.in +
      u.outputTokens * p.out +
      u.cacheReadTokens * p.cacheRead +
      u.cacheWriteTokens * p.cacheWrite) /
    1_000_000
  return Math.round(usd * CREDITS_PER_USD * 100) / 100
}
