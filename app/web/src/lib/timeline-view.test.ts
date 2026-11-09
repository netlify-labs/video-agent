import { describe, expect, it } from 'vitest'
import { computePeaks, PEAKS_BASE_BIN } from '../../../server/lib/peaks'
import { SAMPLE_RATE } from '../../../server/lib/timeline'
import { applyTrackPatch } from '../components/timeline/track-patch'
import {
  clampZoom,
  fitZoom,
  formatTime,
  inWindow,
  MAX_PX_PER_SEC,
  MIN_PX_PER_SEC,
  peaksLevelFor,
  sampleToX,
  tickStep,
  ticks,
  visibleWindow,
  waveformColumns,
  wheelZoom,
  WINDOW_TILE_PX,
  xToSample,
  zoomBy,
} from './timeline-view'

describe('zoom', () => {
  it('clamps pixels per second and falls back on nonsense', () => {
    expect(clampZoom(0.01)).toBe(MIN_PX_PER_SEC)
    expect(clampZoom(1e9)).toBe(MAX_PX_PER_SEC)
    expect(clampZoom(Number.NaN)).toBeGreaterThanOrEqual(MIN_PX_PER_SEC)
    expect(clampZoom(120)).toBe(120)
  })

  it('maps samples and pixels both ways', () => {
    expect(sampleToX(SAMPLE_RATE * 2, 50)).toBe(100)
    expect(xToSample(100, 50)).toBe(SAMPLE_RATE * 2)
  })

  it('keeps the time under the anchor fixed', () => {
    const before = { pxPerSec: 40, scrollLeft: 400 }
    const anchorX = 300
    const t = (before.scrollLeft + anchorX) / before.pxPerSec
    const after = zoomBy(before, 2, anchorX)
    expect(after.pxPerSec).toBe(80)
    expect((after.scrollLeft + anchorX) / after.pxPerSec).toBeCloseTo(t, 9)
  })

  it('never scrolls before the start, and stops at the zoom limits', () => {
    expect(zoomBy({ pxPerSec: 40, scrollLeft: 0 }, 0.5, 300).scrollLeft).toBe(0)
    expect(zoomBy({ pxPerSec: MAX_PX_PER_SEC, scrollLeft: 0 }, 4, 0).pxPerSec).toBe(MAX_PX_PER_SEC)
  })

  it('wheels down to zoom out and up to zoom in, symmetrically', () => {
    const v = { pxPerSec: 100, scrollLeft: 0 }
    const out = wheelZoom(v, 100, 0)
    expect(out.pxPerSec).toBeLessThan(100)
    expect(wheelZoom(out, -100, 0).pxPerSec).toBeCloseTo(100, 9)
  })

  it('fits a duration into a width', () => {
    expect(fitZoom(60 * SAMPLE_RATE, 1200)).toBe(20)
    expect(fitZoom(0, 1200)).toBeGreaterThan(0)
  })
})

describe('virtualization window', () => {
  it('covers the viewport plus a viewport either side, on tile edges', () => {
    const [from, to] = visibleWindow(5000, 1000, 100)
    const fromX = sampleToX(from, 100)
    const toX = sampleToX(to, 100)
    expect(fromX).toBeLessThanOrEqual(4000)
    expect(toX).toBeGreaterThanOrEqual(7000)
    expect(Math.round(fromX) % WINDOW_TILE_PX).toBe(0)
    expect(Math.round(toX) % WINDOW_TILE_PX).toBe(0)
  })

  it("doesn't change while scrolling inside a tile", () => {
    expect(visibleWindow(5200, 1000, 100)).toEqual(visibleWindow(5300, 1000, 100))
    expect(visibleWindow(5200, 1000, 100)).not.toEqual(visibleWindow(5200 + WINDOW_TILE_PX, 1000, 100))
  })

  it('starts at zero', () => {
    expect(visibleWindow(0, 1000, 100)[0]).toBe(0)
  })

  it('finds the sorted items overlapping the window', () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ s: i * 10, e: i * 10 + 8 }))
    const got = inWindow(items, [95, 131], (x) => [x.s, x.e])
    expect(got.map((x) => x.s)).toEqual([90, 100, 110, 120, 130])
    expect(inWindow(items, [5000, 6000], (x) => [x.s, x.e])).toEqual([])
    expect(inWindow(items, [8, 10], (x) => [x.s, x.e])).toEqual([])
    expect(inWindow([], [0, 10], (x: { s: number; e: number }) => [x.s, x.e])).toEqual([])
  })

  it('keeps a ten-minute, 200-clip narration to a handful of clips at a time', () => {
    const step = 3 * SAMPLE_RATE
    const clips = Array.from(
      { length: 200 },
      (_, i) => [i * step, i * step + 2.6 * SAMPLE_RATE] as [number, number],
    )
    const pps = 100
    const win = visibleWindow(sampleToX(300 * SAMPLE_RATE, pps), 1200, pps)
    const shown = inWindow(clips, win, (c) => c)
    expect(shown.length).toBeGreaterThan(5)
    expect(shown.length).toBeLessThan(20)
  })
})

describe('ruler', () => {
  it('picks wider steps as the zoom goes out', () => {
    expect(tickStep(1000).step).toBe(1 / 10)
    expect(tickStep(100).step).toBe(1)
    expect(tickStep(10).step).toBe(10)
    expect(tickStep(2).step).toBe(60)
    expect(tickStep(1).step).toBe(120)
    for (const pps of [1, 2, 5, 13, 40, 99, 333, 1000])
      expect(tickStep(pps).step * pps).toBeGreaterThanOrEqual(72)
  })

  it('puts majors on step multiples with minors between', () => {
    const t = ticks(0, 3, 100)
    expect(t.filter((x) => x.major).map((x) => x.t)).toEqual([0, 1, 2])
    expect(t.length).toBe(15)
    expect(ticks(10, 12, 100)[0]).toEqual({ t: 10, major: true })
  })

  it('formats times for the step', () => {
    expect(formatTime(65)).toBe('1:05')
    expect(formatTime(12.5, 0.5)).toBe('0:12.5')
    expect(formatTime(3.4, 1 / 30)).toBe('0:03+12f')
    expect(formatTime(3, 1 / 30)).toBe('0:03')
  })
})

describe('waveform peaks', () => {
  const samples = new Float32Array(SAMPLE_RATE * 60)
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 10) * (i < SAMPLE_RATE * 30 ? 0.5 : 1)
  const peaks = computePeaks(samples)

  it('chooses the coarsest level no wider than a device pixel', () => {
    // 24,000 samples a second at 10 px/s is 2,400 samples a pixel: level 1 (2,048) fits, level 2 (4,096) doesn't.
    expect(peaksLevelFor(peaks, 10).samplesPerBin).toBe(PEAKS_BASE_BIN * 2)
    // On a 2x screen each device pixel is half as wide.
    expect(peaksLevelFor(peaks, 10, 2).samplesPerBin).toBe(PEAKS_BASE_BIN)
    // Zoomed past level 0, the finest is used.
    expect(peaksLevelFor(peaks, 1000).samplesPerBin).toBe(PEAKS_BASE_BIN)
    expect(peaksLevelFor(peaks, 0.01).samplesPerBin).toBeGreaterThan(PEAKS_BASE_BIN * 64)
  })

  it('builds one min/max per column from the bins it covers', () => {
    const cols = waveformColumns(peaks, 0, 60 * SAMPLE_RATE, 60, 1)
    expect(cols.length).toBe(120)
    // First half at 0.5, second at 1: about ±64 and ±127.
    expect(cols[0]).toBeLessThan(-55)
    expect(cols[1]).toBeGreaterThan(55)
    expect(cols[1]).toBeLessThan(70)
    expect(cols[119]).toBe(127)
  })

  it('leaves columns past the take silent', () => {
    const cols = waveformColumns(peaks, 59 * SAMPLE_RATE, 61 * SAMPLE_RATE, 20, 10)
    expect(cols[0]).not.toBe(0)
    expect(cols[38]).toBe(0)
    expect(cols[39]).toBe(0)
    expect(waveformColumns(peaks, 0, 0, 10, 10).every((v) => v === 0)).toBe(true)
  })
})

describe('track patches', () => {
  const tracks = {
    narration: { volumeDb: 0, muted: false, solo: false },
    aiVoice: { mode: 'keep' as const, volumeDb: 0 },
    music: { duck: false, duckDb: -12 },
    original: { muteAll: false },
  }

  it('changes one field of one lane', () => {
    const next = applyTrackPatch(tracks, { lane: 'narration', set: { muted: true } })
    expect(next.narration).toEqual({ volumeDb: 0, muted: true, solo: false })
    expect(next.music).toBe(tracks.music)
    expect(applyTrackPatch(tracks, { lane: 'music', set: { duck: true } }).music.duck).toBe(true)
    expect(applyTrackPatch(tracks, { lane: 'aiVoice', set: { mode: 'replace' } }).aiVoice.mode).toBe(
      'replace',
    )
  })

  it("leaves the op alone for the music layer's own level", () => {
    expect(applyTrackPatch(tracks, { lane: 'musicLevel', audioId: 'm', set: { muted: true } })).toBe(tracks)
  })
})
