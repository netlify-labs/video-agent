// AudioClock (audio-clock.ts): the render and output maps, getOutputTimestamp feature detection and the fallback.
import { describe, expect, it } from 'vitest'
import { AudioClock, type ClockContext } from './audio-clock'

function ctx(time: { now: number }, output: boolean): ClockContext {
  const c: { -readonly [K in keyof ClockContext]: ClockContext[K] } = {
    sampleRate: 48_000,
    baseLatency: 0.005,
    outputLatency: 0.025,
    get currentTime() {
      return Math.floor(((time.now - 500) / 1000) * 375) / 375
    },
  }
  // Heard 30 ms after rendered.
  if (output)
    c.getOutputTimestamp = () => ({ contextTime: (time.now - 530) / 1000, performanceTime: time.now })
  return c
}

describe('AudioClock', () => {
  it('maps context time to perf through the render map, and frames to take samples', () => {
    const time = { now: 600 }
    const k = new AudioClock(ctx(time, true), () => time.now)
    for (; time.now < 2000; time.now += 5) k.sample()
    // Quantized currentTime is seen up to one quantum (2.7 ms) late; the fit sits in between.
    expect(k.contextToPerf(1)).toBeGreaterThan(1500)
    expect(k.contextToPerf(1)).toBeLessThan(1503)
    expect(k.perfToContext(k.contextToPerf(0.75))).toBeCloseTo(0.75, 9)
    expect(k.frameToPerf(48_000)).toBeCloseTo(k.contextToPerf(1), 9)
    const x = k.perfToTakeSample(k.contextToPerf(1.5), 48_000, 24_000)
    expect(x).toBeCloseTo(12_000, 6)
  })

  it('uses getOutputTimestamp for the output map and never adds outputLatency on top', () => {
    const time = { now: 600 }
    const k = new AudioClock(ctx(time, true), () => time.now)
    for (; time.now < 2000; time.now += 5) k.sample()
    expect(k.hasOutputTimestamp).toBe(true)
    expect(k.outputSource).toBe('getOutputTimestamp')
    expect(k.outputContextToPerf(1)).toBeCloseTo(1530, 6)
    expect(k.perfToOutputContext(1530)).toBeCloseTo(1, 9)
  })

  it('without getOutputTimestamp, falls back to render + baseLatency + outputLatency and says so', () => {
    const time = { now: 600 }
    const k = new AudioClock(ctx(time, false), () => time.now)
    for (; time.now < 2000; time.now += 5) k.sample()
    expect(k.hasOutputTimestamp).toBe(false)
    expect(k.outputSource).toBe('fallback-latency')
    expect(k.fallbackLatencyMs()).toBeCloseTo(30, 9)
    expect(k.outputContextToPerf(1) - k.contextToPerf(1)).toBeCloseTo(30, 9)
  })

  it('ignores getOutputTimestamp before output starts (zero pairs) and repeated pairs', () => {
    const time = { now: 600 }
    const c = ctx(time, false)
    let calls = 0
    c.getOutputTimestamp = () => (calls++, { contextTime: 0, performanceTime: 0 })
    const k = new AudioClock(c, () => time.now)
    for (; time.now < 1000; time.now += 5) k.sample()
    expect(calls).toBeGreaterThan(0)
    expect(k.outputSource).toBe('fallback-latency')
  })
})
