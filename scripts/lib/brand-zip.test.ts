// The brand zip within limits (scripts/lib/brand-zip.ts): slow servers, big bodies, unsafe entries and bombs are
// refused with a reason code, nothing lands outside the temp dir, and an honest brand zip unpacks as before.
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BRAND_ZIP_LIMITS, unpackZip, ZipError, type ZipLimits } from './brand-zip.js'
import { zip } from './zip.js'

interface Entry {
  name: string
  data?: Buffer
  deflate?: boolean
  symlink?: boolean
  /** What the directory claims the entry unpacks to (a bomb lies). */
  declared?: number
}

/** A zip with full control over each entry's method, mode and declared size. */
function makeZip(entries: Entry[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const data = e.data ?? Buffer.alloc(0)
    const body = e.deflate ? deflateRawSync(data) : data
    const name = Buffer.from(e.name, 'utf8')
    const size = e.declared ?? data.length
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(e.deflate ? 8 : 0, 8)
    head.writeUInt32LE(crc32(data), 14)
    head.writeUInt32LE(body.length, 18)
    head.writeUInt32LE(size, 22)
    head.writeUInt16LE(name.length, 26)
    local.push(head, name, body)
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE((3 << 8) | 20, 4)
    dir.writeUInt16LE(20, 6)
    dir.writeUInt16LE(e.deflate ? 8 : 0, 10)
    dir.writeUInt32LE(crc32(data), 16)
    dir.writeUInt32LE(body.length, 20)
    dir.writeUInt32LE(size, 24)
    dir.writeUInt16LE(name.length, 28)
    dir.writeUInt32LE(((e.symlink ? 0o120777 : 0o100644) << 16) >>> 0, 38)
    dir.writeUInt32LE(offset, 42)
    central.push(dir, name)
    offset += 30 + name.length + body.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, cd, end])
}

const BRAND = Buffer.from(JSON.stringify({ name: 'Acme', primaryColor: '#ff5500', logo: 'logo.svg' }))
const LOGO = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')

/** Routes: path → handler body. */
let server: Server
let base = ''
const routes = new Map<string, (res: import('node:http').ServerResponse) => void>()
beforeAll(async () => {
  server = createServer((req, res) => {
    const route = routes.get(req.url ?? '')
    if (route) route(res)
    else res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => {
  server.closeAllConnections()
  server.close()
})
const serve = (path: string, body: Buffer, headers: Record<string, string> = {}) => {
  routes.set(path, (res) => res.writeHead(200, { 'content-type': 'application/zip', ...headers }).end(body))
  return `${base}${path}`
}

const small: ZipLimits = {
  timeoutMs: 1500,
  maxBytes: 64 * 1024,
  maxEntries: 20,
  maxUnpackedBytes: 256 * 1024,
}
const refusal = async (url: string, limits = small) => {
  const dir = mkdtempSync(join(tmpdir(), 'brand-test-'))
  try {
    await unpackZip(url, dir, limits)
  } catch (e) {
    expect(e).toBeInstanceOf(ZipError)
    // Nothing outside the temp dir: only the download and (maybe) x/.
    expect(readdirSync(dir).every((f) => f === 'download.zip' || f === 'x')).toBe(true)
    return (e as ZipError).reason
  }
  throw new Error('expected a refusal')
}

describe('brand zip', () => {
  it('unpacks an honest brand zip, stored or deflated, and reads its files', async () => {
    for (const z of [
      zip([
        { path: 'brand.json', data: BRAND },
        { path: 'logo.svg', data: LOGO },
      ]),
      makeZip([
        { name: 'assets/', data: Buffer.alloc(0) },
        { name: 'brand.json', data: BRAND, deflate: true },
        { name: 'logo.svg', data: LOGO, deflate: true },
      ]),
    ]) {
      const dir = mkdtempSync(join(tmpdir(), 'brand-test-'))
      const file = await unpackZip(serve(`/ok-${z.length}.zip`, z), dir, small)
      expect(JSON.parse(file('brand.json').toString('utf8'))).toMatchObject({ name: 'Acme' })
      expect(file('logo.svg')).toEqual(LOGO)
      expect(() => file('../download.zip')).toThrow(/leaves its folder/)
    }
  })

  it('refuses a server that answers an error, or too slowly', async () => {
    expect(await refusal(`${base}/missing.zip`)).toBe('http_404')
    routes.set('/slow.zip', (res) => {
      res.writeHead(200)
      // A drip: one byte now and then, never finishing within the timeout.
      const t = setInterval(() => res.write('x'), 200)
      res.on('close', () => clearInterval(t))
    })
    const started = Date.now()
    expect(await refusal(`${base}/slow.zip`)).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(small.timeoutMs + 1000)
  })

  it('refuses a body over the cap, with an honest content-length or none', async () => {
    const big = Buffer.alloc(small.maxBytes + 1)
    expect(await refusal(serve('/big-declared.zip', big))).toBe('too_large')
    routes.set('/big-chunked.zip', (res) => {
      res.writeHead(200) // no content-length: chunked
      res.write(big.subarray(0, 40_000))
      res.end(big.subarray(40_000))
    })
    expect(await refusal(`${base}/big-chunked.zip`)).toBe('too_large')
  })

  it('refuses unsafe entries and too many of them', async () => {
    const one = (e: Entry) => makeZip([{ name: 'brand.json', data: BRAND }, e])
    expect(await refusal(serve('/dots.zip', one({ name: '../evil.txt', data: Buffer.from('x') })))).toBe(
      'unsafe_path',
    )
    expect(await refusal(serve('/abs.zip', one({ name: '/etc/evil', data: Buffer.from('x') })))).toBe(
      'unsafe_path',
    )
    expect(
      await refusal(
        serve('/link.zip', one({ name: 'logo.svg', data: Buffer.from('/etc/passwd'), symlink: true })),
      ),
    ).toBe('unsafe_path')
    const many = makeZip(
      Array.from({ length: 21 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.from('x') })),
    )
    expect(await refusal(serve('/many.zip', many))).toBe('too_many_entries')
    expect(await refusal(serve('/junk.zip', Buffer.from('not a zip at all, just bytes')))).toBe('bad_zip')
  })

  it('refuses bombs, honest or lying about their size, without writing past the cap', async () => {
    const zeros = Buffer.alloc(small.maxUnpackedBytes + 1024)
    const honest = makeZip([{ name: 'bomb.bin', data: zeros, deflate: true }])
    expect(await refusal(serve('/bomb.zip', honest))).toBe('too_large')
    const liar = makeZip([{ name: 'bomb.bin', data: zeros, deflate: true, declared: 10 }])
    const dir = mkdtempSync(join(tmpdir(), 'brand-test-'))
    await expect(unpackZip(serve('/liar.zip', liar), dir, small)).rejects.toMatchObject({
      reason: 'too_large',
    })
    expect(existsSync(join(dir, 'x', 'bomb.bin'))).toBe(false)
  })

  it('has the limits the build uses', () => {
    expect(BRAND_ZIP_LIMITS).toEqual({
      timeoutMs: 30_000,
      maxBytes: 25 * 1024 * 1024,
      maxEntries: 500,
      maxUnpackedBytes: 100 * 1024 * 1024,
    })
  })
})
