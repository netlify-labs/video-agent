// vendor/va-recording.js in real Chromium (screen-recording plan §5.3; va-rsk5.3.8): the fixture in
// test/fixtures/recording-runtime/ is served by route (no server) with the vendored gsap.min.js, va-contract.js and
// va-recording.js; each test seeks a beat's registered timeline. Every case logs { case, t, expected, actual }.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const ROOT = join(import.meta.dirname, '..', '..')
const FIXTURE = join(ROOT, 'test', 'fixtures', 'recording-runtime')
const VENDOR = join(ROOT, 'video', 'vendor')

const CAMERA = [
  [2, 0.5, 0.5, 1],
  [3.4, 0.6, 0.31, 1.9, 'power2.inOut'],
  [10.9, 0.6, 0.31, 1.9],
  [12, 0.5, 0.5, 1, 'power2.inOut'],
]

interface Setup {
  duration?: number
  frame?: 'wallpaper' | 'none'
  camera?: unknown[]
  clicks?: unknown[]
  redact?: unknown[]
  cursor?: unknown[]
}

const logCase = (c: string, data: Record<string, unknown>) =>
  console.log(JSON.stringify({ test: 'recording-runtime', case: c, ...data }))

async function open(page: Page, s: Setup = {}) {
  let html = readFileSync(join(FIXTURE, 'index.html'), 'utf8')
    .replace('FRAME', s.frame ?? 'wallpaper')
    .replace('CAMERA', JSON.stringify(s.camera ?? CAMERA))
    .replace('CLICKS', JSON.stringify(s.clicks ?? [[4, 0.611, 0.304]]))
    .replace('REDACT', JSON.stringify(s.redact ?? []))
  if (s.duration)
    html = html
      .replace(
        'data-start="0" data-duration="7.5" data-va-authored-duration="7.5"',
        `data-start="0" data-duration="${String(s.duration)}" data-va-authored-duration="7.5"`,
      )
      .replace(
        'data-playback-rate="1.3333" muted data-start="0" data-duration="7.5"',
        `data-playback-rate="${String(Math.round((10 / s.duration) * 1e4) / 1e4)}" muted data-start="0" data-duration="${String(s.duration)}"`,
      )
  const warnings: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'warning') warnings.push(m.text())
  })
  await page.route('http://va.test/**', async (route) => {
    const path = new URL(route.request().url()).pathname.slice(1)
    if (path === '' || path === 'index.html') return route.fulfill({ body: html, contentType: 'text/html' })
    if (s.cursor && path === 'assets/recording/add-site.cursor.js')
      return route.fulfill({
        body: `window.__vaCursor=window.__vaCursor||{};window.__vaCursor["add-site"]=${JSON.stringify(s.cursor)};`,
        contentType: 'text/javascript',
      })
    const file = path.startsWith('vendor/') ? join(VENDOR, path.slice(7)) : join(FIXTURE, path)
    try {
      return await route.fulfill({
        body: readFileSync(file),
        ...(path.endsWith('.js') ? { contentType: 'text/javascript' } : {}),
      })
    } catch {
      return route.fulfill({ status: 404, body: '' })
    }
  })
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto('http://va.test/index.html')
  return warnings
}

/** Seeks one beat's timeline (and hides the other beat). Browser code is a string: the tests have no DOM types. */
const seek = (page: Page, beat: string, t: number) =>
  page.evaluate(`(() => {
    for (const el of document.querySelectorAll('[data-va-beat]'))
      el.style.visibility = el.getAttribute('data-va-beat') === ${JSON.stringify(beat)} ? 'visible' : 'hidden'
    window.__timelines[${JSON.stringify(beat)}].seek(${String(t)})
  })()`)

/** Opacity, 0 when hidden, -1 when there's no such element. */
const opacity = (page: Page, sel: string) =>
  page.evaluate<number>(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return -1
    const cs = getComputedStyle(el)
    return Number(cs.opacity) * (cs.visibility === 'hidden' ? 0 : 1)
  })()`)

const js = <T>(page: Page, code: string) => page.evaluate<T>(code)

test('retimed 7.5 -> 10 s: the ripple starts at (t_click - in) / rate, the camera ends with the scene', async ({
  page,
}) => {
  await open(page, { duration: 10 })
  const rate = 10 / 10
  const at = (4 - 2) / rate
  await seek(page, 'add-site', at - 1 / 30)
  const before = await opacity(page, '.va-ripple')
  await seek(page, 'add-site', at + 1 / 30)
  const after = await opacity(page, '.va-ripple')
  logCase('ripple', { t: at, expected: 'starts', actual: { before, after } })
  expect(before).toBe(0)
  expect(after).toBeGreaterThan(0)
  const duration = await js<number>(page, `window.__timelines['add-site'].duration()`)
  logCase('camera-end', { t: 10, expected: 10, actual: duration })
  expect(duration).toBeCloseTo(10, 3)
  // At the end the camera is back at zoom 1.
  await seek(page, 'add-site', 10)
  const scale = await js<number>(
    page,
    `Number(getComputedStyle(document.querySelector('.va-stage')).transform.split(',')[3])`,
  )
  expect(scale).toBeCloseTo(1, 3)
})

test('locked boxes step from key to key with no easing; a zero-size key hides the box', async ({ page }) => {
  await open(page)
  const top = (i: number) => js<string>(page, `document.querySelectorAll('.va-hide')[${String(i)}].style.top`)
  // Source 9.0 / 9.11 / 9.2 s in a 2-12 s slot over 7.5 s.
  const real = (s: number) => ((s - 2) / 10) * 7.5
  const cases: [number, string][] = [
    [9.0, '52%'],
    [9.11, '12%'],
    [9.2, '12%'],
  ]
  for (const [s, want] of cases) {
    await seek(page, 'add-site', real(s))
    const got = await top(0)
    logCase('locked-step', { t: s, expected: want, actual: got })
    expect(got).toBe(want)
  }
  await seek(page, 'add-site', real(4))
  const second = () =>
    js<string>(page, `getComputedStyle(document.querySelectorAll('.va-hide')[1]).visibility`)
  expect(await second()).toBe('visible')
  await seek(page, 'add-site', real(6))
  logCase('zero-size', { t: 6, expected: 'hidden', actual: await second() })
  expect(await second()).toBe('hidden')
})

test('hidden areas blur the picture by default, solid when asked, with no label', async ({ page }) => {
  await open(page, {
    redact: [{ id: 'a1', start: 0, end: 12, style: 'solid', boxes: [[0, 0.1, 0.1, 0.2, 0.1]] }],
  })
  await seek(page, 'add-site', 1)
  const looks = await js<{ cls: string; backdrop: string; bg: string; text: string }[]>(
    page,
    `[...document.querySelectorAll('[data-va-beat="add-site"] .va-hide')].map((e) => {
      const cs = getComputedStyle(e)
      return { cls: e.className, backdrop: cs.backdropFilter, bg: cs.backgroundColor, text: e.textContent }
    })`,
  )
  logCase('hide-style', { expected: 'blur, blur, solid', actual: looks.map((l) => l.cls) })
  // The two locked boxes (no style: blur), then the scene's solid one.
  expect(looks.map((l) => l.cls)).toEqual([
    'va-hide va-hide-blur',
    'va-hide va-hide-blur',
    'va-hide va-hide-solid',
  ])
  expect(looks[0]?.backdrop).toBe('blur(16px) brightness(0.82)')
  expect(looks[2]?.backdrop).toBe('none')
  expect(looks[2]?.bg).not.toBe('rgba(0, 0, 0, 0)')
  expect(looks.every((l) => l.text === '')).toBe(true)
})

test('a hidden area never outlives its scene: hidden when the scene is, and outside its own span', async ({
  page,
}) => {
  // A box over source 3-5 s only, in a 2-12 s slot over 7.5 s.
  await open(page, { redact: [{ id: 'a1', start: 3, end: 5, boxes: [[3, 0.1, 0.1, 0.2, 0.1]] }] })
  const real = (s: number) => ((s - 2) / 10) * 7.5
  const shown = (t: number) =>
    seek(page, 'add-site', real(t)).then(() => opacity(page, '.va-hide:last-of-type'))
  const cases: [string, number, boolean][] = [
    ['before its span', 2.9, false],
    ['in its span', 4, true],
    ['after its span', 5.1, false],
  ]
  for (const [name, t, want] of cases) {
    const got = (await shown(t)) > 0
    logCase('scene-bound', { case: name, t, expected: want, actual: got })
    expect(got, name).toBe(want)
  }
  // The scene cut away (HyperFrames hides the beat): its boxes go with it, whatever their own state.
  await seek(page, 'add-site', real(4))
  await page.evaluate(`document.querySelector('[data-va-beat="add-site"]').style.visibility = 'hidden'`)
  const after = await js<string[]>(
    page,
    `[...document.querySelectorAll('.va-hide')].map((e) => getComputedStyle(e).visibility)`,
  )
  logCase('scene-cut', { expected: 'all hidden', actual: after })
  expect(after.every((v) => v === 'hidden')).toBe(true)
})

test('cursor points outside the span (left by a span edit) are skipped quietly', async ({ page }) => {
  const warnings = await open(page, {
    cursor: [
      [0.5, 0.1, 0.1],
      [2, 0.2, 0.2],
      [4, 0.611, 0.304],
      [12, 0.4, 0.6],
      [14, 0.9, 0.9],
    ],
  })
  await seek(page, 'add-site', 3)
  logCase('cursor past span', { expected: 0, actual: warnings.length })
  expect(warnings.filter((w) => w.includes('va-recording'))).toEqual([])
  expect(
    await page.evaluate(
      `getComputedStyle(document.querySelector('[data-va-beat="add-site"] .va-cursor')).visibility`,
    ),
  ).toBe('visible')
})

test('malformed camera, clicks and redact entries are skipped and logged, never thrown', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const warnings = await open(page, {
    camera: [...CAMERA, ['x', 0.5, 0.5, 1], [5, 2, 0.5, 1]],
    clicks: [[4, 0.611, 0.304], 'nope', [3, 0.5]],
    redact: [{ start: 0, end: 12, boxes: [[0, 0.5, 0.5, 2, 0.1]] }, { start: 'a' }],
  })
  await seek(page, 'add-site', 3)
  logCase('malformed', { expected: 'warnings', actual: warnings.length })
  expect(errors).toEqual([])
  expect(warnings.length).toBeGreaterThanOrEqual(6)
  // The two locked boxes; neither malformed scene entry.
  expect(await page.locator('[data-va-beat="add-site"] .va-ripple').count()).toBe(1)
  expect(await page.locator('[data-va-beat="add-site"] .va-hide').count()).toBe(2)
})

test('the held still shows only after the slot ends', async ({ page }) => {
  await open(page)
  for (const [t, want] of [
    [3.9, false],
    [4.1, true],
    [5.9, true],
  ] as const) {
    await seek(page, 'held', t)
    const shown = (await opacity(page, 'img.va-rec-hold')) > 0
    logCase('hold', { t, expected: want, actual: shown })
    expect(shown).toBe(want)
  }
})

test('wallpaper insets the window by 6%; none is full bleed', async ({ page }) => {
  const box = async (frame: 'wallpaper' | 'none') => {
    await open(page, { frame })
    await seek(page, 'add-site', 0)
    return page.locator('[data-va-beat="add-site"] .va-window').boundingBox()
  }
  const wall = await box('wallpaper')
  const none = await box('none')
  logCase('frame', { expected: { wallpaper: 115.2, none: 0 }, actual: { wall, none } })
  expect(wall?.x).toBeCloseTo(1920 * 0.06, 0)
  expect(wall?.width).toBeCloseTo(1920 * 0.88, 0)
  expect(none).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
})

test('seeking backwards and forwards gives identical pixels', async ({ page }) => {
  await open(page)
  await seek(page, 'add-site', 3)
  const a = await page.screenshot()
  await seek(page, 'add-site', 7)
  await seek(page, 'add-site', 0.5)
  await seek(page, 'add-site', 3)
  const b = await page.screenshot()
  logCase('seek', { t: 3, expected: 'same pixels', actual: a.equals(b) })
  expect(a.equals(b)).toBe(true)
})
