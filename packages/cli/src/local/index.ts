// `video-agent local`: make a video on this machine with the person's own coding agent, inside its sandbox.
// One run: the pinned runtime and a fresh workspace, the agent with the
// run's prompt, the render on the host through the render broker, then the outputs checked against done.json and
// copied to ./videos/<slug>/vN/ with a video.json. The workspace is deleted unless --keep.
import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runAgent, type Adapter } from './agent.js'
import { geminiHome } from './gemini.js'
import { serveRenders } from './render-host.js'
import { outputPath, prepareLocalRun, watchRun, type LocalRunInput } from './run.js'
import { scopeRefusal } from './scope.js'
import {
  buildWorkspace,
  ensureRuntime,
  ensureVoiceVenv,
  installAgentKit,
  type Log,
  type Runner,
} from './workspace.js'

/** The files a finished version keeps in ./videos/<slug>/vN/ (the rest stay in the workspace). */
export const KEPT = ['video.mp4', 'poster.jpg', 'captions.vtt', 'preview.gif', 'source.tar.gz'] as const

export interface VideoJson {
  title: string
  summary: string
  jobId: string
  versions: {
    n: number
    prompt: string
    agent: string
    createdAt: string
    durationSec: number | null
    width: number | null
    height: number | null
    files: string[]
    /** What the version was made with, so a revision keeps it. Missing in older videos: silent. */
    sound?: NonNullable<LocalRunInput['sound']>
    voice?: boolean
  }[]
}

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 6)
    .join('-') || 'video'

const sha256File = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')

export interface LocalOptions {
  input: LocalRunInput
  adapter: Adapter
  /** dist/runtime of this CLI (bundledRuntime()) or a test's build. */
  runtimeSource: string
  cache: string
  version: string
  env: NodeJS.ProcessEnv
  log: Log
  /** One human line per milestone (stderr). */
  progress: (line: string) => void
  /** ./videos/<slug> for a new video; the video's folder for a revision. */
  videoDir: (title: string) => string
  context?: string | undefined
  keep?: boolean
  timeoutMs?: number
  signal?: AbortSignal
  run?: Runner
}

export interface LocalResult {
  dir: string
  versionN: number
  manifest: Record<string, unknown>
  workspace: string | null
}

export async function runLocal(o: LocalOptions): Promise<LocalResult> {
  const runtime = ensureRuntime({
    source: o.runtimeSource,
    cache: o.cache,
    version: o.version,
    env: o.env,
    log: o.log,
    ...(o.run ? { run: o.run } : {}),
  })
  const voice = o.input.voiceover ? ensureVoiceVenv({ cache: o.cache, env: o.env, log: o.log }) : null
  if (voice && voice.python === null) throw new Error(`Voice-over needs Python: ${voice.reason}`)
  const runId = `loc_${randomBytes(6).toString('hex')}`
  const ws = buildWorkspace({ runtime, cache: o.cache, runId, env: o.env, log: o.log, context: o.context })
  if (voice?.python) ws.env.VA_PYTHON = voice.python
  // A failed run keeps its workspace: the error points at the agent's log in it.
  let ok = false
  try {
    o.progress('Setting up the tools (first run: a few minutes)…')
    installAgentKit({ ws, runtime, log: o.log, ...(o.run ? { run: o.run } : {}) })
    const run = prepareLocalRun(ws.dir, o.input, o.log)
    o.progress(`Running ${o.adapter.id} in its sandbox (workspace ${ws.dir})…`)
    const ac = new AbortController()
    o.signal?.addEventListener('abort', () => ac.abort(), { once: true })
    const watching = watchRun({
      renderDir: run.renderDir,
      log: o.log,
      signal: ac.signal,
      onCheckpoint: (c) => {
        if (c.message) o.progress(c.message)
        if (typeof c.renderPercent === 'number') o.progress(`Rendering ${c.renderPercent}%`)
      },
    }).catch((e: unknown) => e as Error)
    const rendering = serveRenders({
      renderDir: run.renderDir,
      ws: ws.dir,
      env: ws.env,
      log: o.log,
      signal: ac.signal,
    })
    const agent = await runAgent({
      adapter: o.adapter,
      ws: ws.dir,
      prompt: run.prompt,
      env: ws.env,
      log: o.log,
      ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
    })
    // The agent is done: one last look for done.json, then stop watching and serving.
    await new Promise((r) => setTimeout(r, 1500))
    ac.abort()
    const done = await watching
    await rendering
    if (done instanceof Error)
      throw new Error(
        agent.timedOut
          ? 'The agent ran out of time before the video was rendered.'
          : `The agent finished without rendering the video (exit ${agent.code}). Its log: ${agent.logFile}`,
      )
    const result = { ...copyOut(o, run, done), workspace: o.keep ? ws.dir : null }
    ok = true
    return result
  } finally {
    rmSync(geminiHome(ws.dir), { recursive: true, force: true })
    // Best effort: a straggling process can still be writing, and that mustn't hide the run's own result.
    if (ok && !o.keep) {
      try {
        rmSync(ws.dir, { recursive: true, force: true, maxRetries: 3 })
      } catch (e) {
        o.log('local.workspace_left', { dir: ws.dir, error: e instanceof Error ? e.message : String(e) })
      }
    }
  }
}

/** Checks each output against done.json's hashes and copies the kept ones to <video dir>/v<n>/ (bead 5.11). */
function copyOut(
  o: LocalOptions,
  run: ReturnType<typeof prepareLocalRun>,
  manifest: Record<string, unknown>,
): Omit<LocalResult, 'workspace'> {
  const files = (manifest.files ?? {}) as Record<string, { sha256: string; bytes: number }>
  for (const [name, f] of Object.entries(files)) {
    const p = outputPath(run.renderDir, name)
    if (!existsSync(p) || sha256File(p) !== f.sha256)
      throw new Error(`The run's ${name} doesn't match what render-job recorded. Not copying it out.`)
  }
  if (!files['video.mp4']) throw new Error('The run made no video.mp4.')
  // A scoped revision passes finalize's check before anything is copied out.
  const scope = o.input.revision?.scope
  if (scope && o.input.revision) {
    const refusal = scopeRefusal({
      parentSource: o.input.revision.source,
      childSource: outputPath(run.renderDir, 'source.tar.gz'),
      beats: scope.ids,
      mp4Seconds: typeof manifest.durationSec === 'number' ? manifest.durationSec : null,
    })
    o.log('local.scope_checked', { beats: scope.ids, refused: refusal !== null })
    if (refusal) throw new Error(refusal)
  }
  const title = typeof manifest.title === 'string' && manifest.title ? manifest.title : o.input.prompt
  const root = o.videoDir(title)
  const dir = join(root, `v${run.versionN}`)
  if (existsSync(dir)) throw new Error(`${dir} already exists.`)
  mkdirSync(dir, { recursive: true })
  const kept: string[] = []
  for (const name of KEPT)
    if (files[name] || name === 'source.tar.gz') {
      const from = outputPath(run.renderDir, name)
      if (existsSync(from)) {
        copyFileSync(from, join(dir, name))
        kept.push(name)
      }
    }
  const jsonPath = join(root, 'video.json')
  const prior: VideoJson = existsSync(jsonPath)
    ? (JSON.parse(readFileSync(jsonPath, 'utf8')) as VideoJson)
    : { title, summary: '', jobId: run.jobId, versions: [] }
  const num = (k: string) => {
    const v = manifest[k]
    return typeof v === 'number' ? v : null
  }
  const video: VideoJson = {
    ...prior,
    title,
    summary: typeof manifest.summary === 'string' ? manifest.summary : prior.summary,
    versions: [
      ...prior.versions,
      {
        n: run.versionN,
        prompt: o.input.prompt,
        agent: o.adapter.id,
        createdAt: new Date().toISOString(),
        durationSec: num('durationSec'),
        width: num('width'),
        height: num('height'),
        files: kept,
        sound: o.input.sound ?? 'silent',
        voice: Boolean(o.input.voiceover),
      },
    ],
  }
  writeFileSync(jsonPath, `${JSON.stringify(video, null, 2)}\n`)
  o.log('local.copied', { dir, files: kept })
  return { dir, versionN: run.versionN, manifest }
}
