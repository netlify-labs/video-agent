// A demo from the CLI (screen-recording plan §6.3; va-rsk5.5.3): a recording given as a library id, a recording folder
// (video-agent record's: recording.mp4 and trace.json) or an MP4 with an optional trace beside it, uploaded with the
// screen-recording role when it's a file; and the recording field of a create, from --trim, --crop, --privacy, --hide-text.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { components } from '../../../sdk/src/generated/schema.js'
import { UsageError } from '../exit.js'
import type { Ctx } from '../router.js'
import { progressLine } from './shared.js'

type Trace = components['schemas']['PointerTrace']
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`

/** A recording folder or file -> the MP4 and the trace beside it, if any. */
export function recordingFiles(path: string): { file: string; trace: string | null } {
  if (statSync(path).isDirectory()) {
    const file = join(path, 'recording.mp4')
    if (!existsSync(file))
      throw new UsageError(`${path} has no recording.mp4 (the folder video-agent record writes).`)
    const trace = join(path, 'trace.json')
    return { file, trace: existsSync(trace) ? trace : null }
  }
  const beside = join(path, '..', 'trace.json')
  return { file: path, trace: existsSync(beside) ? beside : null }
}

/** Uploads a recording (with its trace) and returns the media id; a med_ id is used as it is. */
export async function recordingMediaId(ctx: Ctx, ref: string, traceFlag?: string): Promise<string> {
  if (/^med_[a-z0-9]+$/.test(ref)) return ref
  if (!existsSync(ref))
    throw new UsageError(
      `--recording takes a media id (med_…), a recording folder or an MP4: ${ref} isn't there.`,
    )
  const { file, trace } = recordingFiles(ref)
  const tracePath = traceFlag ?? trace
  const show = progressLine(ctx)
  const item = await ctx.sdk().media.uploadRecording(file, {
    ...(tracePath ? { trace: JSON.parse(readFileSync(tracePath, 'utf8')) as Trace } : {}),
    onProgress: (p) => {
      if (!ctx.json)
        show(`${file}: ${p.phase}${p.phase === 'uploading' ? ` ${mb(p.sent)} / ${mb(p.total)}` : ''}`)
    },
  })
  return item.id
}

/** "in,out" seconds -> [in, out]. */
export function parseTrim(v: unknown): [number, number] | undefined {
  if (v === undefined) return undefined
  if (typeof v !== 'string')
    throw new UsageError('--trim takes in,out seconds of the recording (like 2,48.5).')
  const m = /^\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*$/.exec(v)
  if (!m || !(Number(m[1]) < Number(m[2])))
    throw new UsageError('--trim takes in,out seconds of the recording, in before out (like 2,48.5).')
  return [Number(m[1]), Number(m[2])]
}

/** "x,y,width,height" fractions of the frame -> [x, y, width, height]. */
export function parseCrop(v: unknown): [number, number, number, number] | undefined {
  if (v === undefined) return undefined
  const usage =
    '--crop takes x,y,width,height as fractions of the picture, inside it (like 0,0.08,1,0.84 to cut a menu bar and a dock).'
  if (typeof v !== 'string') throw new UsageError(usage)
  const n = v.split(',').map((s) => (/^\s*\d*\.?\d+\s*$/.test(s) ? Number(s) : NaN))
  const [x, y, w, h] = n as [number, number, number, number]
  if (
    n.length !== 4 ||
    n.some((k) => !Number.isFinite(k)) ||
    !(w > 0 && h > 0) ||
    x + w > 1 + 1e-6 ||
    y + h > 1 + 1e-6
  )
    throw new UsageError(usage)
  return [x, y, Math.min(w, 1 - x), Math.min(h, 1 - y)]
}

/** The create's recording field: the media id, --trim, --crop, --privacy and --hide-text. */
export function recordingInput(ctx: Ctx, mediaId: string) {
  const trim = parseTrim(ctx.flags.trim)
  const crop = parseCrop(ctx.flags.crop)
  const hideStrings =
    ctx.flags['hide-text'] === undefined
      ? []
      : ([] as string[])
          .concat(ctx.flags['hide-text'] as string | string[])
          .map((s) => s.trim())
          .filter((s) => s.length >= 2)
  return {
    mediaId,
    ...(trim ? { trim } : {}),
    ...(crop ? { crop } : {}),
    ...(ctx.flags.privacy === true ? { privacy: true } : {}),
    ...(hideStrings.length ? { hideStrings } : {}),
  }
}
