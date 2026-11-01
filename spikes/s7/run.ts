// Spike S7 (plan v2 §11): can the browser render a composition to MP4 faithfully? Timeboxed research; nothing depends on
// it. For three ready videos on a live site, compares frames of the runner's MP4 with two browser paths at the same
// times:
//   dom     what a web page can do on its own: seek window.__player, then html-to-image (SVG foreignObject) on the page
//   cdp     what the browser can paint (a Playwright screenshot); a page can't do this itself, an extension or a
//           headless renderer can, which is what the runner already does
// and checks WebCodecs encoder support (H.264, VP9) in Chromium and WebKit. Scores are SSIM against the runner frame.
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… npx tsx spikes/s7/run.ts
// JSON lines; frames land in spikes/out/s7/.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, webkit, type Browser } from '@playwright/test'

const base = (process.env.VIDEO_AGENT_URL ?? '').replace(/\/$/, '')
const key = process.env.VIDEO_AGENT_KEY ?? ''
if (!base || !key) throw new Error('Set VIDEO_AGENT_URL and VIDEO_AGENT_KEY.')
const out = join('spikes', 'out', 's7')
mkdirSync(out, { recursive: true })
const log = (step: string, f: Record<string, unknown> = {}) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), step, ...f }))
}
const api = async <T>(path: string) =>
  (await (await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${key}` } })).json()) as T

interface Video {
  id: string
  title: string
  dimensions: { width: number; height: number }
  versions: { n: number; status: string; output: { durationSec: number } | null }[]
}

/** SSIM of two images, scaled to the same size (ffmpeg prints it on stderr). */
function ssimOf(a: string, b: string, w: number, h: number): number {
  const r = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-i',
      a,
      '-i',
      b,
      '-lavfi',
      `[0]scale=${w}:${h}[x];[1]scale=${w}:${h}[y];[x][y]ssim`,
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8' },
  )
  return Number(/All:([0-9.]+)/.exec(r.stderr)?.[1] ?? 'NaN')
}

// WebCodecs needs a secure context, and the check is a string so the tsx transform can't add helpers to it.
const CODECS = `(async () => {
  if (!('VideoEncoder' in self)) return { webcodecs: false }
  const test = async (codec) =>
    (await VideoEncoder.isConfigSupported({ codec, width: 1920, height: 1080, bitrate: 8e6, framerate: 30 })).supported
  return { webcodecs: true, h264: await test('avc1.640028'), vp9: await test('vp09.00.40.08'), av1: await test('av01.0.08M.08') }
})()`
async function codecs(b: Browser, name: string) {
  const page = await b.newPage()
  await page.goto(base)
  log('webcodecs', { browser: name, ...(await page.evaluate<Record<string, boolean>>(CODECS)) })
  await page.close()
}

const list = await api<{ items: { id: string; status: string }[] }>('/api/v1/videos?limit=30')
const picks: Video[] = []
for (const v of list.items) {
  if (picks.length >= 3) break
  const full = await api<Video>(`/api/v1/videos/${v.id}`)
  const ready = full.versions.find((x) => x.status === 'ready' && x.output)
  if (ready) picks.push({ ...full, versions: [ready] })
}
log('videos', { picked: picks.map((p) => ({ id: p.id, title: p.title, n: p.versions[0]?.n })) })

const browser = await chromium.launch()
await codecs(browser, 'chromium')
const wk = await webkit.launch()
await codecs(wk, 'webkit')
await wk.close()

const scores: { dom: number[]; cdp: number[]; domMs: number[] } = { dom: [], cdp: [], domMs: [] }
for (const v of picks) {
  const ver = v.versions[0]!
  const { width: w, height: h } = v.dimensions
  const mp4 = join(out, `${v.id}.mp4`)
  const file = await fetch(`${base}/api/v1/videos/${v.id}/versions/${ver.n}/video`, {
    headers: { authorization: `Bearer ${key}` },
  })
  writeFileSync(mp4, new Uint8Array(await file.arrayBuffer()))
  const link = await api<{ url: string }>(`/api/v1/videos/${v.id}/versions/${ver.n}/preview`)
  // The preview's CSP (rightly) blocks outside scripts; the spike lifts it to load html-to-image.
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, bypassCSP: true })
  const page = await ctx.newPage()
  await page.goto(link.url)
  await page.waitForFunction(
    () => Boolean((globalThis as unknown as { __player?: unknown }).__player),
    null,
    {
      timeout: 20_000,
    },
  )
  await page.addScriptTag({ url: 'https://cdn.jsdelivr.net/npm/html-to-image@1.11.13/dist/html-to-image.js' })
  // Warm up: the first seek right after load can paint before the composition settles.
  await page.evaluate(`window.__player.seek(0)`)
  await page.waitForTimeout(1000)
  const dur = ver.output?.durationSec ?? 10
  for (const frac of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    const t = Math.round(dur * frac * 30) / 30
    const tag = `${v.id}-${Math.round(t * 1000)}`
    const ref = join(out, `${tag}-runner.png`)
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      String(t),
      '-i',
      mp4,
      '-frames:v',
      '1',
      ref,
    ])
    await page.evaluate(async (time) => {
      const p = (globalThis as unknown as { __player: { pause(): void; seek(t: number): void } }).__player
      const g = globalThis as unknown as {
        document: { fonts: { ready: Promise<unknown> } }
        requestAnimationFrame(cb: () => void): void
      }
      p.pause()
      p.seek(time)
      await g.document.fonts.ready
      await new Promise<void>((r) => {
        g.requestAnimationFrame(() => {
          g.requestAnimationFrame(r)
        })
      })
    }, t)
    const cdp = join(out, `${tag}-cdp.png`)
    await page.screenshot({ path: cdp })
    const started = Date.now()
    const dataUrl = await page.evaluate(async () => {
      const g = globalThis as unknown as {
        htmlToImage: { toPng(n: unknown, o: object): Promise<string> }
        document: { documentElement: unknown }
      }

      try {
        return await g.htmlToImage.toPng(g.document.documentElement, { pixelRatio: 1 })
      } catch (e) {
        return `error:${String(e)}`
      }
    })
    const domMs = Date.now() - started
    const dom = join(out, `${tag}-dom.png`)
    if (dataUrl.startsWith('data:image/png;base64,')) {
      writeFileSync(dom, Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'))
      const s = { t, cdp: ssimOf(ref, cdp, w, h), dom: ssimOf(ref, dom, w, h), domMs }
      scores.cdp.push(s.cdp)
      scores.dom.push(s.dom)
      scores.domMs.push(domMs)
      log('frame', { video: v.id, ...s })
    } else
      log('frame', { video: v.id, t, cdp: ssimOf(ref, cdp, w, h), dom: null, error: dataUrl.slice(0, 200) })
  }
  await ctx.close()
}
await browser.close()
const avg = (xs: number[]) =>
  xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : null
const min = (xs: number[]) => (xs.length ? Math.round(Math.min(...xs) * 1000) / 1000 : null)
log('summary', {
  frames: scores.cdp.length,
  cdp: { avg: avg(scores.cdp), min: min(scores.cdp) },
  dom: { avg: avg(scores.dom), min: min(scores.dom), msPerFrame: avg(scores.domMs) },
})
