// scenes, and the scene names revise --scene and redo take. A scene is
// named by its id or its label (case-insensitive, unique); the version's scenes come with the video, or from
// GET …/beats for an older one.
import type { Video } from '../../../sdk/src/index.js'
import { CliError, EXIT, UsageError } from '../exit.js'
import type { Ctx, Handler } from '../router.js'
import { pickVersion, resolveVideoArg } from './shared.js'

type Beat = { id: string; label: string | null; start: number; duration: number }

/** The held last frame under recorded narration: a beat, never a scene to redo. */
const HOLD = 'va-hold'

const mss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`
const named = (b: Beat) => (b.label ? `${b.id} (${b.label})` : b.id)

/** A version's scenes: from the video, else asked for (and filled) through versions.beats. */
export async function scenesOf(ctx: Ctx, video: Video, n: number): Promise<Beat[]> {
  const v = video.versions.find((x) => x.n === n)
  if (!v) throw new CliError('not_found', `${video.id} has no version ${n}.`, EXIT.notFound)
  if (v.status !== 'ready') throw new UsageError(`v${n} isn't ready (${v.status}).`)
  const beats = v.beats ?? (await ctx.sdk().versions.beats(video.id, n)).beats
  if (!beats)
    throw new CliError(
      'not_editable',
      `v${n} doesn't keep the editing contract, so it has no scenes to redo. Revise the whole video instead.`,
      EXIT.conflict,
    )
  return beats
}

/** The latest ready version, the one a scoped revision starts from unless --from-version says otherwise. */
const latestReady = (video: Video) => {
  const n = video.versions.find((v) => v.status === 'ready')?.n
  if (n === undefined) throw new UsageError(`${video.id} has no ready version to redo scenes of.`)
  return n
}

/** --scene values (ids or labels) → scene ids, in the version's order; ambiguous or unknown names exit 2. */
export function resolveScenes(beats: Beat[], names: string[]): string[] {
  const scenes = beats.filter((b) => b.id !== HOLD)
  const list = scenes.map(named).join(', ')
  const ids = new Set<string>()
  for (const raw of names) {
    const name = raw.trim().toLowerCase()
    const byId = scenes.find((b) => b.id.toLowerCase() === name)
    const byLabel = scenes.filter((b) => b.label?.toLowerCase() === name)
    if (byId) ids.add(byId.id)
    else if (byLabel.length === 1 && byLabel[0]) ids.add(byLabel[0].id)
    else if (byLabel.length > 1)
      throw new UsageError(
        `"${raw}" names more than one scene: ${byLabel.map(named).join(', ')}. Use the id.`,
      )
    else throw new UsageError(`There's no scene "${raw}". This version's scenes: ${list}.`)
  }
  return scenes.map((b) => b.id).filter((id) => ids.has(id))
}

/** The --scene flag as a list. */
export function sceneFlags(ctx: Ctx): string[] {
  const raw = ctx.flags.scene
  return Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
}

/** For revise --scene and redo: the version the scenes are from, and their ids. */
export async function scopeFor(ctx: Ctx, video: Video, fromFlag: number | undefined) {
  const fromVersion = fromFlag ?? latestReady(video)
  return { fromVersion, beats: resolveScenes(await scenesOf(ctx, video, fromVersion), sceneFlags(ctx)) }
}

const scenes: Handler = async (ctx) => {
  const ref = await resolveVideoArg(ctx)
  const video = await ctx.sdk().videos.get(ref.id)
  const n = pickVersion(ctx, video, ref.versionN ?? latestReady(video))
  const beats = await scenesOf(ctx, video, n)
  return {
    json: { videoId: video.id, version: n, scenes: beats },
    text: beats
      .map((b, i) =>
        b.id === HOLD
          ? `   ${mss(b.start)}–${mss(b.start + b.duration)}  (the held last frame; redo it with a whole revision)`
          : `${i + 1}. ${b.id}${b.label ? `  ${b.label}` : ''}  ${mss(b.start)}–${mss(b.start + b.duration)}`,
      )
      .join('\n'),
  }
}

export const SCENE_COMMANDS: Record<string, Handler> = { scenes }
