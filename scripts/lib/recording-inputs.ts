// The run-side inputs of the recording check (app/server/lib/recording-check.ts): the composition's files, the run's
// recording from .render/run-manifest.json (prepare-run writes it), the source length from the kept analysis, and the
// locked hidden areas from .va-run/recording/<id>/ (the trace's redact entries, the person's setup boxes). Without a
// manifest (a local composition) the recording is taken from the slot and its inputs from .va-run when they're there.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { recordingCheck, type RecordingProblem } from '../../app/server/lib/recording-check.js'
import { isRecordingCrop, type RecordingCrop } from '../../app/server/lib/recording-crop.js'
import { parseTrace, type RedactEntry } from '../../app/server/lib/recording-trace.js'
import { log } from './run-tools.js'

const readIf = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : null)

/** Whether video/index.html has a recording scene (only then does the check run). */
export const hasRecording = (html: string) => /class="[^"]*\bva-recording\b/.test(html)

export function checkRecordingScenes(root: string, html: string): RecordingProblem[] {
  const started = Date.now()
  const video = join(root, 'video')
  const manifestText = readIf(join(root, '.render', 'run-manifest.json'))
  const manifest = manifestText
    ? (JSON.parse(manifestText) as { kind?: string; recording?: { mediaId: string; filename: string } })
    : null
  const slotFile = /data-va-in="[^"]*"/.test(html)
    ? /src="assets\/media\/(med_[a-z0-9]+)\.[a-z0-9]+"[^>]*data-va-in=/.exec(html)?.[1]
    : undefined
  const mediaId = manifest?.recording?.mediaId ?? slotFile ?? null
  let durationSec: number | undefined
  try {
    const a = readIf(join(video, 'assets', 'recording', 'analysis.json'))
    durationSec = a ? (JSON.parse(a) as { source?: { duration?: number } }).source?.duration : undefined
  } catch {
    durationSec = undefined
  }
  let locked: { trace: RedactEntry[]; setup: RedactEntry[] } | null = null
  // The person's crop: known (null for none) when the run's inputs are; trace.json and the boxes are already in it.
  let crop: RecordingCrop | null | undefined
  if (mediaId) {
    const dir = join(root, '.va-run', 'recording', mediaId)
    const trace = readIf(join(dir, 'trace.json'))
    const inputText = readIf(join(dir, 'input.json'))
    const input = inputText ? (JSON.parse(inputText) as { boxes?: RedactEntry[]; crop?: unknown }) : null
    if (trace !== null || input !== null || manifest?.recording)
      locked = { trace: trace ? parseTrace(trace).redact : [], setup: input?.boxes ?? [] }
    if (input) crop = isRecordingCrop(input.crop) ? input.crop : null
  }
  const problems = recordingCheck({
    html,
    readFile: (p) => readIf(join(video, p)),
    recording: manifest?.recording ? { filename: manifest.recording.filename, durationSec } : null,
    locked,
    crop,
    // A render-unchanged run plays the person's editor spans, and makes missing hold stills itself (emit --holds-only).
    edited: manifest?.kind === 'render_unchanged',
    pendingStills:
      manifest?.kind === 'render_unchanged'
        ? [...html.matchAll(/assets\/recording\/[a-z0-9-]+\.hold\.jpg/g)].map((m) => m[0])
        : [],
  })
  const scenes = [...new Set(problems.map((p) => p.scene))]
  for (const p of problems) log('recording.check', { scene: p.scene, rule: p.rule, ok: false })
  log('recording.check_done', {
    problems: problems.length,
    scenes,
    locked: Boolean(locked),
    ms: Date.now() - started,
  })
  return problems
}
