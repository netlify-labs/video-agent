// <video-agent-player> in a real browser (cli-and-sdk plan §7): sized before it loads, captions on, CC BY credits
// always shown, the video's events re-dispatched, attribute changes, a plain error for an unpublished video. The
// player is bundled from packages/player/src with esbuild; a fake site (page.route) serves the page, the share
// link's JSON and real fixture media.
import { readFileSync } from 'node:fs'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type Route } from '@playwright/test'
import { buildSync } from 'esbuild'

const SITE = 'https://videos.example'
const fx = (f: string) => readFileSync(new URL(`../../test/fixtures/${f}`, import.meta.url))
const player = buildSync({
  entryPoints: [new URL('../../packages/player/src/index.ts', import.meta.url).pathname],
  bundle: true,
  format: 'esm',
  write: false,
}).outputFiles[0]?.text
const credits = [
  {
    role: 'Music',
    title: 'Track <1>',
    creator: 'Artist',
    creatorUrl: 'https://example.com/artist',
    licenseLabel: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    sourceUrl: 'javascript:alert(1)',
  },
]
const share = (slug: string, o: { width: number; height: number; credits?: unknown[] }) => ({
  type: 'video',
  version: '1.0',
  title: `Video ${slug}`,
  width: o.width,
  height: o.height,
  video_agent: {
    videoId: `vid_${slug}`,
    versionN: 1,
    mp4: `${SITE}/v/${slug}.mp4`,
    poster: `${SITE}/v/${slug}.jpg`,
    posterWebp: null,
    captions: `${SITE}/v/${slug}.vtt`,
    durationSec: 3,
    credits: o.credits ?? [],
    lqip: null,
    hover: null,
  },
})

/** The fake site. `hold` delays the share JSON until released, to look at the box before it loads. */
async function site(page: Page, body: string, hold?: Promise<void>) {
  const cors = { 'access-control-allow-origin': '*' }
  await page.route(`${SITE}/**`, async (route: Route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/page')
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><body style="margin:0;width:640px">${body}<script type="module" src="/player.js"></script>`,
      })
    if (path === '/player.js') return route.fulfill({ contentType: 'text/javascript', body: player ?? '' })
    if (path === '/v/wideslugs.json') {
      await hold
      return route.fulfill({
        json: share('wideslugs', { width: 1920, height: 1080, credits }),
        headers: cors,
      })
    }
    if (path === '/v/tallslugs.json')
      return route.fulfill({ json: share('tallslugs', { width: 1080, height: 1920 }), headers: cors })
    if (/^\/v\/\w+\.json$/.test(path))
      return route.fulfill({ status: 404, json: { error: 'not_found' }, headers: cors })
    if (path.endsWith('.mp4'))
      return route.fulfill({ body: fx('a169.mp4'), contentType: 'video/mp4', headers: cors })
    if (path.endsWith('.jpg'))
      return route.fulfill({ body: fx('poster.jpg'), contentType: 'image/jpeg', headers: cors })
    if (path.endsWith('.vtt'))
      return route.fulfill({ body: fx('captions.vtt'), contentType: 'text/vtt', headers: cors })
    return route.fulfill({ status: 404 })
  })
  await page.goto(`${SITE}/page`)
}

const box = (page: Page) =>
  page.locator('video-agent-player').evaluate((el) => {
    const b = (
      el as unknown as {
        shadowRoot: {
          querySelector(s: string): { getBoundingClientRect(): { width: number; height: number } }
        }
      }
    ).shadowRoot.querySelector('.box')
    const r = b.getBoundingClientRect()
    return { width: Math.round(r.width), height: Math.round(r.height) }
  })
const shadowText = (page: Page, sel: string) =>
  page.locator('video-agent-player').evaluate(
    (el, s) =>
      (
        el as unknown as {
          shadowRoot: { querySelector(x: string): { textContent: string; hidden?: boolean } | null }
        }
      ).shadowRoot.querySelector(s)?.textContent ?? null,
    sel,
  )

test('the box has its size before anything loads, and keeps it', async ({ page }) => {
  let release = () => {}
  const hold = new Promise<void>((r) => (release = r))
  await site(
    page,
    `<video-agent-player src="${SITE}/v/wideslugs" width="1920" height="1080"></video-agent-player>`,
    hold,
  )
  expect(await box(page)).toEqual({ width: 640, height: 360 })
  release()
  await expect
    .poll(() =>
      page
        .locator('video-agent-player')
        .evaluate((el) => (el as unknown as { metadata: unknown }).metadata !== null),
    )
    .toBe(true)
  expect(await box(page)).toEqual({ width: 640, height: 360 })
})

test('captions are on, the credits always show (escaped, http links only), and loaded carries the metadata', async ({
  page,
}) => {
  await site(
    page,
    `<video-agent-player src="${SITE}/v/wideslugs" credits="false" hidecredits></video-agent-player>`,
  )
  const meta = await page.locator('video-agent-player').evaluate(
    (el) =>
      new Promise((resolve) => {
        const m = (el as unknown as { metadata: unknown }).metadata
        if (m) resolve(m)
        else
          (
            el as unknown as { addEventListener(t: string, f: (e: { detail: unknown }) => void): void }
          ).addEventListener('loaded', (e) => resolve(e.detail))
      }),
  )
  expect(meta).toMatchObject({ videoId: 'vid_wideslugs', width: 1920, height: 1080, durationSec: 3 })
  const track = await page.locator('video-agent-player').evaluate((el) => {
    const t = (
      el as unknown as {
        shadowRoot: { querySelector(s: string): { kind: string; default: boolean; src: string } | null }
      }
    ).shadowRoot.querySelector('track')
    return t && { kind: t.kind, default: t.default, src: t.src }
  })
  expect(track).toEqual({ kind: 'captions', default: true, src: `${SITE}/v/wideslugs.vtt` })
  expect(await shadowText(page, 'figcaption')).toBe('Music: Track <1> by Artist, CC BY 4.0')
  const links = await page
    .locator('video-agent-player')
    .evaluate((el) =>
      Array.from(
        (
          el as unknown as { shadowRoot: { querySelectorAll(s: string): ArrayLike<{ href: string }> } }
        ).shadowRoot.querySelectorAll('figcaption a'),
      ).map((a) => a.href),
    )
  // The javascript: source link is text, not a link.
  expect(links).toEqual(['https://example.com/artist', 'https://creativecommons.org/licenses/by/4.0/'])
})

test("the video's events reach the page", async ({ page }) => {
  await site(page, `<video-agent-player src="${SITE}/v/wideslugs" muted></video-agent-player>`)
  await expect
    .poll(() =>
      page
        .locator('video-agent-player')
        .evaluate((el) => (el as unknown as { metadata: unknown }).metadata !== null),
    )
    .toBe(true)
  const seen = await page.locator('video-agent-player').evaluate(async (el) => {
    const got: string[] = []
    for (const t of ['play', 'pause', 'timeupdate']) el.addEventListener(t, () => got.push(t))
    const p = el as unknown as { play(): Promise<void>; pause(): void }
    await p.play()
    await new Promise((r) => setTimeout(r, 400))
    p.pause()
    await new Promise((r) => setTimeout(r, 50))
    return [...new Set(got)]
  })
  expect(seen).toEqual(expect.arrayContaining(['play', 'timeupdate', 'pause']))
})

test('changing src or the explicit sources reloads; an unpublished link shows a plain error', async ({
  page,
}) => {
  await site(page, `<video-agent-player src="${SITE}/v/wideslugs"></video-agent-player>`)
  const el = page.locator('video-agent-player')
  await expect
    .poll(() =>
      el.evaluate(
        (e) => (e as unknown as { metadata: { videoId: string } | null }).metadata?.videoId ?? null,
      ),
    )
    .toBe('vid_wideslugs')
  await el.evaluate((e, s) => e.setAttribute('src', `${s}/v/tallslugs`), SITE)
  await expect
    .poll(() =>
      el.evaluate(
        (e) => (e as unknown as { metadata: { videoId: string } | null }).metadata?.videoId ?? null,
      ),
    )
    .toBe('vid_tallslugs')
  expect(await box(page)).toEqual({ width: 640, height: Math.round((640 * 1920) / 1080) })
  await el.evaluate((e, s) => e.setAttribute('src', `${s}/v/goneslugs`), SITE)
  await expect.poll(() => shadowText(page, '.error')).toBe('This video is not published.')
  await el.evaluate((e, s) => {
    e.removeAttribute('src')
    e.setAttribute('width', '1080')
    e.setAttribute('height', '1080')
    e.setAttribute('mp4', `${s}/v/x.mp4`)
  }, SITE)
  await expect
    .poll(() =>
      el.evaluate((e) => (e as unknown as { metadata: { mp4: string } | null }).metadata?.mp4 ?? null),
    )
    .toBe(`${SITE}/v/x.mp4`)
  expect(await shadowText(page, '.error')).toBeNull()
})

test('has no accessibility violations (axe), loaded and in its error state', async ({ page }) => {
  await site(
    page,
    `<main><h1>Player</h1><video-agent-player src="${SITE}/v/wideslugs"></video-agent-player><video-agent-player src="${SITE}/v/goneslugs"></video-agent-player></main>`,
  )
  // Playwright's text locators reach into open shadow roots.
  await expect(page.getByText('This video is not published.')).toBeVisible()
  await expect(page.getByText(/^Music:/)).toBeVisible()
  const results = await new AxeBuilder({ page }).include('video-agent-player').analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])
})
