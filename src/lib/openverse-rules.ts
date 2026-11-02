// The Openverse rules both paths enforce: the server's search and import (src/domain/openverse.ts) and the run's own
// helper (scripts/openverse.ts). Only CC0 and CC BY works, never mature ones; a file only when it is https, of a type
// the audio classifier takes and within the size cap. Also the strict reader for the credits a run records
// (video/assets/music/credits.json), which finalize stores on the version. No I/O here.
import { LIMITS } from './media/classify.js'

/** The only licences used: free for commercial use and edits. CC BY needs a credit; CC0 doesn't. */
export const IMPORT_LICENSES = ['cc0', 'by'] as const
export type ImportLicense = (typeof IMPORT_LICENSES)[number]

export const isImportLicense = (l: string | null | undefined): l is ImportLicense =>
  (IMPORT_LICENSES as readonly string[]).includes(l ?? '')

/** "CC BY 4.0", "CC0 1.0", or the slug in capitals for anything else. */
export function licenseLabel(license: string | null, version: string | null): string {
  if (!license) return ''
  const v = version ? ` ${version}` : ''
  if (license === 'cc0') return `CC0${v || ' 1.0'}`
  if (license === 'pdm') return 'Public Domain Mark'
  return `CC ${license.toUpperCase()}${v}`
}

/** An http(s) URL as given, or null: anything else never becomes a link. */
export function safeUrl(u: string | null | undefined): string | null {
  if (!u) return null
  try {
    const url = new URL(u)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

export const OPENVERSE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// File types the audio classifier takes; anything else (FLAC, AIFF) isn't offered.
const IMPORTABLE_TYPES = new Set(['mp3', 'mpeg', 'ogg', 'oga', 'opus', 'wav', 'm4a'])
/** Provider-specific names for the same formats: Jamendo labels its MP3s by bitrate (mp31, mp32). */
const TYPE_ALIASES: Record<string, string> = { mp31: 'mp3', mp32: 'mp3' }

export interface RawFile {
  url?: string | null
  filetype?: string | null
  filesize?: number | null
}
export interface RawAudio extends RawFile {
  id?: string
  title?: string | null
  creator?: string | null
  creator_url?: string | null
  license?: string
  license_version?: string | null
  license_url?: string | null
  foreign_landing_url?: string | null
  attribution?: string | null
  provider?: string | null
  source?: string | null
  category?: string | null
  genres?: string[] | null
  tags?: ({ name?: string | null } | null)[] | null
  duration?: number | null
  mature?: boolean
  alt_files?: RawFile[] | null
}

export interface OpenverseTrack {
  id: string
  title: string
  creator: string | null
  creatorUrl: string | null
  durationSec: number | null
  license: ImportLicense
  licenseVersion: string | null
  licenseLabel: string
  licenseUrl: string | null
  attribution: string | null
  landingUrl: string | null
  source: string | null
  category: string | null
  genres: string[]
  /** The file to listen to before importing (https only), straight from the provider. */
  previewUrl: string | null
  filetype: string | null
  filesize: number | null
  /** False when no file is one the library can take (type, size or length). */
  importable: boolean
}

/**
 * The first file of an item that can be used: the main file, else an alternative (smaller or another type). Files
 * over `maxBytes` (by their declared size) are skipped.
 */
export function pickFile(
  a: RawAudio,
  maxBytes: number = LIMITS.audioBytes,
): { url: string; filetype: string | null; filesize: number | null } | null {
  const files: RawFile[] = [a, ...(Array.isArray(a.alt_files) ? a.alt_files : [])]
  for (const [i, f] of files.entries()) {
    const url = safeUrl(f.url)
    if (!url?.startsWith('https:')) continue
    const raw = f.filetype?.toLowerCase() ?? null
    const type = raw ? (TYPE_ALIASES[raw] ?? raw) : null
    // An unknown type is only tried for the main file; the bytes decide.
    if (type ? !IMPORTABLE_TYPES.has(type) : i > 0) continue
    const size = typeof f.filesize === 'number' && f.filesize > 0 ? f.filesize : null
    if (size !== null && size > maxBytes) continue
    return { url, filetype: type, filesize: size }
  }
  return null
}

export const cleanText = (v: unknown, max = 300) =>
  typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, max) : null

/** A normalized track, or null for anything outside CC0 and CC BY (or marked mature, or malformed). One argument, so
 * it can be passed to map(). */
export const normalizeTrack = (a: RawAudio): OpenverseTrack | null =>
  normalizeTrackWithin(a, LIMITS.audioBytes)

/** normalizeTrack with a smaller file cap: `importable` and the file are judged against `maxBytes`. */
export function normalizeTrackWithin(a: RawAudio, maxBytes: number): OpenverseTrack | null {
  const license = a.license?.toLowerCase()
  if (!a.id || !OPENVERSE_ID.test(a.id) || !isImportLicense(license) || a.mature === true) return null
  const durationSec = typeof a.duration === 'number' && a.duration > 0 ? a.duration / 1000 : null
  const file = pickFile(a, maxBytes)
  const preview = safeUrl(a.url)
  return {
    id: a.id.toLowerCase(),
    title: cleanText(a.title, 200) ?? 'Untitled',
    creator: cleanText(a.creator, 200),
    creatorUrl: safeUrl(a.creator_url),
    durationSec,
    license,
    licenseVersion: cleanText(a.license_version, 25),
    licenseLabel: licenseLabel(license, cleanText(a.license_version, 25)),
    licenseUrl: safeUrl(a.license_url),
    attribution: cleanText(a.attribution, 1000),
    landingUrl: safeUrl(a.foreign_landing_url),
    source: cleanText(a.source, 80) ?? cleanText(a.provider, 80),
    category: cleanText(a.category, 80),
    genres: Array.isArray(a.genres) ? a.genres.flatMap((g) => cleanText(g, 80) ?? []).slice(0, 5) : [],
    previewUrl: preview?.startsWith('https:') ? preview : null,
    filetype: file?.filetype ?? cleanText(a.filetype, 20),
    filesize: file?.filesize ?? null,
    importable: file !== null && (durationSec === null || durationSec <= LIMITS.audioSeconds + 0.5),
  }
}

// ───────── credits a run records for the music and effects it fetched itself ─────────

/** Where a run's helper records its credits, relative to video/. */
export const RUN_CREDITS_FILE = 'assets/music/credits.json'
export const MAX_RUN_CREDITS = 20
const MAX_RUN_CREDITS_BYTES = 64 * 1024

/** One entry of video/assets/music/credits.json: a file the run fetched from Openverse and its licence. */
export interface RunCredit {
  /** The file, relative to video/ (assets/music/… or assets/sfx/…). */
  file: string
  openverseId: string
  title: string
  creator: string | null
  creatorUrl: string | null
  license: ImportLicense
  licenseVersion: string | null
  licenseUrl: string | null
  sourceUrl: string | null
  attribution: string | null
}

/** A file the helper writes: an audio file directly in assets/music/ or assets/sfx/. */
export const RUN_AUDIO_FILE = /^assets\/(?:music|sfx)\/[a-z0-9][a-z0-9._-]{0,79}\.(?:mp3|m4a|wav|ogg)$/

const bounded = (v: unknown, max: number): string | null | undefined => {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string' || v.length > max) return undefined
  return v.trim().replace(/\s+/g, ' ') || null
}
const url = (v: unknown): string | null | undefined => {
  const s = bounded(v, 2000)
  if (s === undefined) return undefined
  if (s === null) return null
  return safeUrl(s) ?? undefined
}

/** One entry, checked strictly: null when anything is missing, too long, outside CC0/CC BY or not an http(s) link. */
export function parseRunCredit(v: unknown): RunCredit | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const e = v as Record<string, unknown>
  const license = typeof e.license === 'string' ? e.license.toLowerCase() : null
  if (typeof e.file !== 'string' || !RUN_AUDIO_FILE.test(e.file)) return null
  if (typeof e.openverseId !== 'string' || !OPENVERSE_ID.test(e.openverseId)) return null
  if (!isImportLicense(license)) return null
  const title = bounded(e.title, 200)
  const creator = bounded(e.creator, 200)
  const licenseVersion = bounded(e.licenseVersion, 25)
  const attribution = bounded(e.attribution, 1000)
  const creatorUrl = url(e.creatorUrl)
  const licenseUrl = url(e.licenseUrl)
  const sourceUrl = url(e.sourceUrl)
  if (!title || creator === undefined || attribution === undefined) return null
  if (licenseVersion === undefined || (licenseVersion !== null && !/^[0-9][0-9.]{0,9}$/.test(licenseVersion)))
    return null
  if (creatorUrl === undefined || licenseUrl === undefined || sourceUrl === undefined) return null
  return {
    file: e.file,
    openverseId: e.openverseId.toLowerCase(),
    title,
    creator,
    creatorUrl,
    license,
    licenseVersion,
    licenseUrl,
    sourceUrl,
    attribution,
  }
}

/**
 * The credits a run recorded, from the text of credits.json and the composition's files: at most 20 entries, each
 * valid, for a file the composition has and an <audio> in one of its HTML files plays, one per Openverse id. Returns
 * the kept entries and how many were dropped; a file that isn't a JSON array (or is too long) keeps none.
 */
export function readRunCredits(
  json: string,
  files: ReadonlyMap<string, Uint8Array>,
): { credits: RunCredit[]; dropped: number } {
  let raw: unknown
  if (json.length > MAX_RUN_CREDITS_BYTES) return { credits: [], dropped: 1 }
  try {
    raw = JSON.parse(json)
  } catch {
    return { credits: [], dropped: 1 }
  }
  if (!Array.isArray(raw) || raw.length > MAX_RUN_CREDITS) return { credits: [], dropped: 1 }
  const played = audioSources(files)
  const credits: RunCredit[] = []
  for (const entry of raw) {
    const c = parseRunCredit(entry)
    if (!c || !files.has(c.file) || !played.has(c.file)) continue
    if (credits.some((x) => x.openverseId === c.openverseId)) continue
    credits.push(c)
  }
  return { credits, dropped: raw.length - credits.length }
}

/** The local files <audio src> (or a <source> inside one) points at, in every HTML file of the composition. */
function audioSources(files: ReadonlyMap<string, Uint8Array>): Set<string> {
  const out = new Set<string>()
  for (const [path, bytes] of files) {
    if (!path.endsWith('.html')) continue
    const html = new TextDecoder().decode(bytes)
    for (const m of html.matchAll(/<audio\b[^>]*>(?:[\s\S]*?<\/audio>)?/gi)) {
      for (const s of m[0].matchAll(/\ssrc\s*=\s*["']([^"']+)["']/gi)) {
        const src = (s[1] ?? '').trim().replace(/^\.\//, '').split(/[?#]/)[0] ?? ''
        try {
          out.add(decodeURI(src))
        } catch {
          // A malformed escape never matches a file.
        }
      }
    }
  }
  return out
}
