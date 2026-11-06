// create, revise, remix and redo (cli-and-sdk plan §6.2; beads va-p1th.4.6, va-8cy4.5.2). Flags map to the API's own fields
// (CreateVideoSchema, ReviseSchema, RemixSchema). --media takes ids or files (uploaded first, deduped), --wait
// follows the run with a progress line on stderr, --out downloads the video, poster and captions.
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Video } from '../../../sdk/src/index.js'
import { CliError, EXIT, UsageError } from '../exit.js'
import type { Ctx, Handler } from '../router.js'
import { sceneFlags, scopeFor } from './scenes.js'
import { describeProgress, durationMs, progressLine, resolveVideoArg } from './shared.js'

const str = (ctx: Ctx, flag: string) => {
  const v = ctx.flags[flag]
  return typeof v === 'string' ? v : undefined
}
const num = (ctx: Ctx, flag: string) => {
  const v = ctx.flags[flag]
  return typeof v === 'number' ? v : undefined
}
/** { [key]: value } when there is a value, {} otherwise (the API's optional fields never get undefined). */
const opt = <K extends string, V>(key: K, value: V | undefined) =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>

async function readText(ctx: Ctx, from: string) {
  return from === '-' ? ctx.io.stdin() : readFile(from, 'utf8')
}

/** The prompt: the positional at `i`, else --prompt-file (a file, or - for stdin). */
async function promptOf(ctx: Ctx, i: number): Promise<string> {
  const file = str(ctx, 'prompt-file')
  const text = file ? await readText(ctx, file) : ctx.args[i]
  if (!text?.trim())
    throw new UsageError(`Give the ${i ? 'change' : 'prompt'} as an argument, or --prompt-file <file|->.`)
  return text.trim()
}

const isFile = async (p: string) => {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

/** --media: an id as is; a file (optionally file:"caption") uploaded first, deduped, waited for. */
async function mediaIds(ctx: Ctx): Promise<string[] | undefined> {
  const raw = ctx.flags.media
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  if (!list.length) return undefined
  if (list.length > 12) throw new UsageError('At most 12 --media items.')
  const ids: string[] = []
  for (const item of list) {
    if (/^med_[A-Za-z0-9]+$/.test(item) && !(await isFile(item))) {
      ids.push(item)
      continue
    }
    const m = /^(.*?):"?(.*?)"?$/.exec(item)
    const [path, caption] = m?.[1] && (await isFile(m[1])) ? [m[1], m[2]] : [item, undefined]
    if (!(await isFile(path))) throw new UsageError(`--media ${item}: not a media id (med_…) or a file.`)
    if (!ctx.json) ctx.io.stderr(`Uploading ${path}…\n`)
    const uploaded = await ctx.sdk().media.upload(path, caption ? { caption } : {})
    ids.push(uploaded.id)
  }
  return ids
}

/** --look: a Look id, or none for no look (the API's null); left out, the server decides (default, or kept). */
export function lookOf(ctx: Ctx): { look?: string | null } {
  const v = str(ctx, 'look')
  if (v === undefined) return {}
  return { look: v === 'none' ? null : v }
}

/** The fields create, revise and remix share. */
async function common(ctx: Ctx) {
  const voice = str(ctx, 'voice')
  const media = await mediaIds(ctx)
  return {
    ...opt('durationSec', num(ctx, 'duration')),
    ...(str(ctx, 'sound') ? { sound: str(ctx, 'sound') as 'silent' | 'music' | 'music_sfx' } : {}),
    ...(voice ? { voiceover: voice === 'off' ? { enabled: false } : { enabled: true, voice } } : {}),
    ...(media ? { mediaIds: media } : {}),
    ...opt('webhookUrl', str(ctx, 'webhook-url')),
    ...lookOf(ctx),
  }
}

const opts = (ctx: Ctx) => opt('idempotencyKey', str(ctx, 'idempotency-key'))

/** --wait and --out: follow the new version, then download its video, poster and captions. */
export async function follow(ctx: Ctx, video: Video, n: number) {
  const out = str(ctx, 'out')
  if (!ctx.flags.wait && !out)
    return {
      json: video,
      text: `${video.title} (${video.id}): v${n} queued. Follow it: video-agent wait ${video.id}`,
    }
  const show = progressLine(ctx)
  const timeout = ctx.flags.timeout
  const va = ctx.sdk()
  const ready = await va.videos.wait(video.id, {
    version: n,
    ...(timeout !== undefined ? { timeoutMs: durationMs(timeout as string, 'timeout') } : {}),
    ...(ctx.io.pollMs !== undefined ? { intervalMs: ctx.io.pollMs } : {}),
    onProgress: (p) => {
      if (!ctx.json) show(`v${p.version} · ${describeProgress(p)}`)
    },
  })
  if (!out) return { json: ready, text: `${va.url}/videos/${ready.id}` }
  const files: string[] = []
  for (const [file, ext] of [
    ['video', 'mp4'],
    ['poster', 'jpg'],
    ['captions', 'vtt'],
  ] as const) {
    const r = await va.files.download(ready, { file, version: n, to: join(out, `${ready.id}-v${n}.${ext}`) })
    files.push(r.path)
  }
  return { json: { ...ready, files }, text: files.join('\n') }
}

const create: Handler = async (ctx) => {
  const va = ctx.sdk()
  const planId = str(ctx, 'plan-id')
  const answers = str(ctx, 'answers')
  const base = {
    ...(str(ctx, 'aspect') ? { aspect: str(ctx, 'aspect') as '16:9' } : {}),
    ...(await common(ctx)),
  }
  // Planning: --plan asks the questions and stops; --plan-id with --answers writes the brief and makes the video.
  if (ctx.flags.plan || planId) {
    if (!(await va.config.supports('planning')))
      throw new CliError(
        'unsupported_by_server',
        "This server doesn't support planning yet.",
        EXIT.unsupported,
      )
  }
  if (ctx.flags.plan) {
    const plan = await va.plans.create({ prompt: await promptOf(ctx, 0), ...base })
    const asked = await va.plans.questions(plan.id)
    const questions = (asked.questions ?? []).map((q) => ({
      id: q.id,
      text: q.question,
      choices: q.options.map((o) => ({ id: o.id, label: o.label, recommended: o.recommended ?? false })),
    }))
    return {
      json: { planId: plan.id, questions },
      text: [
        `Plan ${plan.id}`,
        ...questions.flatMap((q) => [
          '',
          `${q.id}: ${q.text}`,
          ...q.choices.map((c) => `  ${c.id}  ${c.label}${c.recommended ? ' (recommended)' : ''}`),
        ]),
        '',
        `Answer them: video-agent create --plan-id ${plan.id} --answers answers.json`,
      ].join('\n'),
    }
  }
  let prompt: string
  if (planId) {
    if (!answers)
      throw new UsageError(
        '--plan-id needs --answers <file|-> ({ "answers": [{ "questionId", "optionIds" }] }).',
      )
    let body: { answers: { questionId: string }[] }
    try {
      body = JSON.parse(await readText(ctx, answers)) as typeof body
    } catch {
      throw new UsageError('--answers must be JSON: { "answers": [{ "questionId", "optionIds" }] }.')
    }
    const plan = await va.plans.brief(planId, body)
    prompt = ctx.args[0] ?? plan.prompt
  } else prompt = await promptOf(ctx, 0)
  const video = await va.videos.create(
    {
      prompt,
      ...base,
      ...opt('title', str(ctx, 'title')),
      ...(planId ? { planId } : {}),
    },
    opts(ctx),
  )
  return follow(ctx, video, video.latestVersion)
}

const revise: Handler = async (ctx) => {
  const ref = await resolveVideoArg(ctx)
  const comments = str(ctx, 'comments')
  // --scene: a scoped revision of the scenes named (ids or labels) in --from-version, default the latest ready.
  const scope = sceneFlags(ctx).length
    ? await scopeFor(ctx, await ctx.sdk().videos.get(ref.id), num(ctx, 'from-version'))
    : null
  const video = await ctx.sdk().videos.revise(
    ref.id,
    {
      prompt: await promptOf(ctx, 1),
      ...(await common(ctx)),
      ...opt('fromVersion', scope?.fromVersion ?? num(ctx, 'from-version')),
      ...(scope ? { scope: { beats: scope.beats } } : {}),
      ...(comments
        ? {
            commentIds: comments
              .split(',')
              .map((c) => c.trim())
              .filter(Boolean),
          }
        : {}),
    },
    opts(ctx),
  )
  return follow(ctx, video, video.latestVersion)
}

const remix: Handler = async (ctx) => {
  const ref = await resolveVideoArg(ctx)
  const video = await ctx.sdk().videos.remix(
    ref.id,
    {
      prompt: await promptOf(ctx, 1),
      ...(await common(ctx)),
      ...opt('fromVersion', num(ctx, 'from-version')),
      ...(str(ctx, 'aspect') ? { aspect: str(ctx, 'aspect') as '16:9' } : {}),
      ...(str(ctx, 'language') ? { language: str(ctx, 'language') as 'en' } : {}),
    },
    opts(ctx),
  )
  return follow(ctx, video, video.latestVersion)
}

/** redo: revise --scene's short form, through the SDK's redoScenes (hidden until the server lists scoped_revision). */
const redo: Handler = async (ctx) => {
  const ref = await resolveVideoArg(ctx)
  if (!sceneFlags(ctx).length) throw new UsageError('Name at least one --scene (an id or a label).')
  const va = ctx.sdk()
  const { fromVersion, beats } = await scopeFor(ctx, await va.videos.get(ref.id), num(ctx, 'from-version'))
  const video = await va.videos.redoScenes(
    ref.id,
    { beats, prompt: await promptOf(ctx, 1), fromVersion },
    opts(ctx),
  )
  return follow(ctx, video, video.latestVersion)
}

export const MAKE_COMMANDS: Record<string, Handler> = { create, revise, remix, redo }
