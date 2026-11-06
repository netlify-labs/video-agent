// The video page's progress line never shows a raw command's token (mock: localStorage.mockRawStep makes the
// progress step a raw render-job command with a fresh token, as an old server could send it). It shows the label.
import { expect, test } from '@playwright/test'

test('a raw render-job step shows as its label, never its token', async ({ page }) => {
  await page.addInitScript({ content: "localStorage.setItem('mockRawStep', '1')" })
  await page.goto('/videos/vid_making')
  const narration = page.getByTestId('narration')
  await expect(narration).toContainText('Rendering the video and uploading it')
  const token = await page.evaluate<string>('window.__mockRawToken ?? ""')
  expect(token.length).toBeGreaterThan(16)
  await expect(narration).not.toContainText(token)
  expect(await page.content()).not.toContain(token)
})
