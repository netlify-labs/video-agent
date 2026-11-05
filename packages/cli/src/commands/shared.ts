// Helpers the remote commands share: resolving <video> arguments, picking a version, durations and progress lines.
import type { Video } from '../../../sdk/src/index.js'
import { UsageError } from '../exit.js'
import type { Ctx } from '../router.js'

/** The positional at `i`, or a usage error naming it. */
export function arg(ctx: Ctx, i: number, name: string): string {
  const v = ctx.args[i]
  if (v === undefined || v === '')
    throw new UsageError(`Missing <${name}>. Run: video-agent ${ctx.spec.name} --help`)
  return v
}

/** A <video> argument (an id, a web address or a share link) as { id, versionN? } through the SDK. */
export async function resolveVideoArg(ctx: Ctx, i = 0) {
  return ctx.sdk().videos.resolve(arg(ctx, i, 'video'))
}

/** The version a command acts on: --version, then the one a web or share link named, then the latest. */
export function pickVersion(ctx: Ctx, video: Pick<Video, 'latestVersion'>, fromRef?: number): number {
  const flag = ctx.flags.version
  return typeof flag === 'number' ? flag : (fromRef ?? video.latestVersion)
}

/** "90", "90s", "30m", "2h" → milliseconds. */
export function durationMs(value: string | number, flag: string): number {
  if (typeof value === 'number') return value * 1000
  const m = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(value.trim())
  if (!m) throw new UsageError(`--${flag} takes seconds or a duration like 90s, 30m or 2h.`)
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? 's') as 's']
}

/** One progress line on stderr, overwritten in place on a terminal. Never on stdout. */
export function progressLine(ctx: Ctx) {
  let last = ''
  return (text: string) => {
    if (text === last) return
    last = text
    ctx.io.stderr(`${text}\n`)
  }
}

/** A version's status in words, for the progress line. */
export function describeProgress(p: { status: string; stage: string | null; step: string | null }) {
  if (p.status === 'queued') return 'Queued'
  if (p.status === 'ready') return 'Ready'
  return ['Making the video', p.stage, p.step].filter(Boolean).join(' · ')
}
