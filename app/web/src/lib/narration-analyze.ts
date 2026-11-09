// A take's waveform peaks and speech spans from its decoded audio (docs/plans/2026-11-02-record-your-own-voiceover.md
// §2.4, §5.2): the same PeaksBuilder and SpeechDetector the recorder's worker runs, over mono samples at 24 kHz, in
// one-second blocks. Pure, so it runs in the analysis worker (narration-analyze.worker.ts) and, where a worker can't
// start, on the page.
import { encodePeaks, PeaksBuilder, SpeechDetector } from '../../../server/lib/peaks'
import { SAMPLE_RATE, type Span } from '../../../server/lib/timeline'

export interface AnalyzedAudio {
  /** Length in samples at 24 kHz. */
  samples: number
  /** peaks.bin, ready to upload. */
  peaks: Uint8Array
  /** Speech as [start, end) source samples. */
  spans: Span[]
}

export function analyzeSamples(mono: Float32Array): AnalyzedAudio {
  const peaks = new PeaksBuilder()
  const speech = new SpeechDetector()
  for (let at = 0; at < mono.length; at += SAMPLE_RATE) {
    const block = mono.subarray(at, Math.min(mono.length, at + SAMPLE_RATE))
    peaks.push(block)
    speech.push(block)
  }
  return { samples: mono.length, peaks: encodePeaks(peaks.finish()), spans: speech.finish() }
}
