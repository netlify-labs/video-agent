// One local run's inputs, prompt and results (cli-and-sdk plan §7; bead va-p1th.5.6). Inputs go where prepare-run
// --inputs reads them (<ws>/.va-inputs/<store>/<key>) with a v1 run manifest made by the server's own serializer, and
// the prompt is buildPrompt's, unchanged, with file: callback and checkpoint URLs and --upload local. Results come back
// as files: <ws>/.render/<attempt>/checkpoint/<seq>.json while the agent works, then done.json.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, normalize } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  buildPrompt,
  buildQuickDemoPrompt,
  MAX_PROMPT_CLICKS,
  type PromptInput,
  type RecordingPrompt,
} from '../../../../app/server/domain/prompt.js'
import { parseTrace } from '../../../../app/server/lib/recording-trace.js'
import { classify } from '../../../../app/server/lib/media/classify.js'
import {
  RUN_MANIFEST_VERSION,
  runManifestKey,
  serializeRunManifest,
  sha256Hex,
  type RunManifest,
} from '../../../../app/server/lib/run-manifest.js'
import type { LocalLook } from './look.js'
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
  /** local --look: the look's archive, restored by prepare-run into context/look/ as on the runner. */
  look?: LocalLook
  /**
   * local demo (screen-recording plan §6.3; va-rsk5.5.4): a screen recording (and its pointer trace) the run makes a
   * demo from, as the server's demo runs do; quick composes it with no authoring (the Quick demo's prompt).
   */
  recording?: {
    path: string
    trace?: string | null
    trim?: [number, number]
    privacy?: boolean
    hideStrings?: string[]
    quick?: boolean
  }
  /**
   * A revision (local revise, bead va-p1th.5.12): the video's job id and the version it changes, whose source.tar.gz
   * is restored by prepare-run exactly as on the runner. The prompt is then the change.
   */
  revision?: {
    jobId: string
    parentN: number
    versionN?: number
    source: string
    /** Only these scenes (local revise --scene, bead va-8cy4.5.14): their ids, as the prompt lists them, and voice. */
    scope?: {
      ids: string[]
      beats: { id: string; label: string | null; start: number; duration: number }[]
      voiced: boolean
    }
  }
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
  // The recording: classified as an upload with the screen-recording role is, its trace beside it in the media store.
  let recording: RunManifest['recording']
  let recordingPrompt: RecordingPrompt | null = null
  if (input.recording) {
    const bytes = new Uint8Array(readFileSync(input.recording.path))
    const c = classify(bytes, { role: 'screen-recording' })
    const id = `med_loc${randomBytes(8).toString('hex')}`
    const key = `${id}/original.${c.ext}`
    mkdirSync(join(inputs, 'media', id), { recursive: true })
    writeFileSync(join(inputs, 'media', key), bytes)
    const run = { key, sha256: sha256Hex(bytes), filename: `${id}.${c.ext}`, kind: 'video' as const }
    let trace: { key: string; sha256: string } | undefined
    let clicks: RecordingPrompt['clicks'] = []
    if (input.recording.trace) {
      const text = readFileSync(input.recording.trace, 'utf8')
      const parsed = parseTrace(text)
      trace = { key: `${id}/trace.json`, sha256: sha256Hex(text) }
      writeFileSync(join(inputs, 'media', trace.key), text)
      clicks = parsed.events
        .flatMap((e) =>
          e.kind === 'click' && e.target ? [{ t: e.t, role: e.target.role, name: e.target.name }] : [],
        )
        .slice(0, MAX_PROMPT_CLICKS)
    }
    media.push({ run, prompt: { file: `assets/media/${run.filename}`, kind: 'video', caption: null } })
    recording = {
      mediaId: id,
      ...run,
      ...(trace ? { trace } : {}),
      boxes: [],
      ...(input.recording.trim ? { trim: input.recording.trim } : {}),
      ...(input.recording.quick ? { compose: true } : {}),
      ...(input.recording.privacy ? { privacy: true } : {}),
      ...(input.recording.hideStrings?.length ? { hideStrings: input.recording.hideStrings } : {}),
    }
    recordingPrompt = {
      mediaId: id,
      file: `assets/media/${run.filename}`,
      seconds: c.durationSec ?? null,
      trace: Boolean(trace),
      privacy: input.recording.privacy === true,
      hideStrings: input.recording.hideStrings?.length ?? 0,
      clicks,
      deadlineMin: 40,
    }
  }
  // The look goes where the server keeps a version's snapshot: <jobId>/looks/<hash>.tar.gz in the sources store.
  let look: RunManifest['look']
  if (input.look) {
    const key = `${jobId}/looks/${input.look.hash}.tar.gz`
    mkdirSync(join(inputs, 'sources', jobId, 'looks'), { recursive: true })
    writeFileSync(join(inputs, 'sources', key), input.look.bytes)
    look = { id: input.look.id, key, sha256: input.look.sha256, hash: input.look.hash }
  }
  // render-job and checkpoint ignore it for file: URLs; random so no run carries a guessable value. It rides in the
  // manifest like the server's (prepare-run moves it to .va-run/callback.json), never in the prompt.
  const callbackToken = randomBytes(16).toString('hex')
  const manifest: RunManifest = {
    v: RUN_MANIFEST_VERSION,
    jobId,
    attemptId,
    versionN,
    callback: { token: callbackToken },
    kind: input.revision ? 'revision' : 'author',
    source,
    bundle: null,
    media: media.length ? media.map((m) => m.run) : null,
    feedback: null,
    // No neighbour stills locally: the prompt's no-stills variant says so.
    ...(input.revision?.scope ? { scope: { beats: input.revision.scope.ids, stills: [] } } : {}),
    ...(look ? { look } : {}),
    ...(recording ? { recording } : {}),
  }
  const raw = serializeRunManifest(manifest)
  const manifestFile = join(inputs, 'sources', runManifestKey(jobId, attemptId))
  mkdirSync(join(manifestFile, '..'), { recursive: true })
  writeFileSync(manifestFile, raw)
  const renderDir = join(ws, '.render', attemptId)
  const callbackUrl = pathToFileURL(join(renderDir, 'done')).href
  const checkpointUrl = pathToFileURL(join(renderDir, 'checkpoint')).href
  const prompt =
    input.recording?.quick && recording
      ? buildQuickDemoPrompt({
          jobId,
          attemptId,
          versionN,
          mediaId: recording.mediaId,
          aspect: input.aspect,
          targetDurationSec: input.durationSec ?? null,
          title: input.prompt.slice(0, 80),
          runManifestSha256: sha256Hex(raw),
          callbackUrl,
          checkpointUrl,
          upload: { mode: 'local' },
        })
      : buildPrompt({
          jobId,
          attemptId,
          versionN,
          requesterName: input.requesterName ?? 'you',
          userPrompt: input.prompt,
          aspect: input.aspect,
          targetDurationSec: input.durationSec ?? null,
          callbackUrl,
          checkpointUrl,
          upload: { mode: 'local' },
          ...(recordingPrompt ? { recording: recordingPrompt } : {}),
          revision: input.revision ? { parentN: input.revision.parentN } : null,
          runManifestSha256: sha256Hex(raw),
          media: media.map((m) => m.prompt),
          ...(input.sound ? { sound: input.sound } : {}),
          ...(input.voiceover ? { voiceover: input.voiceover } : {}),
          ...(input.look ? { look: { id: input.look.id, name: input.look.name } } : {}),
          ...(input.revision?.scope
            ? {
                scope: {
                  n: input.revision.parentN,
                  beats: input.revision.scope.beats,
                  stills: false,
                  voiced: input.revision.scope.voiced,
                  locked: false,
                },
              }
            : {}),
        })
  writeFileSync(join(ws, 'prompt.txt'), prompt)
  log('local.prepared', { jobId, attemptId, media: media.length, look: look?.id ?? null, ms: Date.now() - t })
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
