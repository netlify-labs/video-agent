// Transcription of recorded narration for captions (plan 2026-11-02 §6.6, bead va-2qq.3.12). Deterministic code the
// run invokes, never the model: right after scripts/narration.ts wrote the bus, from the repo root:
//   npx tsx scripts/narration-stt.ts [--deadline-ms 180000]
// Decodes video/assets/narration/bus.wav to 16 kHz, transcribes it with the provider the render froze (local Parakeet
// by default, ElevenLabs Scribe when an admin opted in and the key is set, or nothing when off) under one outer
// deadline that kills the whole process tree, and writes .va-run/narration/stt.json plus `stt` in the receipt
// (scripts/lib/stt/index.ts). Then it writes the narration caption cues into video/summary.json with only what's
// audible captioned (scripts/lib/narration-captions.ts applyNarrationCaptions). A failed or timed-out transcription
// is not an error: it exits 0 and the render goes on without narration captions. Logs JSON lines on stderr.
import { join } from 'node:path'
import { applyNarrationCaptions } from './lib/narration-captions.js'
import { readNarrationInputs } from './lib/narration-inputs.js'
import { parseArgs, repoRoot, log } from './lib/run-tools.js'
import { runStt, STT_DEADLINE_MS } from './lib/stt/index.js'

export { runStt } from './lib/stt/index.js'
export { applyNarrationCaptions, captionsForRender } from './lib/narration-captions.js'

if (process.argv[1]?.endsWith('scripts/narration-stt.ts')) {
  const args = parseArgs(process.argv.slice(2))
  const deadlineMs = Number(args['deadline-ms'] ?? STT_DEADLINE_MS)
  runStt({ root: repoRoot, deadlineMs: deadlineMs > 0 ? deadlineMs : STT_DEADLINE_MS })
    .then((r) => {
      const inputs = readNarrationInputs(repoRoot)
      if (inputs) {
        const { cues } = applyNarrationCaptions(join(repoRoot, 'video', 'summary.json'), r, inputs.op)
        console.log(`Narration captions: ${cues.length} cues.`)
      }
      console.log(
        r.status === 'ok'
          ? `Narration transcribed: ${r.words.length} words (${r.provider}, ${r.model}${r.cached ? ', cached' : ''}). Continue.`
          : `Narration not transcribed (${r.status}${r.error ? `: ${r.error}` : ''}). Continue: the video renders without narration captions.`,
      )
    })
    .catch((e: unknown) => {
      // Only a bug gets here (runStt records transcription problems as a status); still don't block the render.
      log('stt.crashed', { error: e instanceof Error ? e.message : String(e) })
      console.log(
        'Narration transcription or captions crashed. Continue: the video renders without narration captions.',
      )
    })
}
