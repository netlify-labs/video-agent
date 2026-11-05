// Spike K2 (docs/plans/2026-11-04-looks.md §10): does a LOOK.md change the output, and what does it cost?
//   npx tsx spikes/k2/prompts.ts [--dry]
// Writes the six run prompts to spikes/out/k2/prompts/ and prints the dry listing (runs, branches, projected credits).
// Each prompt is the production buildPrompt for the same input, plus the §4.6 look lines when the run has a look, with
// render-job (which reports to the server) swapped for a local render the run's preview deploy serves: the build embeds
// .render/<attempt>/video.mp4 when .render/run-manifest.json names the run (scripts/lib/agent-preview.ts).
// Looks reach runs on their own spike branch, committed at context/look/ (spikes/k2/looks/<id>/ copied there):
//   spike/k2-none (no context/look/), spike/k2-clean, spike/k2-kinetic. Nothing here starts a run.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildPrompt } from '../../src/domain/prompt.js'

const root = new URL('../..', import.meta.url).pathname
const outDir = join(root, 'spikes', 'out', 'k2', 'prompts')

export const LOOKS = { clean: 'Clean product', kinetic: 'Kinetic type' } as const
export const PROMPTS = {
  launch: {
    aspect: '16:9' as const,
    seconds: 20,
    text: "A 20-second launch video for Lumen, a shared notebook for small teams: notes, tasks and docs in one place. The news: instant search across everything you've written. End with \"Try Lumen free\".",
  },
  social: {
    aspect: '9:16' as const,
    seconds: 15,
    text: "A 15-second vertical social clip for Lumen announcing offline mode: write anywhere, and it syncs the moment you're back online.",
  },
}
const CREDITS_PER_RUN = 150
const CEILING = 900

/** The look lines of plan §4.6 step 4, as phase 2 will add them to the template. */
export function lookLines(id: keyof typeof LOOKS): string[] {
  return [
    'The look for this video is in context/look/ (prepare-run puts it there). Read context/look/LOOK.md before you design anything. context/look/example/ shows how its rules become a composition: skim the scene that matches the one you\'re writing, and reuse its structure and building blocks, never its words or media. The look governs layout, type scale, pacing, motion, transitions, textures and how colour roles are used. The brand in context/ still decides colours, logo, fonts and wording; where they disagree, the brand wins, and the request wins over both. Write any colour role you derive as a literal colour. Copy any look asset you use (textures, effects) into video/assets/look/, and add a credits line for any that needs one. Its name, as JSON:',
    '<<<',
    JSON.stringify({ id, name: LOOKS[id] }),
    '>>>',
    '',
  ]
}

export function k2Prompt(look: keyof typeof LOOKS | null, which: keyof typeof PROMPTS): string {
  const p = PROMPTS[which]
  const jobId = `k2-${look ?? 'none'}-${which}`
  const base = buildPrompt({
    jobId,
    attemptId: 'k2',
    versionN: 1,
    requesterName: 'Spike K2',
    userPrompt: p.text,
    aspect: p.aspect,
    targetDurationSec: p.seconds,
    callbackUrl: 'https://unused.invalid/done',
    checkpointUrl: 'https://unused.invalid/cp',
    callbackToken: 'unused',
    upload: { mode: 'blobs' },
    revision: null,
    runManifestSha256: null,
  })
  const lines = base.split('\n')
  // The look lines go right after "Read context/ first …" (where phase 2 puts them).
  const ctx = lines.findIndex((l) => l.startsWith('Read context/ first.'))
  if (look) lines.splice(ctx + 2, 0, ...lookLines(look))
  // Swap render-job, its json block and the checkpoint paragraph for the spike's local render.
  const step5 = lines.findIndex((l) => l.startsWith('5. Run: npx tsx scripts/render-job.ts'))
  const progress = lines.findIndex((l) => l.startsWith('Progress (optional'))
  if (step5 < 0 || progress < 0) throw new Error('buildPrompt changed shape: update spikes/k2/prompts.ts')
  lines.splice(
    step5,
    progress - step5 + 2,
    `5. This is a measurement run for spike K2. Instead of render-job, from video/ run: mkdir -p ../.render/k2 && npx hyperframes render --quality standard --output ../.render/k2/video.mp4`,
    `   Then, from the repository root: printf '{"jobId":"${jobId}","attemptId":"k2","versionN":1}' > .render/run-manifest.json`,
    '6. End your answer with a fenced ```json block: { "look": ' +
      JSON.stringify(look) +
      ', "contract": "ok" or the violations, "checkErrors": <number>, "scenes": <number>, "seconds": <number> }.',
    '',
  )
  return lines.join('\n')
}

if (process.argv[1]?.endsWith('prompts.ts')) {
  mkdirSync(outDir, { recursive: true })
  const runs: { look: string; prompt: string; branch: string; file: string }[] = []
  for (const look of [null, 'clean', 'kinetic'] as const)
    for (const which of Object.keys(PROMPTS) as (keyof typeof PROMPTS)[]) {
      const file = join(outDir, `${look ?? 'none'}-${which}.md`)
      writeFileSync(file, k2Prompt(look, which))
      runs.push({ look: look ?? 'none', prompt: which, branch: `spike/k2-${look ?? 'none'}`, file })
    }
  console.log('K2 dry listing (nothing started):')
  for (const r of runs)
    console.log(
      JSON.stringify({ step: 'dry', look: r.look, prompt: r.prompt, branch: r.branch, file: r.file.replace(root, '') }),
    )
  console.log(
    JSON.stringify({ step: 'dry-total', runs: runs.length, projectedCredits: runs.length * CREDITS_PER_RUN, ceiling: CEILING }),
  )
  console.log(
    'Each run: npx tsx spikes/start-run.ts --prompt-file <file> --branch <branch> --deadline-min 30 (after the owner says go).',
  )
}
