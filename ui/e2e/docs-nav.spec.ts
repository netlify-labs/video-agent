// The docs nav (cli-and-sdk plan §8): the sidebar's API docs group lists every docs page under Build, AI tools and
// Guides, from one list (ui/src/pages/docs/nav.ts), on wide screens and in the phone menu.
import { expect, test, type Page } from '@playwright/test'

const navbar = (page: Page) => page.locator('.mantine-AppShell-navbar')

test('the docs pages are grouped, and each group links to its pages', async ({ page }) => {
  await page.goto('/docs/mcp')
  await expect(page.getByRole('heading', { level: 1, name: 'MCP for AI tools' })).toBeVisible()
  const burger = page.getByRole('banner').getByRole('button', { name: 'Menu' })
  if (await burger.isVisible()) await burger.click()
  const nav = navbar(page)
  const groups = {
    Build: ['REST API', 'TypeScript SDK', 'CLI'],
    'AI tools': ['MCP for AI tools', 'Agent skills', 'WebMCP in the browser'],
    Guides: ['Publish destinations', 'Looks', 'GitHub Action'],
  }
  for (const [group, links] of Object.entries(groups)) {
    const g = nav.getByRole('group', { name: group })
    await expect(g).toBeVisible()
    await expect(g.getByRole('link')).toHaveText(links)
  }
  await expect(
    nav.getByRole('group', { name: 'AI tools' }).getByRole('link', { name: 'MCP for AI tools' }),
  ).toHaveAttribute('aria-current', 'page')
  await nav.getByRole('group', { name: 'Guides' }).getByRole('link', { name: 'Publish destinations' }).click()
  await expect(page).toHaveURL(/\/docs\/destinations$/)
})
