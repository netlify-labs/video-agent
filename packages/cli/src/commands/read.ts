// get, list, wait, download, open (cli-and-sdk plan §6.2; bead va-p1th.4.7). Every <video> is an id, a web address or
// a share link, resolved by the SDK.
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isVideoAgentError, type Video, type VersionFile } from '../../../sdk/src/index.js'
import { CliError, EXIT, UsageError } from '../exit.js'
import type { Handler } from '../router.js'
import { describeProgress, durationMs, pickVersion, progressLine, resolveVideoArg } from './shared.js'

/** The CLI's file names → the API's. */
const FILES: Record<string, { api: VersionFile; ext: string }> = {
  video: { api: 'video', ext: 'mp4' },
  poster: { api: 'poster', ext: 'jpg' },
  gif: { api: 'gif', ext: 'gif' },
  captions: { api: 'captions', ext: 'vtt' },
  narration: { api: 'narration-audio', ext: 'mp3' },
  transcript: { api: 'transcript', ext: 'txt' },
}

const summary = (v: Video, site: string) => {
  const lines = [`${v.title} (${v.id})`]
  for (const ver of [...v.versions].sort((a, b) => a.n - b.n)) {
    const live = ver.publications.find((p) => !p.unpublishedAt)
    lines.push(`  v${ver.n}  ${ver.status}${live?.urls?.page ? `  published ${live.urls.page}` : ''}`)
  }
  lines.push(`  ${site}/videos/${v.id}`)
  return lines.join('\n')
}

const get: Handler = async (ctx) => {
  const { id } = await resolveVideoArg(ctx)
  const video = await ctx.sdk().videos.get(id)
  return { json: video, text: summary(video, ctx.sdk().url) }
}

const list: Handler = async (ctx) => {
  const f = ctx.flags
  const input = {
    ...(f.mine ? { owner: 'me' as const } : {}),
    ...(typeof f.search === 'string' ? { q: f.search } : {}),
    ...(typeof f.status === 'string' ? { status: f.status as Video['status'] } : {}),
    ...(f.published ? { published: 'true' as const } : {}),
    ...(f.favorite ? { favorite: 'true' as const } : {}),
    ...(typeof f.limit === 'number' ? { limit: f.limit } : {}),
  }
  const va = ctx.sdk()
  let items: Video[]
  let nextCursor: string | null = null
  if (f.all) {
    items = []
    for await (const v of va.videos.listAll(input)) items.push(v)
  } else {
    const page = await va.videos.list(input)
    items = page.items
    nextCursor = page.nextCursor
  }
  const width = Math.max(0, ...items.map((v) => v.status.length))
  return {
    json: { items, nextCursor },
    text: items.length
      ? [
          ...items.map((v) => `${v.id}  ${v.status.padEnd(width)}  ${v.title}`),
          ...(nextCursor ? ['', 'More videos: add --all, or --limit.'] : []),
        ].join('\n')
      : 'No videos.',
  }
}

const wait: Handler = async (ctx) => {
  const ref = await resolveVideoArg(ctx)
  const show = progressLine(ctx)
  const timeout = ctx.flags.timeout
  const video = await ctx.sdk().videos.wait(ref.id, {
    ...(typeof ctx.flags.version === 'number' ? { version: ctx.flags.version } : {}),
    ...(timeout !== undefined ? { timeoutMs: durationMs(timeout as string, 'timeout') } : {}),
    onProgress: (p) => {
      ctx.log('wait.progress', { ...p })
      if (!ctx.json) show(`v${p.version} · ${describeProgress(p)}`)
    },
  })
  if (!ctx.json) ctx.io.stderr(`Ready: ${ctx.sdk().url}/videos/${video.id}\n`)
  // Progress and the result go to stderr; stdout stays empty unless --json asks for the video.
  return { json: video, text: '' }
}

async function isDir(path: string) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

const download: Handler = async (ctx) => {
  const ref = await resolveVideoArg(ctx)
  const va = ctx.sdk()
  const video = await va.videos.get(ref.id)
  const n = pickVersion(ctx, video, ref.versionN)
  const which = String(ctx.flags.file ?? 'video')
  if (which !== 'all' && !FILES[which])
    throw new UsageError(`--file is one of ${[...Object.keys(FILES), 'all'].join(', ')}.`)
  const names = which === 'all' ? Object.keys(FILES) : [which]
  const out = typeof ctx.flags.out === 'string' ? ctx.flags.out : undefined
  // One file: --out is the file (or a folder to put it in). Several: --out is the folder (default <id>-v<n>).
  const dir = names.length > 1 ? (out ?? `${video.id}-v${n}`) : out && (await isDir(out)) ? out : '.'
  if (names.length > 1) await mkdir(dir, { recursive: true })
  const written: { file: string; path: string; bytes: number }[] = []
  const skipped: { file: string; reason: string }[] = []
  for (const name of names) {
    const f = FILES[name]
    if (!f) continue
    const path =
      names.length === 1 && out && !(await isDir(out)) ? out : join(dir, `${video.id}-v${n}.${f.ext}`)
    try {
      if (!ctx.json) ctx.io.stderr(`Downloading ${name}…\n`)
      const r = await va.files.download(video, { file: f.api, version: n, to: path })
      written.push({ file: name, path: r.path, bytes: r.bytes })
    } catch (e) {
      // With --file all, a file this version doesn't have (no narration, say) is skipped with a note.
      if (names.length > 1 && isVideoAgentError(e) && e.status === 404) {
        skipped.push({ file: name, reason: e.message })
        continue
      }
      throw e
    }
  }
  return {
    json: { videoId: video.id, version: n, files: written, skipped },
    text: [
      ...written.map((w) => `${w.path}  ${(w.bytes / 1024 / 1024).toFixed(1)} MB`),
      ...skipped.map((s) => `skipped ${s.file}: ${s.reason}`),
    ].join('\n'),
  }
}

const open: Handler = async (ctx) => {
  const { id } = await resolveVideoArg(ctx)
  const url = `${ctx.sdk().url}/videos/${id}`
  if (!ctx.json) {
    try {
      await ctx.io.openBrowser(url)
    } catch {
      throw new CliError('no_browser', `Couldn't open a browser. The video is at ${url}`, EXIT.error)
    }
  }
  return { json: { url }, text: url }
}

export const READ_COMMANDS: Record<string, Handler> = { get, list, wait, download, open }
