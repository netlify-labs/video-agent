// Live check for the composition preview (plan v2 §7) in Chromium and WebKit. Spends nothing.
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… VIDEO_ID=vid_… [VERSION=n] npx tsx scripts/e2e/preview.ts
// Mints a preview link, then loads it in <iframe sandbox="allow-scripts"> on a local host page and drives it over
// the bridge: ready → play → time moves → seek lands. Logs JSON lines; exits non-zero on the first failure.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium, webkit } from '@playwright/test'

const base = (process.env.VIDEO_AGENT_URL ?? '').replace(/\/$/, '')
const key = process.env.VIDEO_AGENT_KEY ?? ''
const id = process.env.VIDEO_ID ?? ''
if (!base || !key || !id) throw new Error('Set VIDEO_AGENT_URL, VIDEO_AGENT_KEY and VIDEO_ID.')
const log = (step: string, f: Record<string, unknown> = {}) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), step, ...f }))
}
const fail = (msg: string, f: Record<string, unknown> = {}): never => {
  log('FAIL', { msg, ...f })
  process.exit(1)
}

interface Video {
  versions: { n: number; status: string }[]
}
const auth = { authorization: `Bearer ${key}` }
const video = (await (await fetch(`${base}/api/v1/videos/${id}`, { headers: auth })).json()) as Video
const n = Number(process.env.VERSION ?? video.versions.find((v) => v.status === 'ready')?.n ?? 0)
const res = await fetch(`${base}/api/v1/videos/${id}/versions/${n}/preview`, { headers: auth })
if (res.status !== 200) fail('preview link', { status: res.status, body: await res.text() })
const { url } = (await res.json()) as { url: string }
log('link', { id, n, url: url.slice(0, 90) })

const host = createServer((_req, r) => {
  r.setHeader('content-type', 'text/html')
  r.end(`<!doctype html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="width:1920px;height:1080px;border:0"></iframe>
<script>
  const ch = crypto.randomUUID(); const f = document.getElementById('f'); window.msgs = []
  addEventListener('message', (e) => { if (e.source === f.contentWindow && e.data && e.data.channel === ch) msgs.push(e.data) })
  window.send = (m) => f.contentWindow.postMessage(Object.assign({ channel: ch }, m), '*')
  f.src = ${JSON.stringify(url)} + '#ch=' + ch
</script></body>`)
})
await new Promise<void>((r) => host.listen(0, '127.0.0.1', r))
const hostUrl = `http://127.0.0.1:${(host.address() as AddressInfo).port}/`

for (const [name, engine] of [
  ['chromium', chromium],
  ['webkit', webkit],
] as const) {
  const browser = await engine.launch()
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 200))
  })
  await page.goto(hostUrl)
  type M = { type: string; time?: number; duration?: number }
  const msgs = () => page.evaluate<M[]>('window.msgs')
  const until = async (pred: (m: M[]) => boolean, what: string) => {
    for (let i = 0; i < 100; i++) {
      if (pred(await msgs())) return
      await page.waitForTimeout(200)
    }
    fail(`${name}: ${what}`, { msgs: (await msgs()).slice(-5), errors: errors.slice(0, 8) })
  }
  await until((m) => m.some((x) => x.type === 'ready'), 'no ready')
  const ready = (await msgs()).find((x) => x.type === 'ready')
  await page.evaluate("send({ type: 'play' })")
  await until((m) => m.some((x) => x.type === 'time' && (x.time ?? 0) > 0.5), 'time did not move after play')
  await page.evaluate("send({ type: 'pause' }); send({ type: 'seek', time: 1.25 })")
  await until(
    (m) => m.some((x) => x.type === 'time' && Math.abs((x.time ?? 0) - 1.25) < 0.05),
    'seek did not land',
  )
  log('engine', { name, duration: ready?.duration, consoleErrors: errors })
  await browser.close()
}
host.close()
log('PASS', { id, n })
