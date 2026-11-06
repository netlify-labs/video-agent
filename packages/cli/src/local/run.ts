// One local run's inputs, prompt and results (cli-and-sdk plan §7; bead va-p1th.5.6). Inputs go where prepare-run
// --inputs reads them (<ws>/.va-inputs/<store>/<key>) with a v1 run manifest made by the server's own serializer, and
// the prompt is buildPrompt's, unchanged, with file: callback and checkpoint URLs and --upload local. Results come back
// as files: <ws>/.render/<attempt>/checkpoint/<seq>.json while the agent works, then done.json.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, normalize } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildPrompt, type PromptInput } from '../../../../src/domain/prompt.js'
import { classify } from '../../../../src/lib/media/classify.js'
import {
  RUN_MANIFEST_VERSION,
  runManifestKey,
  serializeRunManifest,
  sha256Hex,
  type RunManifest,
} from '../../../../src/lib/run-manifest.js'
import type { Log } from './workspace.js'

export const INPUTS_DIR = '.va-inputs'
const newId = (prefix: string) => `${prefix}_${randomBytes(10).toString('hex')}`

export interface LocalRunInput {
  prompt: string
  aspect: PromptInput['aspect']
  durationSec?: number | null
  sound?: PromptInput['sound']
  voiceover?: PromptInput['voiceover']
  requesterName?: string
  /** Files to put in the video, with an optional caption each. */
  media?: { path: string; caption: string | null }[]
  /**
   * A revision (local revise, bead va-p1th.5.12): the video's job id and the version it changes, whose source.tar.gz
   * is restored by prepare-run exactly as on the runner. The prompt is then the change.
   */
  revision?: { jobId: string; parentN: number; versionN?: number; source: string }
}

export interface LocalRun {
  jobId: string
  attemptId: string
  versionN: number
  /** <ws>/.render/<attempt>/: checkpoint/ and done.json land here. */
  renderDir: string
  manifestSha256: string
  prompt: string
}

/**
 * Writes the run's inputs and manifest into the workspace and returns the prompt for the agent (also saved as
 * <ws>/prompt.txt). Media are classified from their bytes, as the server does for uploads.
 */
export function prepareLocalRun(ws: string, input: LocalRunInput, log: Log): LocalRun {
  const t = Date.now()
  const jobId = input.revision?.jobId ?? newId('loc')
  const attemptId = newId('loc')
  const versionN = input.revision ? (input.revision.versionN ?? input.revision.parentN + 1) : 1
  const inputs = join(ws, INPUTS_DIR)
  let source: RunManifest['source'] = null
  if (input.revision) {
    const bytes = new Uint8Array(readFileSync(input.revision.source))
    const key = `${jobId}/v${input.revision.parentN}/source.tar.gz`
    mkdirSync(join(inputs, 'sources', jobId, `v${input.revision.parentN}`), { recursive: true })
    writeFileSync(join(inputs, 'sources', key), bytes)
    source = { key, sha256: sha256Hex(bytes), parentN: input.revision.parentN }
  }
  const media = (input.media ?? []).map((m) => {
    const bytes = new Uint8Array(readFileSync(m.path))
    const c = classify(bytes)
    const id = `med_loc${randomBytes(8).toString('hex')}`
    const key = `${id}/original.${c.ext}`
    mkdirSync(join(inputs, 'media', id), { recursive: true })
    writeFileSync(join(inputs, 'media', key), bytes)
    return {
      run: { key, sha256: sha256Hex(bytes), filename: `${id}.${c.ext}`, kind: c.kind },
      prompt: {
        // PDFs are read, not shown: prepare-run puts them in context/media/ (as the reconciler says).
        file: c.kind === 'pdf' ? `context/media/${id}.${c.ext}` : `assets/media/${id}.${c.ext}`,
        kind: c.kind,
        caption: m.caption,
        ...(c.kind === 'audio' ? { seconds: c.durationSec } : {}),
      },
    }
  })
  const manifest: RunManifest = {
    v: RUN_MANIFEST_VERSION,
    jobId,
    attemptId,
    versionN,
    kind: input.revision ? 'revision' : 'author',
    source,
    bundle: null,
    media: media.length ? media.map((m) => m.run) : null,
    feedback: null,
  }
  const raw = serializeRunManifest(manifest)
  const manifestFile = join(inputs, 'sources', runManifestKey(jobId, attemptId))
  mkdirSync(join(manifestFile, '..'), { recursive: true })
  writeFileSync(manifestFile, raw)
  const renderDir = join(ws, '.render', attemptId)
  const prompt = buildPrompt({
    jobId,
    attemptId,
    versionN,
    requesterName: input.requesterName ?? 'you',
    userPrompt: input.prompt,
    aspect: input.aspect,
    targetDurationSec: input.durationSec ?? null,
    callbackUrl: pathToFileURL(join(renderDir, 'done')).href,
    checkpointUrl: pathToFileURL(join(renderDir, 'checkpoint')).href,
    // render-job and checkpoint ignore it for file: URLs; random so a prompt never carries a guessable value.
    callbackToken: randomBytes(16).toString('hex'),
    upload: { mode: 'local' },
    revision: input.revision ? { parentN: input.revision.parentN } : null,
    runManifestSha256: sha256Hex(raw),
    media: media.map((m) => m.prompt),
    ...(input.sound ? { sound: input.sound } : {}),
    ...(input.voiceover ? { voiceover: input.voiceover } : {}),
  })
  writeFileSync(join(ws, 'prompt.txt'), prompt)
  log('local.prepared', { jobId, attemptId, media: media.length, ms: Date.now() - t })
  return { jobId, attemptId, versionN, renderDir, manifestSha256: sha256Hex(raw), prompt }
}

export interface Checkpoint {
  seq: number
  message?: string
  renderPercent?: number
  bundle?: string
}

/** A file the done manifest names, resolved only inside the render folder: never /, .. or an absolute path. */
export function outputPath(renderDir: string, name: string): string {
  const n = normalize(name)
  if (!name || isAbsolute(name) || n.startsWith('..') || n !== basename(n))
    throw new Error(`The run named an output outside its folder: ${JSON.stringify(name)}`)
  return join(renderDir, n)
}

/**
 * Follows a run: calls onCheckpoint for each new checkpoint in order, and resolves with done.json's manifest. Uses
 * fs.watch with a poll every `pollMs` (also the fallback when watching isn't available). Rejects on `signal`.
 */
export function watchRun(o: {
  renderDir: string
  onCheckpoint: (c: Checkpoint) => void
  log: Log
  pollMs?: number
  watchFiles?: boolean
  signal?: AbortSignal
}): Promise<Record<string, unknown>> {
  const cpDir = join(o.renderDir, 'checkpoint')
  const done = join(o.renderDir, 'done.json')
  let next = 1
  return new Promise((resolve, reject) => {
    let watcher: ReturnType<typeof watch> | null = null
    let finished = false
    const stop = () => {
      finished = true
      clearInterval(timer)
      watcher?.close()
    }
    const scan = () => {
      // A watch event can still arrive after the run is done.
      if (finished) return
      try {
        // Checkpoints in sequence order; a number that never appears is skipped.
        if (existsSync(cpDir)) {
          const seqs = readdirSync(cpDir)
            .map((f) => /^(\d+)\.json$/.exec(f)?.[1])
            .filter((x): x is string => x !== undefined)
            .map(Number)
            .filter((n) => n >= next)
            .sort((a, b) => a - b)
          for (const seq of seqs) {
            const c = JSON.parse(readFileSync(join(cpDir, `${seq}.json`), 'utf8')) as Checkpoint
            next = seq + 1
            o.onCheckpoint(c)
          }
        }
        if (existsSync(done) && statSync(done).size > 0) {
          const manifest = JSON.parse(readFileSync(done, 'utf8')) as Record<string, unknown>
          for (const name of Object.keys(manifest.files ?? {})) outputPath(o.renderDir, name)
          stop()
          o.log('local.done', { renderDir: o.renderDir })
          resolve(manifest)
        }
      } catch (e) {
        stop()
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    }
    const timer = setInterval(scan, o.pollMs ?? 1000)
    mkdirSync(o.renderDir, { recursive: true })
    if (o.watchFiles !== false)
      try {
        watcher = watch(o.renderDir, { recursive: true }, scan)
      } catch {
        o.log('local.watch_unavailable', { renderDir: o.renderDir })
      }
    o.signal?.addEventListener(
      'abort',
      () => {
        stop()
        reject(new Error('Stopped.'))
      },
      { once: true },
    )
    scan()
  })
}
