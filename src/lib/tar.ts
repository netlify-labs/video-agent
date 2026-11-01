// A strict reader for the composition archives runs make (`tar -czf … video`), for preview bundles (plan v2 §7).
// Only regular files and directories are accepted; links, devices and anything unusual stop extraction. Paths must
// stay inside video/, and entry count and expanded size are capped, so a hostile archive can't escape or explode.
import { gunzipSync, gzipSync } from 'node:zlib'

export interface TarLimits {
  maxEntries: number
  maxTotalBytes: number
  maxFileBytes: number
}

export const BUNDLE_LIMITS: TarLimits = {
  maxEntries: 2000,
  maxTotalBytes: 50 * 1024 * 1024,
  maxFileBytes: 10 * 1024 * 1024,
}

export class TarError extends Error {}

/** `video/a/b.css` → `a/b.css`; null for the video/ directory itself. Throws on anything outside video/. */
export function bundlePath(raw: string): string | null {
  const p = raw.replace(/^\.\//, '')
  if (p === 'video' || p === 'video/') return null
  if (!p.startsWith('video/')) throw new TarError(`Entry outside video/: ${raw.slice(0, 120)}`)
  const rest = p.slice('video/'.length).replace(/\/$/, '')
  const parts = rest.split('/')
  if (
    !rest ||
    rest.includes('\\') ||
    rest.includes('\0') ||
    parts.some((s) => s === '' || s === '.' || s === '..')
  )
    throw new TarError(`Unsafe path: ${raw.slice(0, 120)}`)
  return rest
}

const text = (b: Uint8Array) => {
  const end = b.indexOf(0)
  return new TextDecoder().decode(end >= 0 ? b.subarray(0, end) : b)
}
const octal = (b: Uint8Array) => {
  const s = text(b).trim()
  if (!/^[0-7]*$/.test(s)) throw new TarError('Bad size field.')
  return s ? parseInt(s, 8) : 0
}

/** Regular files of the archive, keyed by path relative to video/. */
export function readTarGz(gz: Uint8Array, limits: TarLimits = BUNDLE_LIMITS): Map<string, Uint8Array> {
  let buf: Uint8Array
  try {
    buf = gunzipSync(gz, { maxOutputLength: limits.maxTotalBytes + 1024 * 1024 })
  } catch (e) {
    throw new TarError(`Not a readable .tar.gz (${e instanceof Error ? e.message : String(e)}).`)
  }
  const files = new Map<string, Uint8Array>()
  let off = 0
  let entries = 0
  let total = 0
  let longName: string | null = null
  let paxPath: string | null = null
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512)
    if (h.every((x) => x === 0)) break
    const size = octal(h.subarray(124, 136))
    const type = String.fromCharCode(h[156] ?? 0)
    const prefix = text(h.subarray(345, 500))
    const name = text(h.subarray(0, 100))
    const body = buf.subarray(off + 512, off + 512 + size)
    if (body.length < size) throw new TarError('Truncated archive.')
    off += 512 + Math.ceil(size / 512) * 512
    if (++entries > limits.maxEntries) throw new TarError(`More than ${limits.maxEntries} entries.`)
    if (type === 'L') {
      longName = text(body)
      continue
    }
    if (type === 'x') {
      // pax extended header: "len key=value\n" records; only path matters here.
      for (const rec of new TextDecoder().decode(body).split('\n')) {
        const m = /^\d+ path=(.*)$/.exec(rec)
        if (m?.[1] !== undefined) paxPath = m[1]
      }
      continue
    }
    if (type === 'g') continue
    const full = paxPath ?? longName ?? (prefix ? `${prefix}/${name}` : name)
    longName = null
    paxPath = null
    if (type === '5') {
      bundlePath(full)
      continue
    }
    if (type !== '0' && type !== '\0')
      throw new TarError(`Links and special files aren't allowed (${full.slice(0, 120)}).`)
    const path = bundlePath(full)
    if (path === null) continue
    if (size > limits.maxFileBytes) throw new TarError(`${path} is over ${limits.maxFileBytes} bytes.`)
    total += size
    if (total > limits.maxTotalBytes)
      throw new TarError(`Expands to more than ${limits.maxTotalBytes} bytes.`)
    files.set(path, body.slice())
  }
  return files
}

function header(name: string, size: number, type: '0' | 'L') {
  const h = Buffer.alloc(512)
  h.write(name.slice(0, 100), 0, 'utf8')
  h.write('0000644\0', 100)
  h.write('0000000\0', 108)
  h.write('0000000\0', 116)
  h.write(size.toString(8).padStart(11, '0') + '\0', 124)
  h.write('00000000000\0', 136)
  h.write('        ', 148)
  h.write(type, 156)
  h.write('ustar\0', 257)
  h.write('00', 263)
  let sum = 0
  for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return h
}

/** A .tar.gz of `files` under video/ (regular files; GNU long names past 100 bytes), as runs make with tar. */
export function writeTarGz(files: Map<string, Uint8Array>): Uint8Array {
  const parts: Buffer[] = []
  const pad = (n: number) => Buffer.alloc((512 - (n % 512)) % 512)
  for (const [path, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const name = `video/${path}`
    if (Buffer.byteLength(name) > 100) {
      const long = Buffer.from(`${name}\0`)
      parts.push(header('././@LongLink', long.length, 'L'), long, pad(long.length))
    }
    parts.push(header(name, bytes.byteLength, '0'), Buffer.from(bytes), pad(bytes.byteLength))
  }
  parts.push(Buffer.alloc(1024))
  return new Uint8Array(gzipSync(Buffer.concat(parts)))
}
