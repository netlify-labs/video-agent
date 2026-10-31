// Spike S2 (plan v2 §12, §14 rule 23): serves a stand-in app origin and a sandboxed composition preview, to prove
// the vendored HyperFrames player works inside the §7 CSP with an opaque-origin sandbox, in Chrome and Safari.
//   /app/                         host page (sets a session cookie, embeds the preview, runs the host bridge)
//   /api/v1/me                    returns a secret only with the session cookie (the canary target)
//   /preview/<cap>/index.html     the composition as one sandboxed document, runtime and bridge injected
//   /preview/<cap>/<path>         manifest files of the bundle; relative subresources resolve under <cap>
// <cap> is one signed, expiring, path-scoped capability (exp.sig) for the whole bundle: no per-file signatures.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, relative, sep } from 'node:path'

const KEY = 'spike-s2-key'
const here = new URL('.', import.meta.url).pathname
const fixture = join(here, 'fixture')
const hf = join(here, '..', '..', 'node_modules', 'hyperframes', 'dist')

/**
 * The §7 policy, with every source scoped to this bundle's capability path instead of 'self'. WebKit gives a
 * sandboxed document's children a fresh opaque origin that 'self' never matches; an explicit origin + path works in
 * both engines and also stops a bundle from loading anything outside itself (other bundles, /api, the app).
 * connect-src gets the same path so the runtime can fetch nested scenes, still never /api.
 */
export function csp(base: string) {
  return `sandbox allow-scripts; default-src 'none'; script-src ${base} 'unsafe-inline'; style-src ${base} 'unsafe-inline'; font-src ${base}; img-src ${base} data:; media-src ${base}; connect-src ${base}; frame-src ${base}; form-action 'none'; base-uri 'none'`
}

export function capability(bundle: string, expSec: number) {
  const sig = createHmac('sha256', KEY).update(`${bundle}.${expSec}`).digest('base64url').slice(0, 32)
  return `${expSec}.${sig}`
}
function validCap(bundle: string, cap: string) {
  const [exp, sig] = cap.split('.')
  if (!exp || !sig || Number(exp) * 1000 < Date.now()) return false
  const want = capability(bundle, Number(exp)).split('.')[1] ?? ''
  return sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want))
}

/** The bundle's manifest: every file under fixture/ (in production, the extracted source.tar.gz). */
function manifest(): Set<string> {
  const out = new Set<string>()
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else out.add(relative(fixture, p).split(sep).join('/'))
    }
  }
  walk(fixture)
  return out
}

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  png: 'image/png',
}

export interface Hit {
  path: string
  cookie: boolean
  range: string | null
}

export async function startServers() {
  const hits: Hit[] = []
  const evilHits: string[] = []
  const evil = createServer((req, res) => {
    evilHits.push(req.url ?? '')
    res.setHeader('access-control-allow-origin', '*')
    res.end('stolen')
  })
  await new Promise<void>((r) => evil.listen(0, '127.0.0.1', r))
  const evilOrigin = `http://127.0.0.1:${(evil.address() as AddressInfo).port}`
  const files = manifest()

  const previewHeaders = (res: ServerResponse, type: string, base: string) => {
    res.setHeader('content-type', type)
    res.setHeader('content-security-policy', csp(base))
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('cache-control', 'private, no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    // The sandboxed document's origin is "null": nested scenes are fetched cross-origin. Bundle files are
    // capability-gated and never sent with credentials, so any origin may read them.
    res.setHeader('access-control-allow-origin', '*')
  }

  let origin = ''
  const app = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x')
    hits.push({
      path: url.pathname,
      cookie: /session=/.test(req.headers.cookie ?? ''),
      range: req.headers.range ?? null,
    })
    if (url.pathname === '/app/' || url.pathname === '/app/attacker.html') {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.setHeader('set-cookie', 'session=SECRET; Path=/; SameSite=Lax')
      res.end(readFileSync(join(here, url.pathname === '/app/' ? 'host.html' : 'attacker.html'), 'utf8'))
      return
    }
    if (url.pathname === '/app/cap') {
      const exp = Number(url.searchParams.get('exp') ?? Math.floor(Date.now() / 1000) + 600)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ cap: capability('bundle-1', exp) }))
      return
    }
    if (url.pathname === '/api/v1/me') {
      const ok = /session=SECRET/.test(req.headers.cookie ?? '')
      res.statusCode = ok ? 200 : 401
      res.end(ok ? 'SECRET-PROFILE' : 'no')
      return
    }
    const m = /^\/preview\/([^/]+)\/(.+)$/.exec(url.pathname)
    if (m?.[1] && m[2]) {
      const [cap, path] = [m[1], decodeURIComponent(m[2])]
      if (!validCap('bundle-1', cap)) {
        res.statusCode = 403
        res.end('expired or invalid')
        return
      }
      const base = `${origin}/preview/${cap}/`
      if (path === 'index.html') {
        // One sandboxed document: the composition itself, with the vendored runtime first and the bridge last.
        const comp = readFileSync(join(fixture, 'index.html'), 'utf8')
          .replaceAll('EVIL_ORIGIN', evilOrigin)
          .replace('<head>', '<head><script src="_hf/runtime.js"></script>')
          .replace('</body>', '<script src="_hf/bridge.js"></script></body>')
        previewHeaders(res, TYPES.html ?? '', base)
        res.end(comp)
        return
      }
      const vendored: Record<string, string> = {
        '_hf/runtime.js': join(hf, 'hyperframe.runtime.iife.js'),
        '_hf/bridge.js': join(here, 'bridge.js'),
      }
      const file = vendored[path] ?? (files.has(path) ? join(fixture, path) : null)
      if (!file || !existsSync(file)) {
        res.statusCode = 404
        res.end('not in the bundle')
        return
      }
      const ext = path.split('.').pop() ?? ''
      previewHeaders(res, TYPES[ext] ?? 'application/octet-stream', base)
      const body = readFileSync(file)
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
      if (range) {
        const start = Number(range[1])
        const end = range[2] ? Number(range[2]) : body.length - 1
        res.statusCode = 206
        res.setHeader('content-range', `bytes ${start}-${end}/${body.length}`)
        res.setHeader('accept-ranges', 'bytes')
        res.end(body.subarray(start, end + 1))
        return
      }
      res.setHeader('accept-ranges', 'bytes')
      res.end(body)
      return
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(app.address() as AddressInfo).port}`
  return {
    origin,
    evilOrigin,
    hits,
    evilHits,
    close: () => {
      app.close()
      evil.close()
    },
  }
}
