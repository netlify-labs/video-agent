// Spike E4, step 3 (render-engines plan §11, bead va-ed2s.1.4): does @remotion/player run inside the /preview sandbox
// CSP? Cold start, CSP violations, seek accuracy against the renderer's own MP4 (SSIM at beat midpoints, as S7), and
// the apply-edits round trip. Chromium and WebKit, like S2.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { start } from './server.js'

const here = dirname(fileURLToPath(import.meta.url))
const work = join(here, '.work')
const built = JSON.parse(readFileSync(join(work, 'build.json'), 'utf8')) as {
  sizes: Record<string, number>
  seeks: { beat: string; time: number; frame: string }[]
}
const props = JSON.parse(readFileSync(join(here, '..', 'e3', 'project', 'props.json'), 'utf8')) as {
  beats: { texts: Record<string, { text: string }> }[]
}
const log = (step: string, f: Record<string, unknown>) => {
  console.log(JSON.stringify({ step, ...f }))
}

type Msg = { type: string; at: number; time?: number; rev?: number; csp?: unknown; message?: string }
const msgs = (page: Page) => page.evaluate(() => (window as unknown as { __msgs: Msg[] }).__msgs)
const ssimOf = (a: string, b: string) => {
  // WebKit screenshots at 2x: scale both to the reference size first.
  const out = execFileSync(
    'sh',
    [
      '-c',
      `ffmpeg -hide_banner -i '${a}' -i '${b}' -lavfi '[0]scale=960:540[x];[1]scale=960:540[y];[x][y]ssim' -f null - 2>&1`,
    ],
    { encoding: 'utf8' },
  )
  return Number(/All:([\d.]+)/.exec(out)?.[1] ?? 'NaN')
}

for (const variant of ['default', 'tags=0'] as const)
  test(`the Remotion Player in the preview sandbox (${variant})`, async ({ page, browserName }) => {
    const server = await start()
    const results: Record<string, unknown> = { browser: browserName, variant, sizes: built.sizes }
    try {
      await page.goto(`${server.url}/app/host.html${variant === 'default' ? '' : `#${variant}`}`)
      await expect
        .poll(async () => (await msgs(page)).some((m) => m.type === 'ready'), { timeout: 30_000 })
        .toBe(true)
      const loadedAt = await page.evaluate(() => (window as unknown as { __loadedAt: number }).__loadedAt)
      results.coldStartMs = Math.round(
        ((await msgs(page)).find((m) => m.type === 'ready')?.at ?? 0) - loadedAt,
      )

      // Seek accuracy: the iframe's picture at each beat midpoint against the renderer's frame.
      const frame = page.locator('#preview')
      const seeks: Record<string, unknown>[] = []
      for (const s of built.seeks) {
        await page.evaluate(
          (t) => (window as unknown as { __send: (m: object) => void }).__send({ type: 'seek', time: t }),
          s.time,
        )
        await expect
          .poll(async () =>
            (await msgs(page)).some((m) => m.type === 'time' && Math.abs((m.time ?? -1) - s.time) < 0.02),
          )
          .toBe(true)
        // Let OffthreadVideo's <video> land on its frame.
        await page.waitForTimeout(1000)
        const shot = join(work, `${browserName}-${variant}-${s.beat}.png`)
        await frame.screenshot({ path: shot })
        seeks.push({ beat: s.beat, time: s.time, ssim: ssimOf(shot, s.frame) })
      }
      results.seeks = seeks

      // apply-edits: new props in, edits-applied out, and the picture changes.
      const before = join(work, `${browserName}-${variant}-before-edit.png`)
      await page.evaluate(
        (t) => (window as unknown as { __send: (m: object) => void }).__send({ type: 'seek', time: t }),
        built.seeks[0]?.time ?? 1.5,
      )
      await page.waitForTimeout(500)
      await frame.screenshot({ path: before })
      const edited = structuredClone(props)
      const title = edited.beats[0]?.texts['intro-title']
      if (title) title.text = 'Edited live in the Player'
      const sentAt = await page.evaluate((p) => {
        ;(window as unknown as { __send: (m: object) => void }).__send({
          type: 'apply-edits',
          props: p,
          rev: 7,
        })
        return performance.now()
      }, edited)
      await expect
        .poll(async () => (await msgs(page)).some((m) => m.type === 'edits-applied' && m.rev === 7))
        .toBe(true)
      const appliedAt = (await msgs(page)).find((m) => m.type === 'edits-applied')?.at ?? 0
      const after = join(work, `${browserName}-${variant}-after-edit.png`)
      await frame.screenshot({ path: after })
      results.applyEdits = {
        roundTripMs: Math.round(appliedAt - sentAt),
        pictureChanged: ssimOf(before, after) < 0.999,
      }

      // Playback: play for a second, time moves.
      await page.evaluate(() =>
        (window as unknown as { __send: (m: object) => void }).__send({ type: 'play' }),
      )
      await page.waitForTimeout(1200)
      await page.evaluate(() =>
        (window as unknown as { __send: (m: object) => void }).__send({ type: 'pause' }),
      )
      const times = (await msgs(page)).filter((m) => m.type === 'time').map((m) => m.time ?? 0)
      results.playbackAdvanced = Math.max(...times) > (built.seeks[0]?.time ?? 0) + 0.5

      const errors = (await msgs(page)).filter((m) => m.type === 'error')
      const csp = errors.filter((m) => m.csp).map((m) => JSON.stringify(m.csp))
      results.cspViolations = [...new Set(csp)].map((c) => ({
        ...(JSON.parse(c) as object),
        count: csp.filter((x) => x === c).length,
      }))
      results.errors = errors.filter((m) => !m.csp).map((m) => m.message)
      log('e4', results)
      writeFileSync(
        join(work, `results-${browserName}-${variant.replace('=', '')}.json`),
        JSON.stringify(results, null, 2),
      )
      // The default pool's silent data: audio is what media-src refuses; with the pool off there must be none.
      if (variant === 'tags=0') expect(results.cspViolations).toEqual([])
      expect(results.errors).toEqual([])
    } finally {
      await server.close()
    }
  })
