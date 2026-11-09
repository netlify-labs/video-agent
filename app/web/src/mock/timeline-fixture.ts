// Mock mode only: a ten-minute narration of 200 clips over four synthetic takes, with a 20-scene composition, for
// the timeline demo (/dev/timeline) and its Playwright spec. The takes are deterministic speech-like noise (syllables
// at about 4 Hz, phrases with pauses) built into real peaks.bin bytes and decoded back, so the timeline draws from
// the same decodePeaks path as a real take.
import { decodePeaks, encodePeaks, PeaksBuilder, SpeechDetector, type Peaks } from '../../../server/lib/peaks'
import {
  IDENTITY_FIT,
  SAMPLE_RATE,
  type NarrationClip,
  type NarrationOp,
  type Span,
} from '../../../server/lib/timeline'
import type { TimelineComposition } from '../components/timeline'

export const FIXTURE_SECONDS = 600
const SCENES = 20
const TAKES = 4
const CLIPS = 200
const TAKE_SECONDS = 160
const BLOCK = 24_000

function synthTake(seed: number): { peaks: Peaks; spans: Span[] } {
  const peaks = new PeaksBuilder()
  const speech = new SpeechDetector()
  let x = seed * 2_654_435_761
  const block = new Float32Array(BLOCK)
  for (let at = 0; at < TAKE_SECONDS * SAMPLE_RATE; at += BLOCK) {
    for (let i = 0; i < BLOCK; i++) {
      const t = (at + i) / SAMPLE_RATE
      x = (Math.imul(x, 1_103_515_245) + 12_345) | 0
      const noise = (x >>> 8) / 0x800000 - 1
      // Phrases of about 2.4 s with 0.6 s pauses; syllables inside them.
      const phrase = (t + seed) % 3 < 2.4 ? 1 : 0
      const syllable = Math.sin(Math.PI * 4 * t + seed) ** 2
      block[i] = noise * phrase * (0.15 + 0.6 * syllable) * (0.7 + 0.3 * Math.sin(t / 7 + seed))
    }
    peaks.push(block)
    speech.push(block)
  }
  return { peaks: decodePeaks(encodePeaks(peaks.finish())), spans: speech.finish() }
}

export interface TimelineFixture {
  op: NarrationOp
  composition: TimelineComposition
  peaks: Map<string, Peaks>
  takeSpans: Map<string, Span[]>
  takeNames: Map<string, string>
}

export function timelineFixture(): TimelineFixture {
  const peaks = new Map<string, Peaks>()
  const takeSpans = new Map<string, Span[]>()
  const takeNames = new Map<string, string>()
  for (let i = 0; i < TAKES; i++) {
    const id = `med_take_${i + 1}`
    const t = synthTake(i + 1)
    peaks.set(id, t.peaks)
    takeSpans.set(id, t.spans)
    takeNames.set(id, `Take ${i + 1}`)
  }
  // 200 clips of 2.6 s, every 3 s, cycling through the takes.
  const step = (FIXTURE_SECONDS / CLIPS) * SAMPLE_RATE
  const clips: NarrationClip[] = Array.from({ length: CLIPS }, (_, i) => {
    const srcStart = Math.floor(i / TAKES) * step
    return {
      id: `clip_${i + 1}`,
      mediaId: `med_take_${(i % TAKES) + 1}`,
      srcStart,
      srcEnd: srcStart + Math.round(2.6 * SAMPLE_RATE),
      fit: IDENTITY_FIT,
      offsetSamples: 0,
      start: i * step,
      gainDb: 0,
      fadeInSamples: 0,
      fadeOutSamples: 0,
    }
  })
  const sceneSeconds = FIXTURE_SECONDS / SCENES
  const composition: TimelineComposition = {
    duration: FIXTURE_SECONDS,
    beats: Array.from({ length: SCENES }, (_, i) => ({
      id: `scene-${i + 1}`,
      label: `Scene ${i + 1}`,
      start: i * sceneSeconds,
      duration: sceneSeconds,
      voice: { id: `voice-${i + 1}`, src: `assets/voice/scene-${i + 1}.mp3`, start: 0.5, duration: 20 },
    })),
    audio: [{ id: 'music-bed', role: 'music', label: 'Music bed', volume: 0.6, muted: false }],
  }
  const op: NarrationOp = {
    op: 'narration',
    schema: 1,
    sampleRate: SAMPLE_RATE,
    clips,
    tracks: {
      narration: { volumeDb: 0, muted: false, solo: false },
      aiVoice: { mode: 'replace', volumeDb: -12 },
      music: { duck: true, duckDb: -12 },
      original: { muteAll: false },
    },
    cleanup: 'off',
  }
  return { op, composition, peaks, takeSpans, takeNames }
}
