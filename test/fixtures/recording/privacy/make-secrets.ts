// The privacy fixture (test/recording-privacy.test.ts): a 6 s, 1280x720 screen recording of a settings page with known
// secrets. 0-3 s: an account page with an email, a Stripe-style key and a customer's name; 3-6 s: another page with
// none of them. Regenerate with `npx tsx test/fixtures/recording/privacy/make-secrets.ts` (needs Playwright's Chromium
// and ffmpeg); the MP4 is committed, so the test needs neither.
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

export const SECRETS = {
  email: 'ada.okafor@acme-labs.dev',
  key: 'sk_live_51HxQwErTyUiOpAsDfGhJk',
  name: 'Priya Raman',
}

const page = (body: string) =>
  `<html><body style="margin:0;font:16px system-ui,sans-serif;background:#fff;color:#111"><div style="padding:48px">${body}</div></body></html>`
const ACCOUNT = page(`<h1>Account settings</h1>
<p>Signed in as <b>${SECRETS.email}</b></p>
<p>Secret key: <code style="font-size:16px">${SECRETS.key}</code></p>
<p>Billing contact: ${SECRETS.name}</p>
<p>Plan: Pro · renews monthly</p>`)
const OTHER = page(`<h1>Deploys</h1><p>Production deploy finished in 42 seconds.</p><p>Preview deploys are on.</p>`)

const dir = mkdtempSync(join(tmpdir(), 'va-privacy-fixture-'))
const browser = await chromium.launch()
const tab = await browser.newPage({ viewport: { width: 1280, height: 720 } })
for (const [name, html] of [['a', ACCOUNT], ['b', OTHER]] as const) {
  await tab.setContent(html)
  await tab.screenshot({ path: join(dir, `${name}.png`) })
}
await browser.close()
const out = join(import.meta.dirname, 'secrets.mp4')
const r = spawnSync('ffmpeg', [
  ...['-loglevel', 'error', '-y'],
  ...['-loop', '1', '-t', '3', '-i', join(dir, 'a.png'), '-loop', '1', '-t', '3', '-i', join(dir, 'b.png')],
  ...['-filter_complex', '[0][1]concat=n=2:v=1[v]', '-map', '[v]', '-r', '30'],
  ...['-c:v', 'libx264', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-pix_fmt', 'yuv420p'],
  ...['-movflags', '+faststart', out],
])
if (r.status !== 0) throw new Error(String(r.stderr))
console.log(out)
