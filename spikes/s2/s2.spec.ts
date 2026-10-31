// Spike S2: the vendored HyperFrames player inside the §7 preview sandbox. Positive: play, seek, click → text id,
// apply-edits, relative subresources through one path-scoped capability, MP4 slot playback, renewal keeping the
// playhead. Negative: no session or API access, no egress, forged messages ignored, expired capability refused.
import { expect, test, type Page } from '@playwright/test'
import { capability, startServers } from './server.js'

type Msg = { type: string; time?: number; textId?: string | null; [k: string]: unknown }
let srv: Awaited<ReturnType<typeof startServers>>
test.beforeAll(async () => {
  srv = await startServers()
})
test.afterAll(() => {
  srv.close()
})

const messages = (page: Page) => page.evaluate<Msg[]>('window.__fromPreview')
const send = (page: Page, m: object) => page.evaluate(`window.__send(${JSON.stringify(m)})`)
const sendRaw = (page: Page, m: object) => page.evaluate(`window.__sendRaw(${JSON.stringify(m)})`)
async function waitFor(page: Page, type: string, pred: (m: Msg) => boolean = () => true, after = 0) {
  await expect
    .poll(async () => (await messages(page)).slice(after).some((m) => m.type === type && pred(m)), {
      timeout: 20_000,
    })
    .toBe(true)
  return (await messages(page))
    .slice(after)
    .filter((m) => m.type === type && pred(m))
    .at(-1) as Msg
}
const comp = (page: Page) => page.frameLocator('#preview')

test('the player runs in the sandbox and is driven only through the bridge', async ({ page }) => {
  await page.goto(`${srv.origin}/app/`)
  const ready = await waitFor(page, 'ready')
  expect(ready.duration).toBe(5)

  // play / pause / seek
  await send(page, { type: 'play' })
  await waitFor(page, 'time', (m) => (m.time ?? 0) > 0.3)
  await send(page, { type: 'pause' })
  await send(page, { type: 'seek', time: 1.5 })
  await waitFor(page, 'time', (m) => Math.abs((m.time ?? 0) - 1.5) < 0.05)

  // click in the composition → the element's id comes back to the host
  const n = (await messages(page)).length
  await comp(page).locator('#title').click({ force: true })
  expect((await waitFor(page, 'click', () => true, n)).textId).toBe('title')

  // apply-edits sets text (never HTML)
  await send(page, { type: 'apply-edits', edits: [{ id: 'title', text: '<b>New</b> title' }] })
  await waitFor(page, 'edits-applied')
  await expect(comp(page).locator('#title')).toHaveText('<b>New</b> title')

  // subresources through the one capability: CSS url(), <img>, vendored GSAP, the MP4 slot with Range
  await send(page, { type: 'seek', time: 0.5 })
  await expect
    .poll(
      async () => {
        const n2 = (await messages(page)).length
        await send(page, { type: 'probe' })
        const p = await waitFor(page, 'probe', () => true, n2)
        return (
          p.logoLoaded === true &&
          Number(p.clipReady) >= 1 &&
          String(p.bg).includes('assets/bg.svg') &&
          p.nested === 'Read the docs'
        )
      },
      { timeout: 20_000 },
    )
    .toBe(true)
  const cap = await page.evaluate<string>('window.__cap')
  for (const f of [
    'style.css',
    'assets/logo.svg',
    'assets/bg.svg',
    'vendor/gsap.min.js',
    'assets/media/clip.mp4',
    'compositions/outro.html',
  ])
    expect(
      srv.hits.some((h) => h.path === `/preview/${cap}/${f}`),
      f,
    ).toBe(true)
})

test('nothing in the preview reaches the session, the API, the parent or the network', async ({ page }) => {
  srv.evilHits.length = 0
  await page.goto(`${srv.origin}/app/`)
  await waitFor(page, 'ready')
  await page.waitForTimeout(1500)
  const n = (await messages(page)).length
  await send(page, { type: 'probe' })
  const p = await waitFor(page, 'probe', () => true, n)
  const canary = p.canary as Record<string, string>
  // Reading document.cookie throws in an opaque-origin sandbox.
  expect(canary.cookie).toBe('blocked')
  expect(canary.parent).toBe('blocked')
  expect(canary.storage).toBe('blocked')
  expect(canary.fetch).toBe('blocked')
  expect(srv.hits.filter((h) => h.path === '/api/v1/me')).toEqual([])
  // Finding: preview requests are same-site, so browsers do attach the app's session cookie to them. The page can't
  // read it (above) or send it anywhere (CSP), so the preview endpoint must authorize by capability alone and never
  // vary on cookies: the same request with and without the cookie gets the same bytes.
  const cap = await page.evaluate<string>('window.__cap')
  const withCookie = await page.request.get(`${srv.origin}/preview/${cap}/index.html`)
  const without = await fetch(`${srv.origin}/preview/${cap}/index.html`)
  expect(await withCookie.text()).toBe(await without.text())
  expect(srv.evilHits).toEqual([])
})

test('forged and off-channel messages are ignored on both sides', async ({ page }) => {
  await page.goto(`${srv.origin}/app/`)
  await waitFor(page, 'ready')
  await send(page, { type: 'pause' })
  await send(page, { type: 'seek', time: 1 })
  await waitFor(page, 'time', (m) => Math.abs((m.time ?? 0) - 1) < 0.05)
  // The attacker frame posts "click" messages to the host every 200 ms: never accepted.
  await page.waitForTimeout(800)
  expect(await page.evaluate<number>('window.__rejected')).toBeGreaterThan(0)
  expect((await messages(page)).some((m) => m.textId === 'forged')).toBe(false)
  // The preview ignores commands without its channel.
  await sendRaw(page, { type: 'seek', time: 4, channel: 'wrong' })
  await sendRaw(page, { type: 'seek', time: 4 })
  await page.waitForTimeout(800)
  expect(Math.abs((await page.evaluate<number>('window.__lastTime()')) - 1)).toBeLessThan(0.05)
})

test('renewing the capability keeps the playhead; an expired one is refused', async ({ page }) => {
  await page.goto(`${srv.origin}/app/`)
  await waitFor(page, 'ready')
  await send(page, { type: 'seek', time: 3.2 })
  await waitFor(page, 'time', (m) => Math.abs((m.time ?? 0) - 3.2) < 0.05)
  const before = await page.evaluate<string>('window.__cap')
  await page.waitForTimeout(1100) // a new expiry second → a new capability
  const n = (await messages(page)).length
  await page.evaluate('window.__renew()')
  await waitFor(page, 'ready', () => true, n)
  await waitFor(page, 'time', (m) => Math.abs((m.time ?? 0) - 3.2) < 0.05, n)
  expect(await page.evaluate<string>('window.__cap')).not.toBe(before)
  const expired = capability('bundle-1', Math.floor(Date.now() / 1000) - 5)
  const res = await page.request.get(`${srv.origin}/preview/${expired}/index.html`)
  expect(res.status()).toBe(403)
  // Encoded traversal reaches the server as a bundle path and is refused (not in the manifest).
  const traversal = await page.request.get(`${srv.origin}/preview/${before}/%2e%2e%2f%2e%2e%2fapi%2fv1%2fme`)
  expect(traversal.status()).toBe(404)
  expect(await traversal.text()).not.toContain('SECRET')
})
