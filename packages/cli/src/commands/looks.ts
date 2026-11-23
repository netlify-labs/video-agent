// looks and restyle: the Looks this deployment offers, and a revision in another
// Look. --look on create, revise and remix lives with them in make.ts; `none` there means no look.
import { CliError, EXIT } from '../exit.js'
import type { Handler } from '../router.js'
import { follow } from './make.js'
import { arg, resolveVideoArg } from './shared.js'

const looks: Handler = async (ctx) => {
  const { looks: list, default: def } = await ctx.sdk().looks.list()
  const width = Math.max(4, ...list.map((l) => l.id.length))
  return {
    json: { looks: list, default: def },
    text: list.length
      ? list
          .map((l) =>
            [
              l.id.padEnd(width),
              l.name,
              ...(l.id === def ? ['(default)'] : []),
              ...(l.enabled ? [] : ['(turned off)']),
              `\n${' '.repeat(width + 2)}${l.description}`,
            ].join('  '),
          )
          .join('\n')
      : 'This deployment has no Looks.',
  }
}

/** restyle <video> <look>: revise with that Look and a stock request (none: without a look). */
const restyle: Handler = async (ctx) => {
  const ref = await resolveVideoArg(ctx)
  const id = arg(ctx, 1, 'look')
  const va = ctx.sdk()
  let prompt = 'Restyle this video without a look.'
  if (id !== 'none') {
    const look = (await va.looks.list()).looks.find((l) => l.id === id)
    if (!look)
      throw new CliError('unknown_look', `There's no Look called "${id}". See: video-agent looks`, EXIT.usage)
    prompt = `Restyle this video in the ${look.name} look.`
  }
  const video = await va.videos.revise(ref.id, { prompt, look: id === 'none' ? null : id })
  return follow(ctx, video, video.latestVersion)
}

export const LOOK_COMMANDS: Record<string, Handler> = { looks, restyle }
