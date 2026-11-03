// Narration captions in the run (plan 2026-11-02 §6.6, bead va-2qq.3.13), after the STT stage: the transcript's words
// become narration cues in video/summary.json, and only what's audible stays captioned (src/lib/narration-captions.ts).
// On a failed, timed-out or skipped transcription there are no narration cues; with replace that can leave no cues at
// all, and render-job still writes a valid empty captions.vtt ("WEBVTT\n\n"). The words stay in
// .va-run/narration/stt.json for the outputs (transcript.txt).
import { readFileSync, writeFileSync } from 'node:fs'
import type { Caption, Summary } from '../../src/lib/contract.js'
import { audibleCaptions, groupWords, type NarrationCue } from '../../src/lib/narration-captions.js'
import type { NarrationTracks } from '../../src/lib/timeline.js'
import { readNarrationInputs } from './narration-inputs.js'
import { log } from './run-tools.js'
import type { SttRecord } from './stt/index.js'

/** Writes the narration cues and the audible rule into summary.json. Idempotent: earlier narration cues are replaced. */
export function applyNarrationCaptions(
  summaryPath: string,
  stt: Pick<SttRecord, 'status' | 'words'> | null,
  op: { tracks: Pick<NarrationTracks, 'narration' | 'aiVoice' | 'original'> },
): { cues: NarrationCue[]; captions: Caption[] } {
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as Summary
  const cues = stt?.status === 'ok' ? groupWords(stt.words) : []
  const before = summary.captions ?? []
  const captions = audibleCaptions(before, cues, op.tracks)
  writeFileSync(summaryPath, JSON.stringify({ ...summary, captions }, null, 2))
  log('captions.narration', {
    stt: stt?.status ?? 'missing',
    cues: cues.length,
    captions: captions.length,
    dropped: before.filter((c) => !c.narration).length - captions.filter((c) => !c.narration).length,
    aiVoice: op.tracks.aiVoice.mode,
    muted: op.tracks.narration.muted,
  })
  return { cues, captions }
}

/**
 * The cues render-job turns into captions.vtt. Without recorded narration: the summary's, as they are. With it: the
 * audible rule over them again, so a run where the caption step never ran still doesn't caption a replaced AI voice.
 */
export function captionsForRender(root: string, captions: unknown): unknown {
  const inputs = readNarrationInputs(root)
  if (!inputs || !Array.isArray(captions)) return captions
  const list = (captions as unknown[]).filter((c): c is Caption => !!c && typeof c === 'object')
  return audibleCaptions(
    list,
    list.filter((c): c is NarrationCue => !!c.narration),
    inputs.op.tracks,
  )
}
