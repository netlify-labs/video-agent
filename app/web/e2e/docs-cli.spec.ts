// /docs/cli (cli-and-sdk plan §8; bead va-p1th.7.2): this site's URL in the commands, the package name, a row for every
// ready command from the catalog, the exit codes and the local-mode section.
import { expect, test } from '@playwright/test'
import { COMMANDS } from '../../../packages/cli/src/catalog.js'
import { EXIT } from '../../../packages/cli/src/exit.js'

test('the CLI page fills in this site and lists every command and exit code', async ({ page, baseURL }) => {
  await page.goto('/docs/cli')
  await expect(page.getByRole('heading', { level: 1, name: 'CLI' })).toBeVisible()
  await expect(page.getByText('npm install -g netlify-video-agent')).toBeVisible()
  await expect(page.getByText(`video-agent login --url ${baseURL}`).first()).toBeVisible()
  await expect(page.getByText(`export VIDEO_AGENT_URL=${baseURL}`)).toBeVisible()
  for (const c of COMMANDS.filter((x) => x.ready && x.name !== 'help' && x.name !== 'version'))
    await expect(page.locator(`[data-command="${c.name}"]`), c.name).toHaveCount(1)
  for (const code of Object.values(EXIT)) await expect(page.locator(`[data-exit="${code}"]`)).toHaveCount(1)
  await expect(page.getByText('The agent runs in its sandbox')).toBeVisible()
  await expect(page.getByText(/requests to localhost, private and link-local addresses/)).toBeVisible()
  await expect(page.locator('#record')).toHaveCount(1)
  // Nothing spills sideways on a phone.
  const fits = await page.evaluate(() => {
    const w = globalThis as unknown as {
      innerWidth: number
      document: { documentElement: { scrollWidth: number } }
    }
    return w.document.documentElement.scrollWidth <= w.innerWidth + 1
  })
  expect(fits).toBe(true)
})
