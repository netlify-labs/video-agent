// The calibration panel on the mock build's demo page (/dev/clock): the prompt on a new route, the clap-on-flash
// test (a synthetic listener claps 45 ms after each flash, with one outlier), persistence per route, and the manual
// Sync offset feeding the clip's offsetSamples.
import { expect, test } from '@playwright/test'

test('calibration: prompt on a new route, clap test, manual offset, per-route persistence', async ({ page }) => {
  await page.goto('/dev/clock')
  const panel = page.getByTestId('calibration-panel')
  await expect(panel.getByTestId('calibration-prompt')).toBeVisible()
  await expect(panel.getByText('provisional')).toBeVisible()

  await panel.getByRole('button', { name: 'Start clap test' }).click()
  await expect(panel.getByText(/Clap on each flash: \d of 8/)).toBeVisible()
  await expect(panel.getByTestId('calibration-result')).toHaveText(/^Latency 4[4-6] ms \(.*7 claps\)$/, { timeout: 15_000 })
  await expect(panel.getByTestId('calibration-prompt')).toBeHidden()
  const offsets = page.getByTestId('calibration-offsets')
  await expect(offsets).toHaveText(/^calibration -1[01]\d\d \+ manual 0 = /)

  // The manual Sync offset: +5 ms = 120 samples later, added to the calibration's.
  const slider = panel.getByRole('slider', { name: 'Sync offset' })
  await slider.focus()
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
  await expect(panel.getByTestId('sync-offset-value')).toHaveText('+5 ms (later)')
  await expect(offsets).toHaveText(/\+ manual 120 = /)
  const total = Number(await offsets.getAttribute('data-offset-samples'))
  await expect(offsets).toContainText(`starts at ${24_000 + total}`)

  // Kept for the route across a reload; another route has none and prompts.
  await page.reload()
  await expect(panel.getByTestId('calibration-prompt')).toBeHidden()
  await expect(panel.getByTestId('sync-offset-value')).toHaveText('+5 ms (later)')
  await page.getByText('44.1 kHz').click()
  await expect(panel).toHaveAttribute('data-route', 'demo-mic|default|44100')
  await expect(panel.getByTestId('calibration-prompt')).toBeVisible()
  await expect(offsets).toHaveText(/^calibration 0 \+ manual 0 = 0 /)
  await page.getByText('48 kHz').click()
  await expect(panel.getByTestId('calibration-prompt')).toBeHidden()

  // Invalidating the route prompts again.
  await page.getByRole('button', { name: 'Forget this route' }).click()
  await expect(panel.getByTestId('calibration-prompt')).toBeVisible()
})
