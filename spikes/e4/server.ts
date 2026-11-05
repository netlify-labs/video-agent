// Spike E4, step 2: serves a stand-in app page and the preview bundle under the app's own preview headers
// (src/lib/preview.ts previewHeaders: the CSP with every source scoped to the capability path, sandbox allow-scripts).
//   /app/host.html            the host: a sandboxed iframe and the host side of the bridge
//   /preview/<cap>/<path>     .work/preview/<path>, with the preview CSP
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { previewHeaders } from '../../src/lib/preview.js'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = join(here, '.work', 'preview')
export const CAP = 'cap-e4'
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
}

const HOST = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}#preview{width:960px;height:540px;border:0;display:block}</style></head>
<body><iframe id="preview" sandbox="allow-scripts" title="Preview"></iframe><script>
const frame = document.getElementById('preview')
window.__msgs = []
const channel = crypto.randomUUID()
window.addEventListener('message', (e) => {
  if (e.source !== frame.contentWindow || !e.data || e.data.channel !== channel) return
  window.__msgs.push(Object.assign({ at: performance.now() }, e.data))
})
window.__send = (m) => frame.contentWindow.postMessage(Object.assign({ channel }, m), '*')
window.__loadedAt = performance.now()
frame.src = '/preview/${CAP}/index.html#ch=' + channel + location.hash.replace('#', '&')
</script></body></html>`

export async function start() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const origin = `http://${req.headers.host ?? 'localhost'}`
    if (url.pathname === '/app/host.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(HOST)
    }
    const prefix = `/preview/${CAP}/`
    if (url.pathname.startsWith(prefix)) {
      const rel = normalize(decodeURIComponent(url.pathname.slice(prefix.length)))
      const file = join(bundle, rel)
      if (!file.startsWith(bundle) || !existsSync(file) || statSync(file).isDirectory()) {
        res.writeHead(404)
        return res.end()
      }
      const body = readFileSync(file)
      const type = TYPES[extname(file)] ?? 'application/octet-stream'
      // Range requests for media, as the preview edge function serves them.
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
      const headers = { ...previewHeaders(`${origin}${prefix}`, type), 'accept-ranges': 'bytes' }
      if (range) {
        const a = Number(range[1])
        const b = range[2] ? Number(range[2]) : body.byteLength - 1
        res.writeHead(206, {
          ...headers,
          'content-range': `bytes ${a}-${b}/${body.byteLength}`,
          'content-length': String(b - a + 1),
        })
        return res.end(body.subarray(a, b + 1))
      }
      res.writeHead(200, { ...headers, 'content-length': String(body.byteLength) })
      return res.end(body)
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
