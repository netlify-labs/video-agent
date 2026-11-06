// A video made for something outside the app (github-action plan §6.2) says so under its title: a link when the
// video has an externalUrl, plain text when it doesn't.
import { expect, test } from '@playwright/test'

test('shows "From GitHub" as a link with an externalUrl', async ({ page }) => {
  await page.goto('/videos/vid_webhooks')
  const line = page.getByTestId('external-ref')
  await expect(line).toHaveText('From GitHub: acme/web#123')
  await expect(line.getByRole('link', { name: 'acme/web#123' })).toHaveAttribute(
    'href',
    'https://github.com/acme/web/pull/123',
  )
})

test('shows it as text without one, and nothing for other videos', async ({ page }) => {
  await page.goto('/videos/vid_sales')
  const line = page.getByTestId('external-ref')
  await expect(line).toHaveText('From GitHub: acme/web@v2.4.0')
  await expect(line.getByRole('link')).toHaveCount(0)
  await page.goto('/videos/vid_teaser')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByTestId('external-ref')).toHaveCount(0)
})
