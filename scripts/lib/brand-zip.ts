// Fetching and unpacking a brand zip (BRAND_ZIP_URL) at build time, within limits: a hostile or broken URL can't hang
// the build, fill the disk or write outside its temp dir. Every refusal has a reason code; the URL is never logged.
// Shaped so another zip URL (Looks' LOOKS_ZIP_URL, docs/plans/2026-11-04-looks.md "Not in v1") can reuse it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'

export interface ZipLimits {
  timeoutMs: number
  /** The download, whatever content-length says. */
  maxBytes: number
  maxEntries: number
  /** All files unpacked, by the zip's own sizes and again on disk. */
  maxUnpackedBytes: number
}

export const BRAND_ZIP_LIMITS: ZipLimits = {
  timeoutMs: 30_000,
  maxBytes: 25 * 1024 * 1024,
  maxEntries: 500,
  maxUnpackedBytes: 100 * 1024 * 1024,
}

export type ZipRefusal =
  'timeout' | 'too_large' | 'too_many_entries' | 'unsafe_path' | 'bad_zip' | `http_${number}` | 'fetch_failed'

export class ZipError extends Error {
  constructor(
    readonly reason: ZipRefusal,
    message: string,
  ) {
    super(message)
  }
}

/** Downloads `url` to `to`, refusing a slow server, an error status or more than maxBytes. */
export async function fetchZip(url: string, to: string, limits: ZipLimits = BRAND_ZIP_LIMITS) {
  const signal = AbortSignal.timeout(limits.timeoutMs)
  try {
    const res = await fetch(url, { signal })
    if (!res.ok) throw new ZipError(`http_${res.status}`, `The server answered ${res.status}.`)
    const declared = Number(res.headers.get('content-length') ?? NaN)
    if (declared > limits.maxBytes) throw new ZipError('too_large', `The zip is ${declared} bytes.`)
    // The header can lie or be missing: count as it arrives.
    const chunks: Uint8Array[] = []
    let total = 0
    if (res.body)
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength
        if (total > limits.maxBytes)
          throw new ZipError('too_large', `The zip is over ${limits.maxBytes} bytes.`)
        chunks.push(chunk)
      }
    writeFileSync(to, Buffer.concat(chunks))
  } catch (e) {
    if (e instanceof ZipError) throw e
    if (signal.aborted) throw new ZipError('timeout', `No complete zip within ${limits.timeoutMs} ms.`)
    throw new ZipError('fetch_failed', `The download failed (${e instanceof Error ? e.name : 'error'}).`)
  }
}

export interface ZipEntryInfo {
  name: string
  /** As the zip declares it: a bomb can lie, so unpacking counts again. */
  size: number
  symlink: boolean
  method: number
  compressedSize: number
  /** Where the entry's local header starts. */
  localOffset: number
}

/** The zip's entries from its central directory (no zip64). Throws bad_zip for anything it can't read. */
export function zipEntries(buf: Buffer): ZipEntryInfo[] {
  // The end-of-central-directory record: 22 bytes plus a comment of up to 64 KB, at the end.
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  if (eocd < 0) throw new ZipError('bad_zip', "It isn't a zip file.")
  const count = buf.readUInt16LE(eocd + 10)
  const offset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || offset === 0xffffffff)
    throw new ZipError('too_large', 'Zip64 archives are not supported.')
  const entries: ZipEntryInfo[] = []
  let p = offset
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50)
      throw new ZipError('bad_zip', 'The zip directory is damaged.')
    const madeBy = buf.readUInt16LE(p + 4) >> 8
    const method = buf.readUInt16LE(p + 10)
    const compressedSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const mode = buf.readUInt32LE(p + 38) >>> 16
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    // Unix (3) and macOS (19) record the file mode in the high bits; 0o120000 is a symbolic link.
    const symlink = (madeBy === 3 || madeBy === 19) && (mode & 0o170000) === 0o120000
    entries.push({ name, size, symlink, method, compressedSize, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** Refuses too many entries, too much unpacked, absolute or `..` paths, and symbolic links. */
export function checkEntries(entries: ZipEntryInfo[], limits: ZipLimits = BRAND_ZIP_LIMITS) {
  if (entries.length > limits.maxEntries)
    throw new ZipError('too_many_entries', `The zip has ${entries.length} entries.`)
  for (const e of entries) {
    const parts = e.name.split(/[/\\]/)
    if (/^[/\\]/.test(e.name) || /^[a-z]:/i.test(e.name) || parts.includes('..') || e.name.includes('\0'))
      throw new ZipError('unsafe_path', 'The zip has an entry outside its folder.')
    if (e.symlink) throw new ZipError('unsafe_path', 'The zip has a symbolic link.')
  }
  const total = entries.reduce((t, e) => t + e.size, 0)
  if (total > limits.maxUnpackedBytes) throw new ZipError('too_large', `The zip unpacks to ${total} bytes.`)
}

/**
 * Unpacks checked entries into `out` (stored and deflated only). Inflating stops at the bytes left in the budget, so a
 * zip whose declared sizes lie (a bomb) never writes more than maxUnpackedBytes.
 */
export function unpackEntries(
  buf: Buffer,
  entries: ZipEntryInfo[],
  out: string,
  limits: ZipLimits = BRAND_ZIP_LIMITS,
) {
  const root = resolve(out)
  let left = limits.maxUnpackedBytes
  for (const e of entries) {
    const to = resolve(root, e.name)
    if (to !== root && !to.startsWith(root + sep))
      throw new ZipError('unsafe_path', 'The zip has an entry outside its folder.')
    if (e.name.endsWith('/')) {
      mkdirSync(to, { recursive: true })
      continue
    }
    const h = e.localOffset
    if (h + 30 > buf.length || buf.readUInt32LE(h) !== 0x04034b50)
      throw new ZipError('bad_zip', 'The zip has a damaged entry.')
    const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28)
    const raw = buf.subarray(start, start + e.compressedSize)
    let data: Buffer
    if (e.method === 0) data = raw
    else if (e.method === 8)
      try {
        data = inflateRawSync(raw, { maxOutputLength: left + 1 })
      } catch (err) {
        if (err instanceof RangeError) throw new ZipError('too_large', 'The zip unpacks to too much.')
        throw new ZipError('bad_zip', 'The zip has a damaged entry.')
      }
    else throw new ZipError('bad_zip', `The zip uses compression method ${e.method}.`)
    if (data.length > left) throw new ZipError('too_large', 'The zip unpacks to too much.')
    left -= data.length
    mkdirSync(dirname(to), { recursive: true })
    writeFileSync(to, data)
  }
}

/**
 * Downloads the zip into `dir` and unpacks it into `dir/x`, checking it at every step; returns a reader for files
 * inside it that refuses paths leaving it.
 */
export async function unpackZip(url: string, dir: string, limits: ZipLimits = BRAND_ZIP_LIMITS) {
  const zip = join(dir, 'download.zip')
  await fetchZip(url, zip, limits)
  const buf = readFileSync(zip)
  const entries = zipEntries(buf)
  checkEntries(entries, limits)
  const out = join(dir, 'x')
  unpackEntries(buf, entries, out, limits)
  const root = resolve(out)
  return (rel: string) => {
    const p = resolve(root, rel)
    if (!p.startsWith(root + sep)) throw new ZipError('unsafe_path', 'A path in the zip leaves its folder.')
    return readFileSync(p)
  }
}
