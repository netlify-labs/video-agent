// Webhook delivery: HTTPS only, every resolved address must be public, no redirects.
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { HttpPort } from '../deps.js'

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase()
    if (v === '::1' || v === '::' || v.startsWith('fe80:') || v.startsWith('fc') || v.startsWith('fd')) return true
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v)
    return mapped?.[1] ? isPrivateAddress(mapped[1]) : false
  }
  const [a = 0, b = 0] = ip.split('.').map(Number)
  return (
    a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  )
}

export const safeHttp: HttpPort = {
  async postJson(url, body, headers, timeoutMs) {
    const u = new URL(url)
    if (u.protocol !== 'https:') throw new Error('webhook URL must be https')
    const addrs = isIP(u.hostname) ? [{ address: u.hostname }] : await lookup(u.hostname, { all: true })
    if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) throw new Error('webhook URL resolves to a private address')
    const res = await fetch(u, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'video-agent-webhooks/1', ...headers },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status >= 300 && res.status < 400) throw new Error(`redirects are not followed (HTTP ${res.status})`)
    return { status: res.status }
  },
}
