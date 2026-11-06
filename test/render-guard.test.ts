// The render guard (owner decision 2026-11-06; docs/spikes.md C2 finding 4): the page local mode renders with the
// host's Chrome can't reach this machine or its network (loopback, private, link-local, *.local), except the render's
// own asset server, and anything undecidable is refused.
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, request, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decide, isLocalAddress, startRenderGuard } from '../packages/cli/src/local/render-guard.js'

describe('isLocalAddress', () => {
  it('covers loopback, private, link-local and unspecified, v4 and v6', () => {
    for (const ip of [
      '127.0.0.1',
      '127.8.9.10',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '0.0.0.0',
      '100.64.0.1',
      '::1',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:192.168.0.10',
      'not-an-ip',
    ])
      expect(isLocalAddress(ip), ip).toBe(true)
    for (const ip of ['8.8.8.8', '172.32.0.1', '192.169.1.1', '2606:4700::1111', '::ffff:1.1.1.1'])
      expect(isLocalAddress(ip), ip).toBe(false)
  })
})

describe('decide', () => {
  const own = () => new Map([[4321, '127.0.0.1']])
  it('allows the render server, by the address it listens on', async () => {
    expect(await decide('localhost', 4321, own)).toEqual({ ok: true, address: '127.0.0.1' })
    expect(await decide('127.0.0.1', 4321, own)).toEqual({ ok: true, address: '127.0.0.1' })
    // ::1 on the render's port still goes to the render's own listener, never to another process on ::1.
    expect(await decide('[::1]', 4321, own)).toEqual({ ok: true, address: '127.0.0.1' })
  })
  it('refuses other loopback ports, private and .local; fails closed', async () => {
    expect(await decide('127.0.0.1', 22, own)).toMatchObject({ ok: false })
    expect(await decide('192.168.1.1', 80, own)).toMatchObject({ ok: false })
    expect(await decide('169.254.169.254', 80, own)).toMatchObject({ ok: false })
    expect(await decide('printer.local', 80, own)).toMatchObject({ ok: false, reason: 'a .local name' })
    expect(await decide('no-such-host.invalid', 80, own)).toMatchObject({ ok: false })
    expect(await decide('127.0.0.1', 4321, () => null)).toMatchObject({ ok: false })
  })
  it('allows public addresses', async () => {
    expect(await decide('8.8.8.8', 443, own)).toEqual({ ok: true, address: '8.8.8.8' })
  })
})

describe('the guard proxy', () => {
  let canary: Server
  let canaryPort = 0
  let hits = 0
  let render: ChildProcess
  let renderPort = 0
  beforeAll(async () => {
    canary = createServer((_q, r) => {
      hits++
      r.end('secret')
    })
    await new Promise<void>((r) => canary.listen(0, '127.0.0.1', r))
    canaryPort = (canary.address() as { port: number }).port
    // A stand-in for the render's asset server, in its own process group like the real render.
    render = spawn(
      process.execPath,
      [
        '-e',
        "const s=require('http').createServer((q,r)=>r.end('asset'));s.listen(0,'127.0.0.1',()=>console.log(s.address().port))",
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    renderPort = await new Promise<number>((r) =>
      render.stdout?.once('data', (b: Buffer) => r(Number(String(b)))),
    )
  })
  afterAll(() => {
    canary.close()
    if (render.pid) process.kill(-render.pid, 'SIGKILL')
  })

  const via = (proxyPort: number, url: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: proxyPort, path: url, method: 'GET' }, (res) => {
        let body = ''
        res.on('data', (c: Buffer) => (body += String(c)))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.on('error', reject)
      req.end()
    })

  it("serves the render's own server, refuses the person's, and logs each refusal", async () => {
    const logs: { event: string; fields?: Record<string, unknown> }[] = []
    const guard = await startRenderGuard({
      getPgid: () => render.pid ?? null,
      log: (event, fields) => void logs.push({ event, ...(fields ? { fields } : {}) }),
    })
    try {
      expect(await via(guard.port, `http://localhost:${renderPort}/index.html`)).toEqual({
        status: 200,
        body: 'asset',
      })
      const refused = await via(guard.port, `http://127.0.0.1:${canaryPort}/secret`)
      expect(refused.status).toBe(403)
      expect(refused.body).not.toContain('secret')
      expect(hits).toBe(0)
      expect(guard.blocked).toEqual([
        { host: '127.0.0.1', port: canaryPort, reason: 'loopback, not the render server' },
      ])
      expect(logs.some((l) => l.event === 'local.render_blocked')).toBe(true)
    } finally {
      await guard.close()
    }
  })
})
