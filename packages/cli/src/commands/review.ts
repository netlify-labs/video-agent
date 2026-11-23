// publish, unpublish, cancel, retry, comments list|add, verdict. Each acts
// on one version: --version, else the one a web or share link named, else the latest.
import type { Publication } from '../../../sdk/src/index.js'
import { UsageError } from '../exit.js'
import type { Ctx, Handler } from '../router.js'
import { arg, pickVersion, resolveVideoArg } from './shared.js'

/** The video and the version a command acts on. */
async function target(ctx: Ctx) {
  const ref = await resolveVideoArg(ctx)
  const video = await ctx.sdk().videos.get(ref.id)
  return { video, n: pickVersion(ctx, video, ref.versionN) }
}

const publish: Handler = async (ctx) => {
  const { video, n } = await target(ctx)
  const pub: Publication = await ctx.sdk().versions.publish(video.id, n, {
    ...(ctx.flags.transcript ? { showTranscript: true } : {}),
  })
  return {
    json: pub,
    text: [
      `Published v${n} of ${video.title}`,
      `  share  ${pub.urls?.page ?? ''}`,
      `  mp4    ${pub.urls?.mp4 ?? ''}`,
      '',
      'Embed:',
      pub.embed ?? '',
      ...(pub.player ? ['', 'Player:', pub.player] : []),
    ].join('\n'),
  }
}

const unpublish: Handler = async (ctx) => {
  const { video, n } = await target(ctx)
  await ctx.sdk().versions.unpublish(video.id, n)
  return {
    json: { videoId: video.id, version: n, published: false },
    text: `Unpublished v${n} of ${video.title}.`,
  }
}

const cancel: Handler = async (ctx) => {
  const { video, n } = await target(ctx)
  const r = await ctx.sdk().versions.cancel(video.id, n)
  return {
    json: r,
    text: `Cancelled v${n} of ${video.title}.`,
  }
}

const retry: Handler = async (ctx) => {
  const { video, n } = await target(ctx)
  const va = ctx.sdk()
  const r = await va.versions.retry(video.id, n)
  if (!ctx.flags.wait)
    return { json: r, text: `Retrying v${n} of ${video.title}. Follow it: video-agent wait ${video.id}` }
  const ready = await va.videos.wait(video.id, {
    version: n,
    ...(ctx.io.pollMs !== undefined ? { intervalMs: ctx.io.pollMs } : {}),
  })
  return { json: ready, text: `v${n} of ${ready.title} is ready: ${va.url}/videos/${ready.id}` }
}

const commentsList: Handler = async (ctx) => {
  const ref = await resolveVideoArg(ctx)
  const version = typeof ctx.flags.version === 'number' ? ctx.flags.version : ref.versionN
  const page = await ctx.sdk().comments.list(ref.id, version ? { version } : {})
  const time = (s: number | null) => (s === null ? '' : ` @${s.toFixed(1)}s`)
  return {
    json: page,
    text: page.items.length
      ? page.items
          .map((c) => `v${c.versionN}${time(c.timeSec)}  ${c.author.name ?? c.author.id}: ${c.body}`)
          .join('\n')
      : 'No comments.',
  }
}

const commentsAdd: Handler = async (ctx) => {
  const { video, n } = await target(ctx)
  const body = arg(ctx, 1, 'text')
  const at = ctx.flags.at
  const comment = await ctx.sdk().comments.add(video.id, {
    versionN: n,
    body,
    ...(typeof at === 'number' ? { timeSec: at } : {}),
  })
  return { json: comment, text: `Commented on v${n}${typeof at === 'number' ? ` at ${at}s` : ''}.` }
}

const VERDICTS = { approve: 'approved', changes: 'changes_requested', clear: null } as const

const verdict: Handler = async (ctx) => {
  const word = arg(ctx, 1, 'verdict')
  if (!(word in VERDICTS)) throw new UsageError('The verdict is approve, changes or clear.')
  const { video, n } = await target(ctx)
  const value = VERDICTS[word as keyof typeof VERDICTS]
  const note = typeof ctx.flags.note === 'string' ? ctx.flags.note : undefined
  const r = await ctx.sdk().versions.setVerdict(video.id, n, { verdict: value, ...(note ? { note } : {}) })
  return {
    json: r,
    text: value === null ? `Cleared your verdict on v${n}.` : `Marked v${n} ${value.replace('_', ' ')}.`,
  }
}

export const REVIEW_COMMANDS: Record<string, Handler> = {
  publish,
  unpublish,
  cancel,
  retry,
  'comments list': commentsList,
  'comments add': commentsAdd,
  verdict,
}
