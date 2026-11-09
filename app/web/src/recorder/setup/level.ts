// Level maths for the setup panel's meter and 3 s level check (plan 2026-11-02 §2.1 step 2, §5.1). Pure, so the
// verdict thresholds are unit tested; the meter (use-level-meter.ts) feeds it analyser readings.
import type { Level } from '../recorder'

/** Below this the meter reads empty, and silence reports as this. */
export const FLOOR_DB = -60
/** The speaking level under this is too quiet. */
export const QUIET_DB = -40
/** A peak at or above this is clipping (and latches the clip light). */
export const CLIP_DB = -1
export const CHECK_MS = 3000
export const CLIP_LATCH_MS = 1000

export type Verdict = 'quiet' | 'ok' | 'clipping'

export const toDb = (linear: number) => (linear > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(linear)) : FLOOR_DB)

/** RMS and peak of one block of samples (an analyser's time-domain frame). */
export function measure(block: ArrayLike<number>): Level {
  let sum = 0
  let peak = 0
  for (let i = 0; i < block.length; i++) {
    const x = block[i] ?? 0
    sum += x * x
    const a = Math.abs(x)
    if (a > peak) peak = a
  }
  return { rms: block.length ? Math.sqrt(sum / block.length) : 0, peak }
}

/**
 * The level check's verdict over its readings. Clipping wins: any peak at or above -1 dBFS. Otherwise the speaking
 * level is the 90th percentile of the RMS readings (pauses between words don't count against it), and under -40 dBFS
 * is too quiet. No readings is too quiet.
 */
export function levelVerdict(readings: readonly Level[]): {
  verdict: Verdict
  rmsDb: number
  peakDb: number
} {
  let peak = 0
  for (const r of readings) if (r.peak > peak) peak = r.peak
  const rms = readings.map((r) => r.rms).sort((a, b) => a - b)
  const speaking = rms.length ? (rms[Math.min(rms.length - 1, Math.floor(rms.length * 0.9))] ?? 0) : 0
  const rmsDb = toDb(speaking)
  const peakDb = toDb(peak)
  const verdict: Verdict = peakDb >= CLIP_DB ? 'clipping' : rmsDb < QUIET_DB ? 'quiet' : 'ok'
  return { verdict, rmsDb, peakDb }
}

export const VERDICT_COPY: Record<Verdict, { title: string; help: string }> = {
  quiet: {
    title: 'Too quiet',
    help: "Move closer to the mic or turn its input level up in your system's sound settings, then check again.",
  },
  ok: { title: 'Sounds good', help: 'Speak like that when you record.' },
  clipping: {
    title: 'Too loud',
    help: 'Your voice hit the top of the meter. Move back a little or turn the input level down, then check again.',
  },
}

/** 0..100 on the meter's scale (FLOOR_DB to 0 dBFS). */
export const meterPercent = (db: number) => Math.round(((Math.min(0, db) - FLOOR_DB) / -FLOOR_DB) * 100)
