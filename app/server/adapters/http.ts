// Webhook delivery: HTTPS only, every resolved address must be public, no redirects. The connection is pinned to
// the address that passed validation (TLS still checks the hostname), so DNS rebinding between the check and the
// request can't send it somewhere private (plan v2 §14 rule 12).
import { lookup as dnsLookup } from 'node:dns/promises'
import { request } from 'node:https'
import { isIP } from 'node:net'
import type { FetchPort, HttpPort, HttpResponse } from '../deps.js'

/** Expands an IPv6 address to 8 hextets (handles `::`, embedded dotted IPv4 and zone ids). */
export function expandIPv6(ip: string): number[] | null {
  let v = ip.toLowerCase().split('%')[0] ?? ''
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(v)
  if (dotted?.[1]) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted[1].split('.').map(Number)
    v = v.slice(0, -dotted[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = v.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0) return null
  const parts = [...head, ...Array.from({ length: fill }, () => '0'), ...tail]
  if (parts.length !== 8) return null
  const nums = parts.map((p) => (/^[0-9a-f]{1,4}$/.test(p) ? parseInt(p, 16) : NaN))
  return nums.some(Number.isNaN) ? null : nums
}

function privateV4(ip: string): boolean {
  const [a = 0, b = 0] = ip.split('.').map(Number)
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  )
}

const v4From = (h: number[]) =>
  `${(h[6] ?? 0) >> 8}.${(h[6] ?? 0) & 255}.${(h[7] ?? 0) >> 8}.${(h[7] ?? 0) & 255}`

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return privateV4(ip)
  const h = expandIPv6(ip)
  if (!h) return true
  const zeros = (n: number) => h.slice(0, n).every((x) => x === 0)
  if (zeros(8)) return true // ::
  if (zeros(7) && h[7] === 1) return true // ::1
  if (zeros(5) && h[5] === 0xffff) return privateV4(v4From(h)) // ::ffff:a.b.c.d in any notation
  if (zeros(6)) return privateV4(v4From(h)) // ::a.b.c.d (IPv4-compatible)
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return privateV4(v4From(h)) // NAT64 64:ff9b::/96
  const first = h[0] ?? 0
  if ((first & 0xffc0) === 0xfe80) return true // link-local
  if ((first & 0xfe00) === 0xfc00) return true // unique local fc00::/7
  if ((first & 0xff00) === 0xff00) return true // multicast
  if (first === 0x2001 && h[1] === 0x0db8) return true // documentation
  return false
}

type Resolver = (host: string) => Promise<{ address: string; family: number }[]>
const defaultResolver: Resolver = (host) => dnsLookup(host, { all: true })

/** Resolves a webhook host and returns one public address to pin, or throws. */
export async function resolvePublic(
  host: string,
  resolver: Resolver = defaultResolver,
): Promise<{ address: string; family: number }> {
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolver(host)
  if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address)))
    throw new Error('webhook URL resolves to a private address')
  return addrs[0] as { address: string; family: number }
}

/** A pinned HTTPS POST: connects only to the validated public address, never follows redirects. */
async function pinnedPost(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
  resolver: Resolver,
  onResponse: (
    res: import('node:http').IncomingMessage,
    done: (v: unknown) => void,
    fail: (e: Error) => void,
  ) => void,
): Promise<unknown> {
  const u = new URL(url)
  if (u.protocol !== 'https:') throw new Error('URL must be https')
  if (u.username || u.password) throw new Error('URLs must not carry credentials')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  const pinned = await resolvePublic(host, resolver)
  return new Promise((resolve, reject) => {
    const req = request(
      {
        protocol: 'https:',
        host,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        servername: isIP(host) ? undefined : host,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'user-agent': 'video-agent-webhooks/1',
          ...headers,
        },
        lookup: ((_h: string, o: { all?: boolean }, cb: (...args: unknown[]) => void) => {
          if (o.all) cb(null, [{ address: pinned.address, family: pinned.family }])
          else cb(null, pinned.address, pinned.family)
        }) as never,
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400) {
          res.resume()
          reject(new Error(`redirects are not followed (HTTP ${status})`))
          return
        }
        onResponse(res, resolve, reject)
      },
    )
    // One overall deadline, not just an idle timeout.
    const deadline = setTimeout(() => req.destroy(new Error('request timed out')), timeoutMs)
    req.on('close', () => {
      clearTimeout(deadline)
    })
    req.on('timeout', () => req.destroy(new Error('request timed out')))
    req.on('error', reject)
    req.end(body)
  })
}

export function createSafeHttp(resolver: Resolver = defaultResolver): HttpPort {
  return {
    async postJsonForResponse(url, body, headers, opts) {
      return (await pinnedPost(url, body, headers, opts.timeoutMs, resolver, (res, done, fail) => {
        const chunks: Buffer[] = []
        let size = 0
        let truncated = false
        res.on('data', (c: Buffer) => {
          if (truncated) return
          size += c.length
          if (size > opts.maxBodyBytes) {
            truncated = true
            chunks.push(c.subarray(0, c.length - (size - opts.maxBodyBytes)))
            res.destroy()
            done(finish())
          } else chunks.push(c)
        })
        const finish = (): HttpResponse => ({
          status: res.statusCode ?? 0,
          headers: {
            contentType: res.headers['content-type'] ?? null,
            retryAfter: res.headers['retry-after'] ?? null,
          },
          body: Buffer.concat(chunks).toString('utf8'),
          truncated,
        })
        res.on('end', () => {
          if (!truncated) done(finish())
        })
        res.on('error', fail)
      })) as HttpResponse
    },
    async postJson(url, body, headers, timeoutMs) {
      const u = new URL(url)
      if (u.protocol !== 'https:') throw new Error('webhook URL must be https')
      const host = u.hostname.replace(/^\[|\]$/g, '')
      const pinned = await resolvePublic(host, resolver)
      return new Promise<{ status: number }>((resolve, reject) => {
        const req = request(
          {
            protocol: 'https:',
            host,
            port: u.port || 443,
            path: `${u.pathname}${u.search}`,
            method: 'POST',
            servername: isIP(host) ? undefined : host,
            headers: {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(body),
              'user-agent': 'video-agent-webhooks/1',
              ...headers,
            },
            // Connect to the validated address only; never re-resolve.
            lookup: ((_h: string, o: { all?: boolean }, cb: (...args: unknown[]) => void) => {
              if (o.all) cb(null, [{ address: pinned.address, family: pinned.family }])
              else cb(null, pinned.address, pinned.family)
            }) as never,
            timeout: timeoutMs,
          },
          (res) => {
            res.resume()
            const status = res.statusCode ?? 0
            if (status >= 300 && status < 400)
              reject(new Error(`redirects are not followed (HTTP ${status})`))
            else resolve({ status })
          },
        )
        req.on('timeout', () => req.destroy(new Error('webhook request timed out')))
        req.on('error', reject)
        req.end(body)
      })
    },
  }
}

export const safeHttp: HttpPort = createSafeHttp()

/**
 * fetch for third-party APIs and downloads: HTTPS only, and the host must resolve to public addresses only. Callers
 * pass redirect: 'manual' and check each hop, so every request comes through here.
 */
export function createPublicFetch(resolver: Resolver = defaultResolver): FetchPort {
  return async (url, init) => {
    const u = new URL(url)
    if (u.protocol !== 'https:') throw new Error('only https URLs are fetched')
    await resolvePublic(u.hostname.replace(/^\[|\]$/g, ''), resolver)
    return fetch(u, { ...init, redirect: 'manual' })
  }
}
