// Per-route calibration (calibration.ts): route keying, the store (with and without working storage), invalidation,
// the clap and loopback maths with outliers, and clap detection on synthetic signals.
import { describe, expect, it } from 'vitest'
import { SAMPLE_RATE } from '../../../../server/lib/timeline'
import {
  CALIBRATION_STORAGE_KEY,
  CalibrationStore,
  clapCalibration,
  DEFAULT_CALIBRATION,
  detectClaps,
  latencyToOffsetSamples,
  loopbackCalibration,
  matchLatencies,
  msToOffsetSamples,
  routeKey,
  routeOf,
  type AudioRoute,
  type CalibrationResult,
} from './calibration'
import { placeRecordedTake } from './placement'

const route: AudioRoute = { inputDeviceId: 'mic-1', outputDeviceId: 'default', sampleRate: 48_000 }

function memoryStorage() {
  const m = new Map<string, string>()
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  }
}

const result = (latencyMs: number): CalibrationResult => ({
  method: 'clap',
  latencyMs,
  sdMs: 3,
  n: 8,
  dropped: [],
  matched: 8,
  of: 8,
})

describe('routes', () => {
  it('keys on input device, output device (or default) and sample rate', () => {
    expect(routeKey(route)).toBe('mic-1|default|48000')
    expect(routeKey({ ...route, outputDeviceId: '' })).toBe('mic-1|default|48000')
    expect(routeKey({ ...route, sampleRate: 44_100 })).not.toBe(routeKey(route))
    expect(routeKey({ ...route, outputDeviceId: 'headphones' })).not.toBe(routeKey(route))
  })

  it('reads the route off the mic track and the context', () => {
    const track = { getSettings: () => ({ deviceId: 'mic-2' }) }
    expect(routeOf(track, { sampleRate: 44_100, sinkId: 'usb' })).toEqual({
      inputDeviceId: 'mic-2',
      outputDeviceId: 'usb',
      sampleRate: 44_100,
    })
    // No setSinkId (Safari): sinkId is undefined; a chosen-nothing sink is ''.
    expect(routeOf(null, { sampleRate: 48_000 }).outputDeviceId).toBe('default')
    expect(routeOf(track, { sampleRate: 48_000, sinkId: '' }).outputDeviceId).toBe('default')
  })
})

describe('CalibrationStore', () => {
  it('prompts on a new route, persists a calibration per route, and a different route prompts again', () => {
    const storage = memoryStorage()
    const s = new CalibrationStore(storage)
    expect(s.needsCalibration(route)).toBe(true)
    s.save(route, result(42), new Date('2026-11-03T00:00:00Z'))
    expect(s.needsCalibration(route)).toBe(false)
    const again = new CalibrationStore(storage)
    expect(again.get(route).calibration).toEqual({
      method: 'clap',
      latencyMs: 42,
      sdMs: 3,
      n: 8,
      at: '2026-11-03T00:00:00.000Z',
      provisional: DEFAULT_CALIBRATION.provisional,
    })
    expect(again.needsCalibration({ ...route, sampleRate: 44_100 })).toBe(true)
    expect(again.needsCalibration({ ...route, inputDeviceId: 'mic-2' })).toBe(true)
    expect(again.needsCalibration({ ...route, outputDeviceId: 'bt-headset' })).toBe(true)
  })

  it('notes route changes', () => {
    const s = new CalibrationStore(memoryStorage())
    expect(s.noteRoute(route)).toEqual({ changed: false, previous: null })
    expect(s.noteRoute(route).changed).toBe(false)
    expect(s.noteRoute({ ...route, inputDeviceId: 'mic-2' })).toEqual({
      changed: true,
      previous: routeKey(route),
    })
  })

  it('invalidates one route and keeps the others', () => {
    const s = new CalibrationStore(memoryStorage())
    const other = { ...route, inputDeviceId: 'mic-2' }
    s.save(route, result(40))
    s.save(other, result(60))
    s.invalidate(route)
    expect(s.needsCalibration(route)).toBe(true)
    expect(s.get(other).calibration?.latencyMs).toBe(60)
  })

  it('works without storage, with throwing storage and with corrupt JSON', () => {
    for (const storage of [
      null,
      {
        getItem: () => {
          throw new Error('SecurityError')
        },
        setItem: () => {
          throw new Error('QuotaExceededError')
        },
        removeItem: () => undefined,
      },
      { ...memoryStorage(), getItem: () => '{not json' },
    ]) {
      const s = new CalibrationStore(storage)
      expect(s.needsCalibration(route)).toBe(true)
      s.save(route, result(30))
      s.setManual(route, 12)
      expect(s.get(route)).toMatchObject({ calibration: { latencyMs: 30 }, manualMs: 12 })
    }
  })

  it('gives placeRecordedTake its offsets: calibration moves the take earlier, manual + is later', () => {
    const storage = memoryStorage()
    const s = new CalibrationStore(storage)
    expect(s.offsetsFor(route)).toEqual({ calibrationOffsetSamples: 0, manualOffsetSamples: 0 })
    s.save(route, result(45))
    s.setManual(route, 5)
    const o = s.offsetsFor(route)
    expect(o).toEqual({ calibrationOffsetSamples: -1080, manualOffsetSamples: 120 })
    expect(s.offsetsFor(route, -10).manualOffsetSamples).toBe(-240)
    expect(JSON.parse(storage.m.get(CALIBRATION_STORAGE_KEY)!).routes[routeKey(route)].manualMs).toBe(5)
    const [clip] = placeRecordedTake(
      [
        {
          fromSample: 0,
          toSample: SAMPLE_RATE,
          a: 1,
          b: 1 / SAMPLE_RATE,
          residualRms: 0,
          residualMax: 0,
          n: 30,
        },
      ],
      o.calibrationOffsetSamples,
      o.manualOffsetSamples,
    )
    expect(clip!.offsetSamples).toBe(-960)
    expect(clip!.start).toBe(SAMPLE_RATE - 960)
  })

  it('converts ms and samples at the timeline rate', () => {
    expect(latencyToOffsetSamples(10)).toBe(-240)
    expect(msToOffsetSamples(-2.5)).toBe(-60)
  })
})

describe('clap-on-flash and loopback maths', () => {
  const flashes = Array.from({ length: 8 }, (_, k) => 2000 + k * 1200)

  it('matches each flash to one clap in its window', () => {
    expect(matchLatencies([0, 1000], [40, 45, 1050], [-250, 600])).toEqual([40, 1050 - 1000])
    // The nearest, not the first: a stray clap 160 ms before the second flash doesn't take its slot.
    expect(matchLatencies([0, 500], [45, 340, 545], [-250, 250])).toEqual([45, 45])
    expect(matchLatencies([0], [-300, 700], [-250, 600])).toEqual([])
  })

  it('takes the median after dropping MAD outliers', () => {
    const lat = [41, 44, 290, 43, 39, 46, -180, 42]
    const out = clapCalibration(
      flashes,
      flashes.map((f, i) => f + (lat[i] ?? 0)),
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.dropped.sort((p, q) => p - q)).toEqual([-180, 290])
    expect(out.result.n).toBe(6)
    expect(out.result.latencyMs).toBe(42.5)
    expect(out.result.sdMs).toBeLessThan(3)
  })

  it('fails with too few claps (missed or out of window), so the manual offset is the fallback', () => {
    const out = clapCalibration(
      flashes,
      flashes.slice(0, 4).map((f) => f + 40),
    )
    expect(out).toEqual({ ok: false, reason: 'too-few', matched: 4, of: 8 })
  })

  it('holds the window within half the flash interval, so a late clap is not taken for the next flash', () => {
    const fast = Array.from({ length: 8 }, (_, k) => 1000 + k * 250)
    const claps = fast.map((f, i) => f + 45 + (i === 2 ? 300 : 0))
    const out = clapCalibration(fast, claps, { intervalMs: 250 })
    expect(out.ok && out.result).toMatchObject({ matched: 7, latencyMs: 45 })
  })

  it('loopback uses a tight window and floor', () => {
    const clicks = Array.from({ length: 8 }, (_, k) => 1000 + k * 600)
    const out = loopbackCalibration(
      clicks,
      clicks.map((c, i) => c + 12 + (i % 2) * 0.5),
    )
    expect(out.ok && out.result.method).toBe('loopback')
    expect(out.ok && out.result.latencyMs).toBe(12.25)
  })
})

describe('clap detection', () => {
  /** Claps: 5 ms noise bursts with a 60 ms room tail, over a speech-band hum and floor noise. */
  function claps(at: number[], sr: number, peaks: number[] = []) {
    let s = 3
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32) * 2 - 1
    const x = new Float32Array(sr * 12)
    for (let i = 0; i < x.length; i++) x[i] = 0.05 * Math.sin((2 * Math.PI * 180 * i) / sr) + 0.002 * rnd()
    at.forEach((t, k) => {
      const i0 = Math.round(t * sr)
      for (let j = 0; j < sr * 0.08; j++) {
        const env = j < sr * 0.005 ? 1 : Math.exp(-(j - sr * 0.005) / (sr * 0.02))
        x[i0 + j] = (x[i0 + j] ?? 0) + (peaks[k] ?? 0.6) * env * rnd()
      }
    })
    return x
  }

  for (const sr of [48_000, 44_100]) {
    it(`finds each clap within a millisecond, once (${sr} Hz)`, () => {
      const at = [1.0, 2.2, 3.4, 4.6, 5.8, 7.0, 8.2, 9.4]
      const found = detectClaps(claps(at, sr), sr)
      expect(found).toHaveLength(8)
      found.forEach((o, i) => expect(Math.abs(o.sample / sr - at[i]!) * 1000).toBeLessThan(1))
    })
  }

  it('end to end: claps 45 ms after flashes with one late clap and one quiet miss give 45 ms', () => {
    const sr = 48_000
    const flashAt = [1.0, 2.2, 3.4, 4.6, 5.8, 7.0, 8.2, 9.4]
    const clapAt = flashAt.map((f, i) => f + 0.045 + (i === 3 ? 0.25 : 0) + ((i % 3) - 1) * 0.002)
    const peaks = clapAt.map((_, i) => (i === 6 ? 0.004 : 0.6))
    const found = detectClaps(claps(clapAt, sr, peaks), sr).map((o) => (o.sample / sr) * 1000)
    expect(found).toHaveLength(7)
    const out = clapCalibration(
      flashAt.map((f) => f * 1000),
      found,
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.matched).toBe(7)
    expect(out.result.dropped).toHaveLength(1)
    expect(Math.abs(out.result.latencyMs - 45)).toBeLessThan(2.5)
  })
})
