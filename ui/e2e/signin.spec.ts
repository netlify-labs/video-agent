// The sign-in screen's layout (both projects: desktop and phone). On phones the powered-by badge stops floating and
// closes the page, so it must sit under the card: beside it, it squeezed the card and cut off "Sign in with Netlify".
import { expect, test, type Page } from '@playwright/test'

const mock = (page: Page, key: string, value = '1') =>
  page.addInitScript(({ k, v }) => localStorage.setItem(k, v), { k: key, v: value })

test('sign-in: the card is centred and whole, the button label fits, the badge never sits beside it', async ({
  page,
}) => {
  await mock(page, 'mockSignedOut')
  await mock(page, 'mockAuthProvider', 'netlify')
  await page.goto('/')
  const button = page.getByRole('link', { name: 'Sign in with Netlify' })
  await expect(button).toBeVisible()
  // The label isn't clipped: the button is at least as wide as its content.
  const fits = await button.evaluate((el) => {
    const e = el as unknown as { scrollWidth: number; clientWidth: number }
    return e.scrollWidth <= e.clientWidth
  })
  expect(fits).toBe(true)
  const card = (await page.locator('.mantine-Card-root').first().boundingBox())!
  const badge = (await page.locator('a.va-powered').boundingBox())!
  const viewport = page.viewportSize()!
  // Centred horizontally (within a couple of pixels).
  expect(Math.abs(card.x + card.width / 2 - viewport.width / 2)).toBeLessThan(3)
  // Never beside the card: either below it (phones) or in the corner, clear of it (desktop).
  const overlapsVertically = badge.y < card.y + card.height && badge.y + badge.height > card.y
  expect(overlapsVertically && badge.x < card.x + card.width + 8).toBe(false)
})
