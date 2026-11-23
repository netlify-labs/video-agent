// `video-agent local` and `local revise`: a video made on this machine
// by the person's own coding agent in its sandbox, saved to ./videos/<slug>/vN/. No server, no key, no credits.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Adapter } from '../local/agent.js'
import { claude } from '../local/claude.js'
import { fixture } from '../local/fixture.js'
import { quick } from '../local/quick.js'
import { runLocal, slugify, type VideoJson } from '../local/index.js'
import type { LocalRunInput } from '../local/run.js'
import { resolveLocalLook } from '../local/look.js'
import { bundledRuntime, cacheDir } from '../local/workspace.js'
import { CliError, EXIT, UsageError } from '../exit.js'
import type { Ctx, Handler } from '../router.js'
import { VERSION } from '../version.js'
import { localScope } from '../local/scope.js'
import { sceneFlags } from './scenes.js'
import { parseCrop, parseTrim, recordingFiles } from './recording.js'
import { arg, durationMs } from './shared.js'

/** Agents this version ships. Fixture is hidden, for CI. */
const SHIPPED: Record<string, Adapter> = { claude }
const NOT_YET: Record<string, string> = {
  codex: "Codex isn't supported in this version yet: its sandbox check hasn't passed.",
  gemini: "Gemini CLI isn't supported in this version yet: its sandbox check hasn't passed.",
}

const installed = (cmd: string) =>
  spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0

function pickAgent(ctx: Ctx): Adapter {
  const name = ctx.flags.agent as string | undefined
  if (name === 'fixture') return fixture
  if (name) {
    const a = SHIPPED[name]
    if (a) return a
    throw new CliError(
      'agent_unsupported',
      NOT_YET[name] ?? `Unknown agent "${name}". Use: claude.`,
      EXIT.unsupported,
    )
  }
  const found = Object.keys(SHIPPED).find(installed)
  if (!found)
    throw new CliError(
      'no_agent',
      'No supported coding agent found. Install Claude Code (https://claude.com/claude-code) and sign in, then run this again.',
      EXIT.unsupported,
    )
  return SHIPPED[found] as Adapter
}

/** --media path or path:"caption". */
function mediaOf(values: string[]): NonNullable<LocalRunInput['media']> {
  if (values.length > 12) throw new UsageError('At most 12 --media files.')
  return values.map((v) => {
    const m = /^(.*?):"?(.*?)"?$/.exec(v)
    const path = resolve(m && existsSync(m[1] ?? '') ? (m[1] ?? v) : v)
    if (!existsSync(path)) throw new UsageError(`--media ${v}: no such file.`)
    return { path, caption: m && existsSync(m[1] ?? '') ? m[2] || null : null }
  })
}

async function go(ctx: Ctx, input: LocalRunInput, videoDir: (title: string) => string) {
  const progress = (line: string) => ctx.io.stderr(`${line}\n`)
  const timeout = ctx.flags.timeout as string | undefined
  // A Quick demo needs no model: its commands are fixed.
  const adapter = input.recording?.quick ? quick : pickAgent(ctx)
  const ac = new AbortController()
  const onSigint = () => ac.abort()
  process.once('SIGINT', onSigint)
  try {
    const r = await runLocal({
      input,
      adapter,
      runtimeSource: ctx.io.env.VA_RUNTIME_SOURCE ?? bundledRuntime(),
      cache: cacheDir(ctx.io.env),
      version: VERSION,
      env: ctx.io.env,
      log: ctx.log,
      progress,
      videoDir,
      context:
        (ctx.flags.context as string | undefined) ??
        (existsSync(resolve('context')) ? resolve('context') : undefined),
      keep: Boolean(ctx.flags.keep),
      timeoutMs: timeout ? durationMs(timeout, 'timeout') : 40 * 60_000,
      signal: ac.signal,
    })
    const mp4 = join(r.dir, 'video.mp4')
    return {
      json: { dir: r.dir, version: r.versionN, video: mp4, workspace: r.workspace },
      text: [
        `Made ${mp4}`,
        r.workspace ? `Workspace kept at ${r.workspace}` : '',
        'To share it from a Video Agent deployment: video-agent login --url <your site>, then video-agent create.',
      ]
        .filter(Boolean)
        .join('\n'),
    }
  } catch (e) {
    if (ac.signal.aborted) throw new CliError('stopped', 'Stopped.', EXIT.error)
    throw new CliError('local_failed', e instanceof Error ? e.message : String(e), EXIT.videoFailed)
  } finally {
    process.removeListener('SIGINT', onSigint)
  }
}

const local: Handler = async (ctx) => {
  const prompt = arg(ctx, 0, 'prompt')
  const aspect = ctx.flags.aspect as string
  if (!['16:9', '9:16', '1:1', '4:5'].includes(aspect))
    throw new UsageError('--aspect takes 16:9, 9:16, 1:1 or 4:5.')
  const sound = ctx.flags.sound as string | undefined
  if (sound && !['silent', 'music', 'music_sfx'].includes(sound))
    throw new UsageError('--sound takes silent, music or music_sfx.')
  const input: LocalRunInput = {
    prompt,
    aspect: aspect as LocalRunInput['aspect'],
    durationSec: (ctx.flags.duration as number | undefined) ?? null,
    ...(sound ? { sound: sound as NonNullable<LocalRunInput['sound']> } : {}),
    ...(ctx.flags.voice ? { voiceover: { voice: null, speed: null, script: null } } : {}),
    media: mediaOf((ctx.flags.media as string[] | undefined) ?? []),
  }
  const look = ctx.flags.look as string | undefined
  if (look) {
    input.look = resolveLocalLook(look, ctx.io.env.VA_RUNTIME_SOURCE ?? bundledRuntime())
    ctx.log('local.look', { id: input.look.id, hash: input.look.hash, from: look })
  }
  const out = ctx.flags.out as string | undefined
  return go(ctx, input, (title) => {
    if (out) return resolve(out)
    const base = resolve('videos', slugify(title))
    let dir = base
    for (let i = 2; existsSync(dir); i++) dir = `${base}-${i}`
    return dir
  })
}

const localRevise: Handler = async (ctx) => {
  const dir = resolve(arg(ctx, 0, 'dir'))
  const change = arg(ctx, 1, 'change')
  const jsonPath = join(dir, 'video.json')
  if (!existsSync(jsonPath)) throw new UsageError(`${dir} has no video.json: run video-agent local first.`)
  const video = JSON.parse(readFileSync(jsonPath, 'utf8')) as VideoJson
  const latest = Math.max(...video.versions.map((v) => v.n))
  const from = (ctx.flags['from-version'] as number | undefined) ?? latest
  const source = join(dir, `v${from}`, 'source.tar.gz')
  if (!existsSync(source)) throw new UsageError(`${dir}/v${from} has no source.tar.gz to revise.`)
  if (existsSync(join(dir, `v${latest + 1}`)) && readdirSync(join(dir, `v${latest + 1}`)).length)
    throw new UsageError(`${dir}/v${latest + 1} already exists.`)
  const first = video.versions.find((v) => v.n === from)
  const aspect = first?.width && first.height ? aspectOf(first.width, first.height) : '16:9'
  // --scene: only these scenes (ids or labels), refused before the agent starts as the server would refuse them.
  const names = sceneFlags(ctx)
  const scope = names.length ? localScope(source, names, from) : null
  return go(
    ctx,
    {
      prompt: change,
      aspect,
      revision: {
        jobId: video.jobId,
        parentN: from,
        versionN: latest + 1,
        source,
        ...(scope ? { scope } : {}),
      },
    },
    () => dir,
  )
}

function aspectOf(w: number, h: number): LocalRunInput['aspect'] {
  const r = w / h
  return r > 1.5 ? '16:9' : r < 0.7 ? '9:16' : r < 0.9 ? '4:5' : '1:1'
}

/**
 * local demo <recording>: a demo made on this machine from a recording folder (video-agent record's) or an
 * MP4, the same run the server makes; --quick composes it with no agent and no model.
 */
const localDemo: Handler = async (ctx) => {
  const ref = resolve(arg(ctx, 0, 'recording'))
  if (!existsSync(ref))
    throw new UsageError(`${ref} isn't there: give a video-agent record folder or an MP4.`)
  const { file, trace } = recordingFiles(ref)
  const aspect = (ctx.flags.aspect as string | undefined) ?? '16:9'
  if (!['16:9', '9:16', '1:1', '4:5'].includes(aspect))
    throw new UsageError('--aspect takes 16:9, 9:16, 1:1 or 4:5.')
  const trim = parseTrim(ctx.flags.trim)
  const crop = parseCrop(ctx.flags.crop)
  const hideStrings =
    ctx.flags['hide-text'] === undefined
      ? []
      : ([] as string[])
          .concat(ctx.flags['hide-text'] as string | string[])
          .filter((s) => s.trim().length >= 2)
  const prompt =
    (ctx.flags.prompt as string | undefined) ??
    'A short product demo of what this recording shows, step by step.'
  const input: LocalRunInput = {
    prompt,
    aspect: aspect as LocalRunInput['aspect'],
    durationSec: (ctx.flags.duration as number | undefined) ?? null,
    recording: {
      path: file,
      trace: (ctx.flags.trace as string | undefined) ?? trace,
      ...(trim ? { trim } : {}),
      ...(crop ? { crop } : {}),
      ...(ctx.flags.privacy ? { privacy: true } : {}),
      ...(hideStrings.length ? { hideStrings } : {}),
      ...(ctx.flags.quick ? { quick: true } : {}),
    },
  }
  const look = ctx.flags.look as string | undefined
  if (look) input.look = resolveLocalLook(look, ctx.io.env.VA_RUNTIME_SOURCE ?? bundledRuntime())
  const out = ctx.flags.out as string | undefined
  return go(ctx, input, (title) => {
    if (out) return resolve(out)
    const base = resolve('videos', slugify(title))
    let dir = base
    for (let i = 2; existsSync(dir); i++) dir = `${base}-${i}`
    return dir
  })
}

export const LOCAL_COMMANDS: Record<string, Handler> = {
  local,
  'local revise': localRevise,
  'local demo': localDemo,
}
