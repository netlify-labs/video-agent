import { describe, expect, it } from 'vitest'
import { clampModel, DEFAULT_DEEP_MODEL, estimateCredits } from './gateway-models.js'

describe('planning models', () => {
  it('clamps anything outside the allowlist to the default deep model', () => {
    expect(clampModel('claude-opus-5-5')).toBe('claude-opus-5-5')
    expect(clampModel('gpt-6')).toBe(DEFAULT_DEEP_MODEL)
    expect(clampModel(null)).toBe(DEFAULT_DEEP_MODEL)
  })
  it('estimates credits from token prices (180 credits per US$), including cache tokens', () => {
    // Haiku: 300 in × $1/M + 900 out × $5/M = $0.0048 → 0.86 credits
    expect(
      estimateCredits('claude-haiku-4-5', {
        inputTokens: 300,
        outputTokens: 900,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(0.86)
    // Sonnet with cache reads is cheaper than without.
    const fresh =
      estimateCredits('claude-sonnet-5', {
        inputTokens: 2000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }) ?? 0
    const cached =
      estimateCredits('claude-sonnet-5', {
        inputTokens: 200,
        outputTokens: 500,
        cacheReadTokens: 1800,
        cacheWriteTokens: 0,
      }) ?? 0
    expect(cached).toBeLessThan(fresh)
    expect(
      estimateCredits('jev-1.14.0', {
        inputTokens: 330,
        outputTokens: 60,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBeLessThan(0.1)
    expect(
      estimateCredits('mystery-model', {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBeNull()
  })
})
