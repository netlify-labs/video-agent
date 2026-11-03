// Narration captions in the run (plan 2026-11-02 §6.6, bead va-2qq.3.13). After the STT stage, applyNarrationCaptions
// writes the transcript's narration cues into video/summary.json next to every frozen cue (narrationSummary, the same
// function checkNarration recomputes it with). The audible rule applies only when render-job writes captions.vtt
// (captionsForRender): replace keeps just the narration cues, so a version whose transcription failed or was off can
// have none, and captions.vtt is then a valid empty "WEBVTT\n\n". The words stay in .va-run/narration/stt.json for the
// outputs (transcript.txt).
import { readFileSync, writeFileSync } from 'node:fs'
import type { Caption, Summary } from '../../src/lib/contract.js'
import { audibleCaptions, type NarrationCue } from '../../src/lib/narration-captions.js'
import { narrationSummary, type NarrationTranscript } from '../../src/lib/narration-run.js'
import type { NarrationOp } from '../../src/lib/timeline.js'
import { log } from './run-tools.js'

/** Writes the narration cues into summary.json, keeping every other cue. Idempotent: earlier narration cues go. */
export function applyNarrationCaptions(summaryPath: string, stt: NarrationTranscript | null): Summary {
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as Summary
  const next = narrationSummary(summary, stt)
  writeFileSync(summaryPath, JSON.stringify(next, null, 2))
  log('captions.narration', {
    stt: stt?.status ?? 'missing',
    cues: (next.captions ?? []).filter((c) => c.narration).length,
    captions: next.captions?.length ?? 0,
  })
  return next
}

/**
 * The cues render-job turns into captions.vtt: without recorded narration, the summary's as they are; with it, only
 * what the frozen op's tracks leave audible (replace or muteAll: narration cues only; under/keep: narration and the
 * AI voice's interleaved; a muted narration track: no narration cues).
 */
export function captionsForRender(captions: unknown, op: Pick<NarrationOp, 'tracks'> | undefined): unknown {
  if (!op || !Array.isArray(captions)) return captions
  const list = (captions as unknown[]).filter((c): c is Caption => !!c && typeof c === 'object')
  return audibleCaptions(
    list,
    list.filter((c): c is NarrationCue => !!c.narration),
    op.tracks,
  )
}
