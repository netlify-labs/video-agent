// Openverse music and sound effects for a run, when no library track was picked and the brand has no music. From the
// repo root:
//   npx tsx scripts/openverse.ts search "<query>" [--category music|sound_effect] [--min-seconds N] [--max-seconds N]
//     Prints a compact JSON list of CC0 and CC BY candidates (id, title, creator, seconds, licence, genres, tags).
//   npx tsx scripts/openverse.ts fetch <openverse id> [--name <file-slug>]
//     Re-reads the item by id, checks its licence again, downloads its file (https only, at most 3 redirects, 10 MB)
//     and checks the bytes are audio, saves it to video/assets/music/<slug>.<ext> (sound effects: video/assets/sfx/)
//     and records its credit in video/assets/music/credits.json, which finalize reads to credit CC BY works.
// The licence rules are the server's (src/lib/openverse-rules.ts): only CC0 and CC BY, never NC, ND, SA or mature.
// Uses OPENVERSE_CLIENT_ID and OPENVERSE_CLIENT_SECRET when the run has them (a registered app's rate limits), else
// searches anonymously. Never prints them or the token.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { classify, LIMITS, MediaError } from '../src/lib/media/classify.js'
import { readCapped } from '../src/lib/media/range.js'
import {
  isImportLicense,
  licenseLabel,
  MAX_RUN_CREDITS,
  normalizeTrackWithin,
  OPENVERSE_ID,
  parseRunCredit,
  pickFile,
  RUN_CREDITS_FILE,
  type RawAudio,
  type RunCredit,
} from '../src/lib/openverse-rules.js'
import { BUNDLE_LIMITS } from '../src/lib/tar.js'
import { StepError, exitOnError, log, parseArgs, repoRoot } from './lib/run-tools.js'

export const OPENVERSE_API = 'https://api.openverse.org/v1'
const USER_AGENT = 'VideoAgent/1.0 (Netlify video agent template; music for a video run)'
const API_TIMEOUT_MS = 60_000
const DOWNLOAD_TIMEOUT_MS = 120_000
const ATTEMPTS = 4
const MAX_REDIRECTS = 3
const MAX_WAIT_MS = 60_000
/**
 * A fetched file is part of the composition, so it must fit the preview bundle's per-file limit (10 MB, below the
 * library's 50 MB audio cap); a larger file would leave the version without a preview or the editor.
 */
export const RUN_MAX_BYTES = Math.min(BUNDLE_LIMITS.maxFileBytes, LIMITS.audioBytes)
export const CATEGORIES = ['music', 'sound_effect'] as const
export type Category = (typeof CATEGORIES)[number]

export interface Io {
  fetch: typeof fetch
  env: Record<string, string | undefined>
  sleep: (ms: number) => Promise<void>
}

const defaultIo = (): Io => ({
  fetch: globalThis.fetch,
  env: process.env,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
})

/** One request, retried with backoff on timeouts, network errors, 5xx and 429 (honouring Retry-After, capped). */
async function send(io: Io, url: string, init: RequestInit, what: string, timeoutMs: number) {
  let last = ''
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let wait = 2000 * 2 ** (attempt - 1)
    try {
      const res = await io.fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
      if (res.status !== 429 && res.status < 500) return res
      last = `HTTP ${res.status}`
      const after = Number(res.headers.get('retry-after'))
      if (res.status === 429 && after > 0) wait = Math.min(after * 1000, MAX_WAIT_MS)
      await res.body?.cancel()
    } catch (e) {
      last = e instanceof Error ? e.message.slice(0, 200) : String(e)
    }
    log('openverse.retry', { what, attempt, error: last })
    if (attempt < ATTEMPTS) await io.sleep(wait)
  }
  throw new StepError(`Openverse didn't answer (${what}: ${last}). Try again in a minute.`)
}

/** The Openverse API as this run sees it: a registered app's token when the run has credentials, else anonymous. */
export class Openverse {
  private token: string | null | undefined

  constructor(private readonly io: Io = defaultIo()) {}

  /** A bearer token, fetched once; null (anonymous) without credentials or when Openverse refuses them. */
  private async bearer(): Promise<string | null> {
    if (this.token !== undefined) return this.token
    const id = this.io.env.OPENVERSE_CLIENT_ID
    const secret = this.io.env.OPENVERSE_CLIENT_SECRET
    if (!id || !secret) return (this.token = null)
    const res = await send(
      this.io,
      `${OPENVERSE_API}/auth_tokens/token/`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: id,
          client_secret: secret,
        }).toString(),
      },
      'token',
      API_TIMEOUT_MS,
    )
    const body = (await res.json().catch(() => null)) as { access_token?: unknown } | null
    if (!res.ok || typeof body?.access_token !== 'string') {
      // Bad credentials shouldn't stop the video: search anonymously.
      log('openverse.token_failed', { status: res.status })
      return (this.token = null)
    }
    log('openverse.registered')
    return (this.token = body.access_token)
  }

  /** GET one API path as JSON. */
  async get(path: string): Promise<unknown> {
    const go = async (auth: string | null) =>
      send(
        this.io,
        `${OPENVERSE_API}${path}`,
        {
          headers: {
            accept: 'application/json',
            'user-agent': USER_AGENT,
            ...(auth ? { authorization: `Bearer ${auth}` } : {}),
          },
        },
        path.split('?')[0] ?? path,
        API_TIMEOUT_MS,
      )
    const auth = await this.bearer()
    let res = await go(auth)
    // A token Openverse no longer takes: carry on anonymously.
    if (res.status === 401 && auth) {
      await res.body?.cancel()
      this.token = null
      res = await go(null)
    }
    if (res.status === 404) throw new StepError("That item isn't on Openverse (any more). Pick another one.")
    if (!res.ok) throw new StepError(`Openverse answered HTTP ${res.status}. Try again in a minute.`)
    const body: unknown = await res.json().catch(() => null)
    if (!body || typeof body !== 'object') throw new StepError('Openverse sent something unexpected.')
    return body
  }

  /** Downloads a file: https only, at most 3 redirects, a size cap and a deadline per request. */
  async download(start: string, maxBytes = RUN_MAX_BYTES): Promise<Uint8Array> {
    let url = start
    for (let hop = 0; ; hop++) {
      if (!url.startsWith('https://')) throw new StepError("The item's file isn't served over HTTPS.")
      const res = await send(
        this.io,
        url,
        { headers: { 'user-agent': USER_AGENT, accept: 'audio/*,*/*;q=0.5' } },
        'download',
        DOWNLOAD_TIMEOUT_MS,
      )
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel()
        const next = res.headers.get('location')
        if (!next || hop >= MAX_REDIRECTS) throw new StepError("The item's file redirects too many times.")
        url = new URL(next, url).toString()
        continue
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel()
        throw new StepError(`The item's file couldn't be downloaded (HTTP ${res.status}).`)
      }
      const tooBig = () =>
        new StepError(`The item's file is over ${maxBytes / 1024 / 1024} MB. Pick a shorter or smaller one.`)
      if (Number(res.headers.get('content-length') ?? 0) > maxBytes) {
        await res.body.cancel()
        throw tooBig()
      }
      return readCapped(res.body as ReadableStream<Uint8Array>, maxBytes, tooBig)
    }
  }
}

export interface Candidate {
  id: string
  title: string
  creator: string | null
  seconds: number | null
  license: string
  creditNeeded: boolean
  genres: string[]
  tags: string[]
  source: string | null
}

/** CC0 and CC BY items matching the query that can be fetched, in Openverse's order. */
export async function search(
  ov: Openverse,
  query: string,
  opts: { category?: Category; minSeconds?: number | undefined; maxSeconds?: number | undefined } = {},
): Promise<Candidate[]> {
  const q = query.trim().replace(/\s+/g, ' ').slice(0, 200)
  if (!q) throw new StepError('Give a search query, e.g. search "calm piano".')
  const params = new URLSearchParams({
    q,
    license: 'cc0,by',
    category: opts.category ?? 'music',
    mature: 'false',
    page_size: '20',
  })
  const body = (await ov.get(`/audio/?${params.toString()}`)) as { results?: RawAudio[] }
  const out: Candidate[] = []
  // Filter again here: whatever Openverse sends, nothing outside CC0 and CC BY is offered.
  for (const raw of Array.isArray(body.results) ? body.results : []) {
    const t = normalizeTrackWithin(raw, RUN_MAX_BYTES)
    if (!t?.importable) continue
    const s = t.durationSec
    if (s !== null && opts.minSeconds !== undefined && s < opts.minSeconds) continue
    if (s !== null && opts.maxSeconds !== undefined && s > opts.maxSeconds) continue
    out.push({
      id: t.id,
      title: t.title,
      creator: t.creator,
      seconds: s === null ? null : Math.round(s * 10) / 10,
      license: t.licenseLabel,
      creditNeeded: t.license === 'by',
      genres: t.genres,
      tags: (Array.isArray(raw.tags) ? raw.tags : [])
        .flatMap((x) => (typeof x?.name === 'string' && x.name.trim() ? [x.name.trim().slice(0, 40)] : []))
        .slice(0, 6),
      source: t.source,
    })
  }
  return out
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')

/** The credits recorded so far (entries that don't check out are dropped when the file is rewritten). */
export function readCredits(videoDir: string): RunCredit[] {
  const path = join(videoDir, RUN_CREDITS_FILE)
  if (!existsSync(path)) return []
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return Array.isArray(raw) ? raw.flatMap((e) => parseRunCredit(e) ?? []) : []
  } catch {
    return []
  }
}

/** Downloads one Openverse item into video/ and records its credit. Fetching an item already there reuses it. */
export async function fetchItem(
  ov: Openverse,
  rawId: string,
  opts: { name?: string; videoDir: string },
): Promise<{ credit: RunCredit; seconds: number | null; reused: boolean }> {
  const id = rawId.trim().toLowerCase()
  if (!OPENVERSE_ID.test(id)) throw new StepError('Pass an Openverse id from search (a UUID).')
  const credits = readCredits(opts.videoDir)
  const had = credits.find((c) => c.openverseId === id)
  if (had && existsSync(join(opts.videoDir, had.file))) return { credit: had, seconds: null, reused: true }

  // Re-read the item by id: its licence and file come from Openverse, never from the search output.
  const raw = (await ov.get(`/audio/${id}/`)) as RawAudio
  const license = raw.license?.toLowerCase()
  if (!isImportLicense(license))
    throw new StepError(
      `Only CC0 and CC BY items can be used (this one is ${licenseLabel(license ?? null, raw.license_version ?? null) || 'unlicensed'}). Pick another one.`,
    )
  const track = normalizeTrackWithin(raw, RUN_MAX_BYTES)
  if (!track || track.id !== id) throw new StepError("This item can't be used (mature or malformed).")
  if (!track.importable)
    throw new StepError(
      'This item has no file that can be used (MP3, M4A, WAV or Ogg up to 10 MB and 10 minutes). Pick another one.',
    )
  const file = pickFile(raw, RUN_MAX_BYTES)
  if (!file) throw new StepError('This item has no file that can be used. Pick another one.')
  const bytes = await ov.download(file.url)
  let c
  try {
    c = classify(bytes)
  } catch (e) {
    throw new StepError(e instanceof MediaError ? e.message : "The item's file couldn't be read as audio.")
  }
  if (c.kind !== 'audio') throw new StepError("The item's file isn't audio (MP3, M4A, WAV or Ogg).")

  const folder = track.category === 'sound_effect' ? 'assets/sfx' : 'assets/music'
  const base = slugify(opts.name ?? '') || slugify(track.title) || 'track'
  let rel = `${folder}/${base}.${c.ext}`
  // Never overwrite another item's file.
  if (existsSync(join(opts.videoDir, rel)) && !credits.some((x) => x.file === rel && x.openverseId === id))
    rel = `${folder}/${base}-${id.slice(0, 8)}.${c.ext}`
  const credit: RunCredit = {
    file: rel,
    openverseId: id,
    title: track.title,
    creator: track.creator,
    creatorUrl: track.creatorUrl,
    license: track.license,
    licenseVersion: track.licenseVersion,
    licenseUrl: track.licenseUrl,
    sourceUrl: track.landingUrl,
    attribution: track.attribution,
  }
  const kept = credits.filter((x) => x.openverseId !== id && x.file !== rel)
  if (kept.length >= MAX_RUN_CREDITS)
    throw new StepError(
      `video/${RUN_CREDITS_FILE} already lists ${MAX_RUN_CREDITS} files. Remove the ones the video doesn't use.`,
    )
  mkdirSync(join(opts.videoDir, folder), { recursive: true })
  writeFileSync(join(opts.videoDir, rel), bytes)
  mkdirSync(join(opts.videoDir, 'assets', 'music'), { recursive: true })
  writeFileSync(join(opts.videoDir, RUN_CREDITS_FILE), `${JSON.stringify([...kept, credit], null, 2)}\n`)
  log('openverse.fetched', { id, file: rel, bytes: bytes.byteLength, license: track.license })
  return { credit, seconds: c.durationSec ?? track.durationSec, reused: false }
}

const seconds = (v: string | undefined, flag: string) => {
  if (v === undefined) return undefined
  const n = Number(v)
  if (!(n >= 0)) throw new StepError(`${flag} must be a number of seconds.`)
  return n
}

async function main() {
  const [cmd, arg] = process.argv.slice(2)
  const args = parseArgs(process.argv.slice(3))
  const ov = new Openverse()
  if (cmd === 'search' && arg && !arg.startsWith('--')) {
    const category = (args.category ?? 'music') as Category
    if (!CATEGORIES.includes(category)) throw new StepError('--category must be music or sound_effect.')
    const found = await search(ov, arg, {
      category,
      minSeconds: seconds(args['min-seconds'], '--min-seconds'),
      maxSeconds: seconds(args['max-seconds'], '--max-seconds'),
    })
    console.log(found.length ? `[\n${found.map((c) => JSON.stringify(c)).join(',\n')}\n]` : '[]')
    if (!found.length) console.error('Nothing matched. Try a broader query, or fewer length limits.')
    return
  }
  if (cmd === 'fetch' && arg && !arg.startsWith('--')) {
    const r = await fetchItem(ov, arg, {
      videoDir: join(repoRoot, 'video'),
      ...(args.name ? { name: args.name } : {}),
    })
    const c = r.credit
    const label = licenseLabel(c.license, c.licenseVersion)
    console.log(
      `${r.reused ? 'Already here' : 'Saved'}: video/${c.file} ("${c.title}"${c.creator ? ` by ${c.creator}` : ''}, ${label}${r.seconds ? `, ${r.seconds.toFixed(1)} s` : ''}). Use it as src="${c.file}".`,
    )
    console.log(
      c.license === 'by'
        ? `Its credit is in video/${RUN_CREDITS_FILE}: keep that file. The app credits it under the video and on its share page.`
        : `CC0 needs no credit; it is still recorded in video/${RUN_CREDITS_FILE}. Keep that file.`,
    )
    return
  }
  throw new StepError(
    'Usage: openverse.ts search "<query>" [--category music|sound_effect] [--min-seconds N] [--max-seconds N] | fetch <openverse id> [--name <file-slug>]',
  )
}

if (process.argv[1]?.endsWith('openverse.ts')) main().catch(exitOnError('openverse failed: '))
