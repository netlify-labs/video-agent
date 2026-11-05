// video-agent record (screen-recording plan §4.6; va-rsk5.5.1, va-rsk5.5.2): records a site in Chromium with a pointer
// trace, on this machine (no server). The capture is src/record/capture.ts. Sign-in files (--storage-state) stay out of
// the recording folder, and the one it saves is readable by you only, so a recording folder is safe to upload or share.
import { isAbsolute, relative, resolve } from 'node:path'
import { CliError, UsageError } from '../exit.js'
import { runRecord } from '../record/capture.js'
import type { Handler } from '../router.js'
import { VERSION } from '../version.js'
import { arg } from './shared.js'

/** "1280x800" -> { width, height }. */
export function parseViewport(v: unknown): { width: number; height: number } {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(typeof v === 'string' ? v : '1280x800')
  const width = Number(m?.[1])
  const height = Number(m?.[2])
  if (!m || width < 320 || height < 240 || width > 3840 || height > 2160)
    throw new UsageError('--viewport takes a size like 1280x800 (320x240 to 3840x2160).')
  return { width, height }
}

/** Whether `p` is `dir` or inside it. */
const inside = (dir: string, p: string) => {
  const r = relative(resolve(dir), resolve(p))
  return r === '' || (!r.startsWith('..') && !isAbsolute(r))
}

/** Refuses a sign-in file inside the recording folder (it would travel with the recording). */
export function checkStorageState(out: string, files: (string | undefined)[]) {
  for (const f of files)
    if (f && inside(out, f))
      throw new UsageError(
        `Keep sign-in files out of the recording folder: ${f} is inside ${out}. Put it somewhere else, like ~/.video-agent/.`,
      )
}

const record: Handler = async (ctx) => {
  const url = arg(ctx, 0, 'url')
  try {
    new URL(url)
  } catch {
    throw new UsageError(`<url> must be a web address, like https://app.example.com (got ${url}).`)
  }
  const out = String(ctx.flags.out ?? './recording')
  const storageState = typeof ctx.flags['storage-state'] === 'string' ? ctx.flags['storage-state'] : undefined
  const saveStorageState =
    typeof ctx.flags['save-storage-state'] === 'string' ? ctx.flags['save-storage-state'] : undefined
  checkStorageState(out, [storageState, saveStorageState])
  const dpr = Number(ctx.flags.dpr ?? 2)
  const fps = Number(ctx.flags.fps ?? 30)
  if (![1, 2].includes(dpr)) throw new UsageError('--dpr is 1 or 2.')
  if (![24, 25, 30].includes(fps)) throw new UsageError('--fps is 24, 25 or 30.')
  const durationS = ctx.flags.duration === undefined ? undefined : Number(ctx.flags.duration)
  if (durationS !== undefined && !(durationS > 0 && durationS <= 300))
    throw new UsageError('--duration is 1 to 300 seconds.')
  const hide =
    ctx.flags.hide === undefined ? [] : ([] as string[]).concat(ctx.flags.hide as string | string[])
  try {
    const r = await runRecord({
      url,
      viewport: parseViewport(ctx.flags.viewport),
      dpr,
      fps,
      out,
      storageState,
      saveStorageState,
      durationS,
      script: typeof ctx.flags.script === 'string' ? ctx.flags.script : undefined,
      headless: ctx.flags.headless === true,
      hide,
      names: ctx.flags['no-target-names'] !== true,
      tool: `netlify-video-agent@${VERSION}`,
      log: ctx.log,
      say: (text) => ctx.io.stderr(`${text}\n`),
    })
    const text = [
      `Recorded ${r.seconds.toFixed(1)} s at ${String(r.width)}x${String(r.height)}: ${r.file}`,
      `Pointer trace: ${r.trace} (${String(r.clicks)} clicks, ${String(r.hidden)} hidden ${r.hidden === 1 ? 'field' : 'fields'})`,
    ].join('\n')
    return { json: r, text }
  } catch (e) {
    if (e instanceof UsageError) throw e
    throw new CliError('record_failed', e instanceof Error ? e.message : String(e), 1)
  }
}

export const RECORD_COMMANDS: Record<string, Handler> = { record }
