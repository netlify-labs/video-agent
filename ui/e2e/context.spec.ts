// Background a version was made with (github-action plan §6.1): the Details card names it, and "How v1 was made"
// shows its text read-only with a link to where it came from. Versions without it show neither.
import { expect, test } from '@playwright/test'

test('a version made with context names it and shows it in the details', async ({ page }) => {
  await page.goto('/videos/vid_webhooks')
  const card = page.getByTestId('details-card')
  await expect(card).toContainText('GitHub PR #123')
  await card.getByRole('button', { name: 'Everything it was made with' }).click()
  const modal = page.getByTestId('version-details')
  await expect(modal).toContainText('Context from GitHub PR #123')
  await expect(modal.getByTestId('version-context')).toContainText('Teams can subscribe to events')
  await expect(modal.getByRole('link', { name: 'Open' })).toHaveAttribute(
    'href',
    'https://github.com/acme/web/pull/123',
  )
})

test('a version without context shows none', async ({ page }) => {
  await page.goto('/videos/vid_teaser')
  await page.getByTestId('details-card').getByRole('button', { name: 'Everything it was made with' }).click()
  await expect(page.getByTestId('version-details')).toBeVisible()
  await expect(page.getByTestId('version-context')).toHaveCount(0)
})
