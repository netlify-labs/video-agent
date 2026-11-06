// The render guard (owner decision 2026-11-06, after docs/spikes.md C2 finding 4): local mode renders the agent-written
// composition with the host's Chrome, outside the agent's sandbox, so the rendered page must not reach the person's own
// machine or network. Chrome runs through a proxy in the CLI (HYPERFRAMES_BROWSER_PATH points at a wrapper that adds
// --proxy-server and --proxy-bypass-list=<-loopback>, so even loopback requests come here). The proxy resolves each
// host once and connects to that address itself (no DNS rebinding), and refuses:
//   loopback (127.0.0.0/8, ::1), private (10/8, 172.16/12, 192.168/16, fc00::/7), link-local (169.254/16, fe80::/10),
//   unspecified addresses and *.local names
// except the render's own asset server: a loopback port the render's process group is listening on. Anything it
// can't decide is refused (fail closed), and each refusal is logged.
import { spawnSync } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { chmodSync, writeFileSync } from 'node:fs'
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { isIP, connect, type Socket } from 'node:net'
import type { Log } from './workspace.js'

const v4 = (ip: string) => ip.split('.').map(Number)

/** Loopback, private, link-local, unspecified or carrier-grade NAT: never for a rendered page. */
export function isLocalAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (mapped?.[1]) return isLocalAddress(mapped[1])
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = v4(ip)
    return (
      a === 127 ||
      a === 10 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    )
  }
  if (isIP(ip) === 6) {
    const s = ip.toLowerCase()
    return s === '::1' || s === '::' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s)
  }
  return true // not an address at all: refuse
}

export const isLoopback = (ip: string) => ip === '::1' || ip.startsWith('127.') || /^::ffff:127\./i.test(ip)

/**
 * The TCP ports a process group listens on, each with the address to reach it (lsof -g); null when that can't be found
 * out. A wildcard listener is reached on 127.0.0.1.
 */
export function listeningPorts(pgid: number): Map<number, string> | null {
  const r = spawnSync('lsof', ['-a', '-iTCP', '-sTCP:LISTEN', '-P', '-n', '-g', String(pgid), '-Fn'], {
    encoding: 'utf8',
  })
  if (r.error) return null
  const ports = new Map<number, string>()
  for (const line of r.stdout.split('\n')) {
    const m = /^n\[?(.*?)\]?:(\d+)$/.exec(line)
    if (!m?.[1] || !m[2]) continue
    const address = m[1] === '*' ? '127.0.0.1' : m[1]
    if (isLoopback(address) || m[1] === '*') ports.set(Number(m[2]), address)
  }
  return ports
}

export type Decision = { ok: true; address: string } | { ok: false; reason: string }

/** Whether the page may reach host:port, and the one address to connect to. */
export async function decide(
  host: string,
  port: number,
  ownPorts: () => Map<number, string> | null,
): Promise<Decision> {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (name.endsWith('.local') || name === 'local') return { ok: false, reason: 'a .local name' }
  let address = name
  if (!isIP(name)) {
    try {
      address = (await lookup(name)).address
    } catch {
      return { ok: false, reason: "it didn't resolve" }
    }
  }
  if (isLoopback(address) || name === 'localhost') {
    const own = ownPorts()
    if (own === null) return { ok: false, reason: "the render's own ports couldn't be read (lsof)" }
    // The address the render's server listens on (localhost may resolve to ::1 while it's on 127.0.0.1).
    const at = own.get(port)
    return at ? { ok: true, address: at } : { ok: false, reason: 'loopback, not the render server' }
  }
  if (isLocalAddress(address)) return { ok: false, reason: 'a private or link-local address' }
  return { ok: true, address }
}

export interface Guard {
  port: number
  blocked: { host: string; port: number; reason: string }[]
  close: () => Promise<void>
}

/** The proxy Chrome's requests go through for one render. `pgid` is the render's process group. */
export async function startRenderGuard(o: { getPgid: () => number | null; log: Log }): Promise<Guard> {
  const blocked: Guard['blocked'] = []
  const ownPorts = () => {
    const pgid = o.getPgid()
    return pgid === null ? null : listeningPorts(pgid)
  }
  const refuse = (host: string, port: number, reason: string) => {
    blocked.push({ host, port, reason })
    o.log('local.render_blocked', { host, port, reason })
  }
  const sockets = new Set<Socket>()
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let target: URL
    try {
      target = new URL(req.url ?? '')
    } catch {
      res.writeHead(400).end()
      return
    }
    const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
    void decide(target.hostname, port, ownPorts).then((d) => {
      if (!d.ok) {
        refuse(target.hostname, port, d.reason)
        res.writeHead(403, { 'content-type': 'text/plain' }).end('Blocked by video-agent local mode.')
        return
      }
      const upstream = request(
        {
          host: d.address,
          port,
          method: req.method,
          path: `${target.pathname}${target.search}`,
          headers: { ...req.headers, host: target.host },
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers)
          up.pipe(res)
        },
      )
      upstream.on('error', () => res.writeHead(502).end())
      req.pipe(upstream)
    })
  })
  // HTTPS and WebSockets: CONNECT host:port.
  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    sockets.add(client)
    client.on('close', () => sockets.delete(client))
    const m = /^(.*):(\d+)$/.exec(req.url ?? '')
    const host = m?.[1] ?? ''
    const port = Number(m?.[2] ?? 0)
    void decide(host, port, ownPorts).then((d) => {
      if (!d.ok) {
        refuse(host, port, d.reason)
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
        return
      }
      const up = connect(port, d.address, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) up.write(head)
        up.pipe(client)
        client.pipe(up)
      })
      sockets.add(up)
      up.on('close', () => sockets.delete(up))
      up.on('error', () => client.destroy())
      client.on('error', () => up.destroy())
    })
  })
  server.on('connection', (s: Socket) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return {
    port,
    blocked,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy()
        server.close(() => r())
      }),
  }
}

/**
 * A Chrome wrapper at `path` that starts `chrome` with every request through the guard: loopback included
 * (<-loopback> drops Chrome's implicit bypass), and WebRTC kept off UDP outside the proxy.
 */
export function writeChromeWrapper(path: string, chrome: string, guardPort: number) {
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      `exec ${JSON.stringify(chrome)} --proxy-server=http://127.0.0.1:${guardPort} '--proxy-bypass-list=<-loopback>' --force-webrtc-ip-handling-policy=disable_non_proxied_udp "$@"`,
      '',
    ].join('\n'),
  )
  chmodSync(path, 0o755)
}
