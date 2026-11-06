// media upload|list|get (bead va-p1th.4.9), api and keys list|revoke|create (bead va-p1th.4.10).
import { readFile } from 'node:fs/promises'
import type { Media } from '../../../sdk/src/index.js'
import { CliError, EXIT, UsageError } from '../exit.js'
import type { Handler } from '../router.js'
import { recordingMediaId } from './recording.js'
import { arg, progressLine } from './shared.js'

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`

const mediaUpload: Handler = async (ctx) => {
  if (!ctx.args.length) throw new UsageError('Missing <file>. Run: video-agent media upload --help')
  const caption = typeof ctx.flags.caption === 'string' ? ctx.flags.caption : undefined
  const items: Media[] = []
  // A screen recording: uploaded with its role (and --trace, or the trace.json of a recording folder).
  if (ctx.flags.role !== undefined) {
    if (ctx.flags.role !== 'screen-recording') throw new UsageError('--role takes screen-recording.')
    for (const ref of ctx.args) {
      const id = await recordingMediaId(
        ctx,
        ref,
        typeof ctx.flags.trace === 'string' ? ctx.flags.trace : undefined,
      )
      items.push(await ctx.sdk().media.get(id))
    }
    return {
      json: {
        items: items.map((m) => ({
          id: m.id,
          status: m.status,
          kind: m.kind,
          filename: m.filename,
          hasTrace: m.hasTrace,
        })),
      },
      text: items
        .map((m) => `${m.id}  screen recording${m.hasTrace ? ' with a pointer trace' : ''}  ${m.filename}`)
        .join('\n'),
    }
  }
  if (ctx.flags.trace !== undefined) throw new UsageError('--trace goes with --role screen-recording.')
  for (const file of ctx.args) {
    const show = progressLine(ctx)
    const item = await ctx.sdk().media.upload(file, {
      ...(caption ? { caption } : {}),
      onProgress: (p) => {
        if (!ctx.json)
          show(`${file}: ${p.phase}${p.phase === 'uploading' ? ` ${mb(p.sent)} / ${mb(p.total)}` : ''}`)
      },
    })
    items.push(item)
  }
  return {
    json: { items: items.map((m) => ({ id: m.id, status: m.status, kind: m.kind, filename: m.filename })) },
    text: items.map((m) => `${m.id}  ${m.kind}  ${m.filename}`).join('\n'),
  }
}

const mediaList: Handler = async (ctx) => {
  const kind = typeof ctx.flags.kind === 'string' ? ctx.flags.kind : undefined
  const q = typeof ctx.flags.search === 'string' ? ctx.flags.search : undefined
  const items: Media[] = []
  const va = ctx.sdk()
  for await (const m of va.listAll(va.media.list, {
    ...(kind ? { kind: kind as Media['kind'] } : {}),
    ...(q ? { q } : {}),
  }))
    items.push(m)
  return {
    json: { items },
    text: items.length
      ? items
          .map((m) => `${m.id}  ${m.kind.padEnd(5)}  ${m.status.padEnd(9)}  ${m.title ?? m.filename}`)
          .join('\n')
      : 'No media.',
  }
}

const mediaGet: Handler = async (ctx) => {
  const m = await ctx.sdk().media.get(arg(ctx, 0, 'id'))
  return {
    json: m,
    text: [
      `${m.title ?? m.filename} (${m.id})`,
      `  ${m.kind}, ${m.status}${m.rejectReason ? `: ${m.rejectReason}` : ''}`,
      ...(m.caption ? [`  ${m.caption}`] : []),
    ].join('\n'),
  }
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

/** Any route, through the SDK's raw client: auth, retries and errors included (like gh api). */
const api: Handler = async (ctx) => {
  const method = arg(ctx, 0, 'method').toUpperCase()
  const path = arg(ctx, 1, 'path')
  if (!(METHODS as readonly string[]).includes(method))
    throw new UsageError(`The method is one of ${METHODS.join(', ')}.`)
  if (!path.startsWith('/')) throw new UsageError('The path starts with /, e.g. /api/v1/stats.')
  const data = ctx.flags.data
  let body: string | undefined
  if (typeof data === 'string') {
    body = data.startsWith('@') ? await readFile(data.slice(1), 'utf8') : data
    try {
      JSON.parse(body)
    } catch {
      throw new UsageError('--data must be JSON (or @file with JSON in it).')
    }
  }
  const res = await ctx.sdk().send({
    method,
    url: path,
    ...(body !== undefined ? { body, headers: { 'content-type': 'application/json' } } : {}),
  })
  const text = await res.text()
  let json: unknown
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { status: res.status, body: text }
  }
  return {
    json: json ?? { status: res.status },
    text: text ? JSON.stringify(json, null, 2) : `HTTP ${res.status}`,
  }
}

const keysList: Handler = async (ctx) => {
  const keys = await ctx.sdk().keys.list()
  return {
    json: { items: keys },
    text: keys.length
      ? keys.map((k) => `${k.id}  ${k.name}${k.lastUsedAt ? `  last used ${k.lastUsedAt}` : ''}`).join('\n')
      : 'No keys.',
  }
}

const keysRevoke: Handler = async (ctx) => {
  const id = arg(ctx, 0, 'id')
  await ctx.sdk().keys.revoke(id)
  return { json: { id, revoked: true }, text: `Revoked ${id}.` }
}

/** There's no API for this on purpose: keys are made from a signed-in session (or by login). */
const keysCreate: Handler = async (ctx) => {
  const site = ctx.connection.url ?? '<your deployment>'
  throw new CliError(
    'keys_create_unavailable',
    `Keys are made in the browser: open ${site}/keys, or run: video-agent login --url ${site}`,
    EXIT.usage,
  )
}

export const LIBRARY_COMMANDS: Record<string, Handler> = {
  'media upload': mediaUpload,
  'media list': mediaList,
  'media get': mediaGet,
  api,
  'keys list': keysList,
  'keys revoke': keysRevoke,
  'keys create': keysCreate,
}
