// The published version's Player snippet (cli-and-sdk plan §7 "Where it shows up"): shown next to the plain embed,
// pointing at this site's /player.js and the share page, and copyable.
import { expect, test } from '@playwright/test'

test('a published version offers the player snippet next to the embed, and copies it', async ({
  page,
  context,
  baseURL,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'Clipboard permissions are a desktop check.')
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/videos/vid_webhooks')
  const field = page.getByRole('textbox', { name: 'Player' })
  await expect(field).toHaveValue(new RegExp(`^<script type="module" src="${baseURL}/player\\.js"></script>`))
  await expect(field).toHaveValue(
    new RegExp(`<video-agent-player src="${baseURL}/v/[a-z0-9]+"></video-agent-player>$`),
  )
  await expect(page.getByRole('textbox', { name: 'Embed' })).toBeVisible()
  await field.evaluate("(el) => el.scrollIntoView({ block: 'center' })")
  await page.getByRole('button', { name: 'Copy Player' }).click()
  const copied = await page.evaluate('navigator.clipboard.readText()')
  expect(copied).toBe(await field.inputValue())
})
