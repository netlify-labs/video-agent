// A minimal zip writer for small text packages (agent skills). Entries are stored, not deflated, with one fixed
// timestamp and in sorted order, so the same files give the same bytes on any machine, timezone or zlib build.
import { crc32 } from 'node:zlib'

export interface ZipEntry {
  path: string
  data: Buffer
}

// 2026-01-01 00:00:00 in MS-DOS date and time fields. Zip times have no timezone, so a constant is the same everywhere.
const DOS_TIME = 0
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1
// Version 2.0, and bit 11: names are UTF-8.
const VERSION = 20
const UTF8 = 0x0800

export function zip(entries: ZipEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of sorted) {
    const name = Buffer.from(e.path, 'utf8')
    const crc = crc32(e.data)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(VERSION, 4)
    head.writeUInt16LE(UTF8, 6)
    head.writeUInt16LE(0, 8) // stored
    head.writeUInt16LE(DOS_TIME, 10)
    head.writeUInt16LE(DOS_DATE, 12)
    head.writeUInt32LE(crc, 14)
    head.writeUInt32LE(e.data.length, 18)
    head.writeUInt32LE(e.data.length, 22)
    head.writeUInt16LE(name.length, 26)
    head.writeUInt16LE(0, 28)
    local.push(head, name, e.data)

    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE((3 << 8) | VERSION, 4) // made by Unix, so the mode below applies
    dir.writeUInt16LE(VERSION, 6)
    dir.writeUInt16LE(UTF8, 8)
    dir.writeUInt16LE(0, 10)
    dir.writeUInt16LE(DOS_TIME, 12)
    dir.writeUInt16LE(DOS_DATE, 14)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(e.data.length, 20)
    dir.writeUInt32LE(e.data.length, 24)
    dir.writeUInt16LE(name.length, 28)
    dir.writeUInt32LE((0o100644 << 16) >>> 0, 38) // a regular file, rw-r--r--
    dir.writeUInt32LE(offset, 42)
    central.push(dir, name)
    offset += head.length + name.length + e.data.length
  }
  const dirBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(sorted.length, 8)
  end.writeUInt16LE(sorted.length, 10)
  end.writeUInt32LE(dirBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, dirBytes, end])
}
