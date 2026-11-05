/* global URL, console, process, Headers, Response */
// Smoke test of the built SDK on this Node (cli-and-sdk plan §4.5 Runtime; CI runs it on Node 22 and 24). Plain
// Node, no build tools: imports packages/sdk/dist with import and with require() (Node 22.12+ loads ESM through
// require), constructs a client over a stub fetch, calls videos.get and verifies a webhook signature, and checks the
// main entry imports nothing from node: except the lazy node:fs/promises the file helpers load. One JSON line a step.
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const entry = new URL('../packages/sdk/dist/index.js', import.meta.url)
const log = (step, f = {}) => console.log(JSON.stringify({ step, node: process.version, ...f }))
const fail = (step, f = {}) => {
  log(step, { ok: false, ...f })
  process.exit(1)
}

const esm = await import(entry.href)
log('import', { ok: typeof esm.VideoAgent === 'function' })
const cjs = createRequire(import.meta.url)(entry.pathname)
if (cjs.VideoAgent !== esm.VideoAgent && typeof cjs.VideoAgent !== 'function') fail('require')
log('require', { ok: true })

const seen = []
const va = new esm.VideoAgent({
  url: 'https://video.example.com',
  apiKey: 'nva_smoke',
  fetch: async (url, init) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') })
    return Response.json({ id: 'vid_smoke', versions: [] })
  },
})
const video = await va.videos.get('vid_smoke')
if (video.id !== 'vid_smoke' || seen[0]?.url !== 'https://video.example.com/api/v1/videos/vid_smoke')
  fail('videos.get', { seen })
log('videos.get', { ok: true })

const secret = 'whsec_smoke'
const body = '{"eventId":"evt_1","event":"video.ready"}'
const t = Math.floor(Date.now() / 1000)
const signature = `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`
await esm.verifyWebhook({ secret, body, signature })
const tampered = await esm.verifyWebhook({ secret, body: `${body} `, signature }).then(
  () => false,
  (e) => esm.isVideoAgentError(e, 'invalid_signature'),
)
if (!tampered) fail('verifyWebhook', { tampered })
log('verifyWebhook', { ok: true })

const src = readFileSync(entry, 'utf8')
const nodeRefs = [...new Set(src.match(/["']node:[a-z/]+["']/g) ?? [])]
const staticNode = /^import[^;]*from\s*["']node:/m.test(src)
if (staticNode || nodeRefs.some((r) => !r.includes('node:fs/promises')))
  fail('runtime-neutral', { nodeRefs, staticNode })
log('runtime-neutral', { ok: true, nodeRefs })
