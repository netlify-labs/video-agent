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

test('a long context starts clamped, opens with Show all, and can be copied', async ({ page }) => {
  const text = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of the pull request's description.`).join(
    '\n',
  )
  // The mock answers from window.fetch: wrap whatever it installs, and lengthen vid_webhooks' context.
  await page.addInitScript((long) => {
    let inner = globalThis.fetch.bind(globalThis)
    const wrapped: typeof fetch = async (input, init) => {
      const res = await inner(input, init)
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!new URL(url, 'http://localhost').pathname.endsWith('/api/v1/videos/vid_webhooks')) return res
      const body = (await res.json()) as { versions: { context: { text: string } | null }[] }
      for (const v of body.versions) if (v.context) v.context.text = long
      return Response.json(body)
    }
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      get: () => wrapped,
      set: (f: typeof fetch) => {
        inner = f
      },
    })
  }, text)
  await page.goto('/videos/vid_webhooks')
  await page.getByTestId('details-card').getByRole('button', { name: 'Everything it was made with' }).click()
  const modal = page.getByTestId('version-details')
  const context = modal.getByTestId('version-context')
  // Clamped to 12 lines at first (Mantine marks it data-line-clamp); Show all lifts the clamp, and the box scrolls.
  await expect(context).toHaveAttribute('data-line-clamp', 'true')
  await modal.getByRole('button', { name: 'Show all (40 lines)' }).click()
  await expect(context).not.toHaveAttribute('data-line-clamp')
  await expect(context).toContainText('Line 40 of')
  await modal.getByRole('button', { name: 'Show less' }).click()
  await expect(context).toHaveAttribute('data-line-clamp', 'true')
  await expect(modal.getByRole('button', { name: 'Copy' })).toHaveCount(2) // the prompt's and the context's
})
