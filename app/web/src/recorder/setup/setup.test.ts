// The setup panel's pure parts (plan 2026-11-02 §2.1 step 2): level verdict maths, recorder options, the NarrationOp
// track patch, the remembered mic with broken storage, and mic error classification.
import { describe, expect, it } from 'vitest'
import { FLOOR_DB, levelVerdict, measure, meterPercent, toDb } from './level'
import { browserOf, micProblem } from './mic'
import {
  defaultSetup,
  loadDeviceId,
  monitorDbWhileRecording,
  originalAudio,
  saveDeviceId,
  setupFromTracks,
  setupToRecorderOptions,
  setupToTrackPatch,
  withOriginalAudio,
  withOutputMode,
} from './setup'

const db = (d: number) => 10 ** (d / 20)
const steady = (rmsDb: number, peakDb: number, n = 60) =>
  Array.from({ length: n }, () => ({ rms: db(rmsDb), peak: db(peakDb) }))

describe('level maths', () => {
  it('converts to dBFS with a floor', () => {
    expect(toDb(1)).toBe(0)
    expect(toDb(0.5)).toBeCloseTo(-6.02, 2)
    expect(toDb(0)).toBe(FLOOR_DB)
    expect(toDb(1e-9)).toBe(FLOOR_DB)
    expect(meterPercent(0)).toBe(100)
    expect(meterPercent(FLOOR_DB)).toBe(0)
    expect(meterPercent(-30)).toBe(50)
  })

  it('measures RMS and peak of a block', () => {
    const sine = Array.from({ length: 4800 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48_000))
    const l = measure(sine)
    expect(l.peak).toBeCloseTo(0.5, 2)
    expect(l.rms).toBeCloseTo(0.5 / Math.SQRT2, 2)
    expect(measure([])).toEqual({ rms: 0, peak: 0 })
  })

  it('reports too quiet under -40 dBFS RMS, OK above, clipping at -1 dBFS peak', () => {
    expect(levelVerdict(steady(-45, -30)).verdict).toBe('quiet')
    expect(levelVerdict(steady(-40, -25)).verdict).toBe('ok')
    expect(levelVerdict(steady(-18, -6)).verdict).toBe('ok')
    expect(levelVerdict(steady(-18, -1)).verdict).toBe('clipping')
    expect(levelVerdict(steady(-18, -1.01)).verdict).toBe('ok')
    // Clipping wins over quiet: one hot peak in a quiet take.
    expect(levelVerdict([...steady(-50, -45), { rms: db(-50), peak: 1 }]).verdict).toBe('clipping')
    expect(levelVerdict([])).toEqual({ verdict: 'quiet', rmsDb: FLOOR_DB, peakDb: FLOOR_DB })
  })

  it('judges the speaking level, not the pauses (90th percentile RMS)', () => {
    // A third speech at -20 dBFS, the rest near-silence: the mean would read too quiet, speech doesn't.
    const r = [...steady(-70, -65, 40), ...steady(-20, -8, 20)]
    const v = levelVerdict(r)
    expect(v.verdict).toBe('ok')
    expect(v.rmsDb).toBeCloseTo(-20, 5)
    expect(v.peakDb).toBeCloseTo(-8, 5)
    // Only a few loud blocks (under 10%) don't lift it.
    expect(levelVerdict([...steady(-70, -65, 95), ...steady(-20, -8, 5)]).verdict).toBe('quiet')
  })
})

describe('recorder options and monitor', () => {
  it('headphones: echo cancellation off, monitor at full level', () => {
    const v = defaultSetup(null)
    expect(v.outputMode).toBe('headphones')
    expect(setupToRecorderOptions(v)).toEqual({ echoCancellation: false })
    expect(monitorDbWhileRecording(v)).toBe(0)
  })

  it('speakers: echo cancellation on, monitor muted or ducked to -30 dB', () => {
    const v = withOutputMode(defaultSetup('mic-2'), 'speakers')
    expect(v.echoCancellation).toBe(true)
    expect(setupToRecorderOptions(v)).toEqual({ deviceId: 'mic-2', echoCancellation: true })
    expect(monitorDbWhileRecording(v)).toBeNull()
    expect(monitorDbWhileRecording({ ...v, monitorDuringRecord: 'duck' })).toBe(-30)
    const back = withOutputMode(v, 'headphones')
    expect(back.echoCancellation).toBe(false)
    expect(setupToRecorderOptions(back).echoCancellation).toBe(false)
  })

  it('echo cancellation follows the output mode even if the value disagrees', () => {
    expect(setupToRecorderOptions({ ...defaultSetup(null), echoCancellation: true }).echoCancellation).toBe(
      false,
    )
  })
})

describe('track patch', () => {
  it('maps each original-audio choice to NarrationOp tracks', () => {
    const v = defaultSetup(null)
    expect(setupToTrackPatch(v)).toEqual({
      aiVoice: { mode: 'replace', volumeDb: -12 },
      original: { muteAll: false },
    })
    const under = withOriginalAudio({ ...v, aiVoiceDb: -18 }, 'under')
    expect(setupToTrackPatch(under)).toEqual({
      aiVoice: { mode: 'under', volumeDb: -18 },
      original: { muteAll: false },
    })
    const muted = withOriginalAudio(under, 'muteAll')
    expect(originalAudio(muted)).toBe('muteAll')
    expect(setupToTrackPatch(muted).original.muteAll).toBe(true)
    // Muting all keeps the AI voice choice underneath; picking a mode again unmutes.
    expect(muted.aiVoiceMode).toBe('under')
    expect(withOriginalAudio(muted, 'replace')).toMatchObject({ aiVoiceMode: 'replace', muteAll: false })
  })

  it('clamps the AI voice level to -40..0 dB, whole dB', () => {
    expect(setupToTrackPatch({ ...defaultSetup(null), aiVoiceDb: -55 }).aiVoice.volumeDb).toBe(-40)
    expect(setupToTrackPatch({ ...defaultSetup(null), aiVoiceDb: 3 }).aiVoice.volumeDb).toBe(0)
    expect(setupToTrackPatch({ ...defaultSetup(null), aiVoiceDb: -12.4 }).aiVoice.volumeDb).toBe(-12)
    expect(setupToTrackPatch({ ...defaultSetup(null), aiVoiceDb: Number.NaN }).aiVoice.volumeDb).toBe(-12)
  })

  it('round-trips from an existing op', () => {
    const base = defaultSetup(null)
    for (const v of [
      base,
      withOriginalAudio({ ...base, aiVoiceDb: -20 }, 'under'),
      withOriginalAudio(base, 'muteAll'),
    ])
      expect(setupToTrackPatch(setupFromTracks(setupToTrackPatch(v), base))).toEqual(setupToTrackPatch(v))
    // 'keep' (the AI voice untouched) reads as under at 0 dB.
    expect(
      setupFromTracks({ aiVoice: { mode: 'keep', volumeDb: -12 }, original: { muteAll: false } }, base),
    ).toMatchObject({ aiVoiceMode: 'under', aiVoiceDb: 0 })
  })
})

describe('remembered mic', () => {
  const memory = () => {
    const m = new Map<string, string>()
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => m.set(k, v),
      removeItem: (k: string) => m.delete(k),
    } as unknown as Storage
  }
  const broken = {
    getItem: () => {
      throw new Error('SecurityError')
    },
    setItem: () => {
      throw new Error('QuotaExceededError')
    },
    removeItem: () => {
      throw new Error('SecurityError')
    },
  } as unknown as Storage

  it('saves, loads and clears the chosen device', () => {
    const s = memory()
    expect(loadDeviceId(s)).toBeNull()
    saveDeviceId('mic-2', s)
    expect(loadDeviceId(s)).toBe('mic-2')
    saveDeviceId(null, s)
    expect(loadDeviceId(s)).toBeNull()
  })

  it('falls back to the default mic when storage throws or is missing', () => {
    expect(() => saveDeviceId('mic-2', broken)).not.toThrow()
    expect(() => saveDeviceId(null, broken)).not.toThrow()
    expect(loadDeviceId(broken)).toBeNull()
    expect(loadDeviceId(null)).toBeNull()
    // Node has no localStorage: the default storage is missing too.
    expect(defaultSetup().deviceId).toBeNull()
  })
})

describe('mic problems', () => {
  const err = (name: string) => Object.assign(new Error(name), { name })
  it('classifies getUserMedia errors', () => {
    expect(micProblem(err('NotAllowedError'))).toBe('denied')
    expect(micProblem(err('SecurityError'))).toBe('denied')
    expect(micProblem(err('NotFoundError'))).toBe('missing')
    expect(micProblem(err('OverconstrainedError'))).toBe('missing')
    expect(micProblem(err('NotReadableError'))).toBe('busy')
    expect(micProblem(new Error('x'))).toBe('failed')
    expect(micProblem('nope')).toBe('failed')
  })

  it('tells the browsers apart for the help text', () => {
    const chrome =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
    const safari =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
    const firefox = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0'
    expect(browserOf(chrome)).toBe('chrome')
    expect(browserOf(safari)).toBe('safari')
    expect(browserOf(firefox)).toBe('firefox')
    expect(browserOf('curl/8')).toBe('other')
  })
})
