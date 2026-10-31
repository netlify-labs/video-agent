// Builds .tar.gz archives for tests, including hostile ones (traversal, links, bombs) that real tar won't make.
import { gzipSync } from 'node:zlib'

export interface Entry {
  name: string
  body?: Uint8Array | string
  /** '0' file (default), '5' directory, '2' symlink, '1' hard link, 'L' GNU long name, 'x' pax header */
  type?: string
  linkname?: string
}

function header(name: string, size: number, type: string, linkname = '') {
  const h = Buffer.alloc(512)
  h.write(name.slice(0, 100), 0, 'utf8')
  h.write('0000644\0', 100)
  h.write('0000000\0', 108)
  h.write('0000000\0', 116)
  h.write(size.toString(8).padStart(11, '0') + '\0', 124)
  h.write('00000000000\0', 136)
  h.write('        ', 148)
  h.write(type, 156)
  h.write(linkname.slice(0, 100), 157)
  h.write('ustar\0', 257)
  h.write('00', 263)
  let sum = 0
  for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return h
}

export function tarGz(entries: Entry[]): Uint8Array {
  const parts: Buffer[] = []
  for (const e of entries) {
    const body = Buffer.from(e.body ?? '')
    parts.push(header(e.name, body.length, e.type ?? '0', e.linkname))
    parts.push(body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  parts.push(Buffer.alloc(1024))
  return new Uint8Array(gzipSync(Buffer.concat(parts)))
}
