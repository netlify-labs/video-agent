// Spike S10: a tiny local server for the browser sync + capture harness (no app integration).
//   /                    the instrumented page (web/index.html)
//   /web/<f>.js          docs/spikes/s10/web/<f>.ts, type-stripped by Node (no bundler, no new deps)
//   /lib/<f>.js          docs/spikes/s10/lib/<f>.ts
//   /src/lib/<f>.js      src/lib/<f>.ts (the shared peaks.ts / timeline.ts, unchanged)
//   /media/<f>           docs/spikes/s10/media/ from make-media.sh (Range supported)
//   POST /report         a take / calibration / audition report: written to docs/spikes/s10/out/<ts>-<kind>.json
//   POST /upload         stop -> hash -> upload simulation: reads the WAV, returns its size and SHA-256
// Every response is cross-origin isolated (COOP/COEP) so performance.measureUserAgentSpecificMemory is available.
// Run for the owner checklist: npx tsx docs/spikes/s10/server.ts [port]   (default 4310)
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { stripTypeScriptTypes } from 'node:module'
import type { AddressInfo } from 'node:net'
import { join, normalize } from 'node:path'
import { pathToFileURL } from 'node:url'

const here = new URL('.', import.meta.url).pathname
const repo = join(here, '..', '..', '..')
export const mediaDir = join(here, 'media')
export const outDir = join(here, 'out')

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json',
  mp4: 'video/mp4',
  wav: 'audio/wav',
}

const tsCache = new Map<string, { mtime: number; js: string }>()
function compiled(file: string): string {
  const mtime = statSync(file).mtimeMs
  const hit = tsCache.get(file)
  if (hit?.mtime === mtime) return hit.js
  const js = stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'transform', sourceUrl: file })
  tsCache.set(file, { mtime, js })
  return js
}

const readBody = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const parts: Buffer[] = []
    req.on('data', (c: Buffer) => parts.push(c))
    req.on('end', () => resolve(Buffer.concat(parts)))
    req.on('error', reject)
  })

export interface Saved {
  file: string
  kind: string
}

export async function startServer(port = 0) {
  const saved: Saved[] = []
  mkdirSync(outDir, { recursive: true })
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((e: unknown) => {
      res.statusCode = 500
      res.end(String(e))
    })
  })
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x')
    res.setHeader('cross-origin-opener-policy', 'same-origin')
    res.setHeader('cross-origin-embedder-policy', 'require-corp')
    res.setHeader('cross-origin-resource-policy', 'same-origin')
    res.setHeader('cache-control', 'no-store')
    const p = normalize(decodeURIComponent(url.pathname))
    if (p.includes('..')) {
      res.statusCode = 400
      res.end()
      return
    }
    if (req.method === 'POST' && p === '/report') {
      const body = await readBody(req)
      const json = JSON.parse(body.toString('utf8')) as { kind?: string }
      const kind = (json.kind ?? 'report').replace(/[^a-z0-9-]/gi, '')
      const file = join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${kind}.json`)
      writeFileSync(file, JSON.stringify(json, null, 1))
      saved.push({ file, kind })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ file }))
      return
    }
    if (req.method === 'POST' && p === '/upload') {
      const t0 = performance.now()
      const body = await readBody(req)
      const sha256 = createHash('sha256').update(body).digest('hex')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ bytes: body.length, sha256, serverMs: performance.now() - t0 }))
      return
    }
    if (p === '/' || p === '/index.html') return send(res, join(here, 'web', 'index.html'), 'html')
    const ts = /^\/(web|lib|src\/lib)\/([\w.-]+)\.js$/.exec(p)
    if (ts?.[1] && ts[2]) {
      const base = ts[1] === 'src/lib' ? join(repo, 'src', 'lib') : join(here, ts[1])
      const file = join(base, `${ts[2]}.ts`)
      if (!existsSync(file)) return notFound(res)
      res.setHeader('content-type', TYPES.js ?? '')
      res.end(compiled(file))
      return
    }
    const m = /^\/media\/([\w.-]+)$/.exec(p)
    if (m?.[1]) return send(res, join(mediaDir, m[1]), m[1].split('.').pop() ?? '', req)
    notFound(res)
  }
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { origin, saved, close: () => server.close() }
}

function notFound(res: ServerResponse) {
  res.statusCode = 404
  res.end('not found')
}

function send(res: ServerResponse, file: string, ext: string, req?: IncomingMessage) {
  if (!existsSync(file)) return notFound(res)
  res.setHeader('content-type', TYPES[ext] ?? 'application/octet-stream')
  const body = readFileSync(file)
  res.setHeader('accept-ranges', 'bytes')
  const range = /^bytes=(\d+)-(\d*)$/.exec(req?.headers.range ?? '')
  if (range) {
    const start = Number(range[1])
    const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1
    res.statusCode = 206
    res.setHeader('content-range', `bytes ${start}-${end}/${body.length}`)
    res.end(body.subarray(start, end + 1))
    return
  }
  res.end(body)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!existsSync(join(mediaDir, 'manifest.json'))) {
    console.error('No media yet: run docs/spikes/s10/make-media.sh first.')
    process.exit(1)
  }
  const { origin } = await startServer(Number(process.argv[2] ?? 4310))
  console.log(`S10 harness: ${origin}/   reports -> ${outDir}`)
}
