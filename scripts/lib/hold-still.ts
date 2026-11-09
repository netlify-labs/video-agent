// The held frame's still (plan 2026-11-02 §2.5, §6.3; docs/spikes.md S12). A keep-visuals render whose narration runs
// past the end freezes with a last data-va-hold beat (contract applyHoldFrame) that shows assets/hold/last.png: the
// base composition's last pre-encode frame. scripts/narration.ts makes it in the run: the composition without the
// hold beat goes in a scratch project next to video/ (every other entry symlinked, so media isn't copied), and
// `hyperframes snapshot --at <last frame>` captures that one frame as a PNG. The snapshot uses the render's capture,
// so the still is byte-identical to the frame a full png-sequence render of the base ends on (checked on the
// template), without rendering the base again. The receipt records its sha256 for checkNarration.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { applyHoldFrame, FPS, HOLD_STILL_SRC, holdBeatOf, load, save } from '../../app/server/lib/contract.js'
import { StepError, run, sha256File } from './run-tools.js'

/** Captures the frame at `atSeconds` of the project in `dir` as a PNG under `outDir`, and returns its path. */
export type Snapshot = (dir: string, atSeconds: number, outDir: string) => string

export const hyperframesSnapshot: Snapshot = (dir, atSeconds, outDir) => {
  run(
    'npx',
    ['-y', 'hyperframes', 'snapshot', '--at', atSeconds.toFixed(6), '--no-end', '--output', outDir, dir],
    {
      cwd: dir,
      timeoutMs: 5 * 60_000,
    },
  )
  const png = existsSync(outDir) ? readdirSync(outDir).find((f) => /^frame-.*\.png$/.test(f)) : undefined
  if (!png) throw new StepError('hyperframes snapshot wrote no frame for the held last frame.')
  return join(outDir, png)
}

export interface HoldStill {
  path: typeof HOLD_STILL_SRC
  sha256: string
  /** The base's last frame (seconds), which the still shows, and how long the hold beat shows it. */
  atSeconds: number
  holdSeconds: number
}

/**
 * Writes video/assets/hold/last.png for a composition with a held frame, from `html` (the composition before the
 * narration step); without one, removes any stale still (the narration step owns that path) and returns null.
 */
export function writeHoldStill(
  root: string,
  html: string,
  snapshot: Snapshot = hyperframesSnapshot,
): HoldStill | null {
  const videoDir = join(root, 'video')
  const still = join(videoDir, HOLD_STILL_SRC)
  const d = load(html)
  const hold = holdBeatOf(d)
  if (!hold) {
    rmSync(still, { force: true })
    return null
  }
  applyHoldFrame(d, 0)
  const frames = Math.round(hold.start * FPS)
  if (!(frames > 0)) throw new StepError('The held frame has no base composition before it.')
  const atSeconds = Math.round(((frames - 1) / FPS) * 1e6) / 1e6
  const scratch = join(root, '.render', 'hold-base')
  rmSync(scratch, { recursive: true, force: true })
  const project = join(scratch, 'project')
  mkdirSync(project, { recursive: true })
  for (const name of readdirSync(videoDir))
    if (name !== 'index.html' && !name.startsWith('.')) symlinkSync(join(videoDir, name), join(project, name))
  writeFileSync(join(project, 'index.html'), save(d))
  try {
    const png = snapshot(project, atSeconds, join(scratch, 'snap'))
    mkdirSync(dirname(still), { recursive: true })
    rmSync(still, { force: true })
    copyFileSync(png, still)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  return { path: HOLD_STILL_SRC, sha256: sha256File(still), atSeconds, holdSeconds: hold.duration }
}
