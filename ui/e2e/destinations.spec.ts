// Publish destinations (docs/plans/2026-11-04-publish-destinations.md §6.2), on the mock: "Publish to" opens a
// destination's dialog (where, options, instructions worded by the destination), the version's "Published to" row
// moves to live, a one-time secret is revealed once; and Admin adds an HTTP destination, shows its secret once, and
// tests it.
import { expect, test } from '@playwright/test'

test('publish a version to a destination: an existing site, instructions, then reveal the password once', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('mockDestinations', '1')
  })
  await page.goto('/videos/vid_teaser')
  await page.getByRole('button', { name: 'Publish to' }).click()
  await page.getByRole('menuitem', { name: /Netlify site/ }).click()
  const dialog = page.getByRole('dialog', { name: /Publish v2 to Netlify site/ })
  await expect(dialog).toBeVisible()
  // Where: "New site" by default, then the destination's own sites, worded with its noun.
  await expect(dialog.getByRole('radio', { name: 'New site' })).toBeChecked()
  await expect(dialog).toContainText('Your sites')
  await expect(dialog).toContainText('2 videos · updated yesterday')
  // The options form and the instructions box, labelled by the destination.
  await dialog.getByLabel('Site name').fill('acme-teaser')
  await dialog.getByLabel('Password-protect the site').check()
  await expect(dialog.getByLabel('Where should the video go?')).toBeVisible()
  await expect(dialog).toContainText('An agent will edit the site to place it.')
  await dialog.getByRole('radio', { name: /acme-launch/ }).check()
  await dialog.getByLabel('Where should the video go?').fill('In the hero, above the pricing table.')
  await dialog.getByRole('button', { name: 'Publish' }).click()
  await expect(dialog).toHaveCount(0)
  const sent = await page.evaluate('window.__lastDestPublish')
  expect(sent).toMatchObject({
    destination: 'dst_sites',
    options: { name: 'acme-teaser', password: true },
    target: { id: 'site-launch', name: 'acme-launch', metadata: { videos: 2 } },
    instructions: 'In the hero, above the pricing table.',
  })
  // Published to: processing with the destination's message, then live.
  const row = page.getByTestId('published-to-row').first()
  await expect(row).toContainText('Netlify site · acme-launch')
  await expect(row).toContainText('Live', { timeout: 15_000 })
  await expect(row.getByRole('link', { name: 'Open' })).toHaveAttribute(
    'href',
    'https://acme-launch.netlify.app',
  )
  // Reveal the password once; the button is gone after.
  await row.getByRole('button', { name: 'Reveal site password' }).click()
  const secret = page.getByRole('dialog', { name: 'Site password' })
  await expect(secret.getByLabel('Site password')).toHaveValue('mock-password-4821')
  await expect(secret).toContainText("You won't see this again")
  await page.keyboard.press('Escape')
  await expect(row.getByRole('button', { name: 'Reveal site password' })).toHaveCount(0, { timeout: 10_000 })
  // Remove it.
  await row.getByRole('button', { name: 'Remove' }).click()
  await page
    .getByRole('dialog', { name: /Remove it from Netlify site/ })
    .getByRole('button', { name: 'Remove' })
    .click()
  await expect(page.getByTestId('published-to-row')).toHaveCount(0, { timeout: 15_000 })
})

test('without destinations, publishing looks exactly as before', async ({ page }) => {
  await page.goto('/videos/vid_teaser')
  await expect(page.getByRole('button', { name: 'Publish to' })).toHaveCount(0)
})

test('admin adds an HTTP destination, sees its secret once, and tests it', async ({ page }) => {
  await page.goto('/admin')
  const card = page.locator('.mantine-Card-root', { hasText: 'Destinations' }).first()
  await card.getByRole('button', { name: 'Add HTTP destination' }).click()
  const add = page.getByRole('dialog', { name: 'Add an HTTP destination' })
  await add.getByLabel('Name', { exact: true }).fill('Demo sites')
  await add.getByLabel('URL', { exact: true }).fill('https://receiver.example.com/hook')
  await add.getByLabel(/Options form/).fill('{ "type": "object" ')
  await expect(add).toContainText('Not valid JSON.')
  await add
    .getByLabel(/Options form/)
    .fill('{ "type": "object", "properties": { "name": { "type": "string" } } }')
  await add.getByRole('button', { name: 'Add' }).click()
  const secret = page.getByRole('dialog', { name: 'Signing secret' })
  await expect(secret.getByLabel('Signing secret')).toHaveValue('dsec_mock_shown_once_3f9a')
  await page.keyboard.press('Escape')
  const row = page.getByTestId('admin-destination')
  await expect(row).toContainText('Demo sites')
  await expect(row).toContainText('receiver.example.com')
  await row.getByRole('button', { name: 'Send a test' }).click()
  await expect(page.getByText(/It answered; it supports/)).toBeVisible()
})

test('the destination contract page renders its sections, test vector and example receiver', async ({
  page,
}) => {
  await page.goto('/docs/destinations')
  await expect(page.getByRole('heading', { name: 'Publish destinations' })).toBeVisible()
  for (const s of [
    'Requests',
    'Verifying requests',
    'Responses',
    'Callbacks',
    'Targets and capabilities',
    'Example receiver',
  ])
    await expect(page.getByRole('heading', { name: s, exact: true }).first()).toBeVisible()
  await expect(
    page.locator(
      'input[value="t=1793851200,v1=0db259af6f8334771d231e68f830b828fdd6a9f375540ee233d0cd6d51883d7c"]',
    ),
  ).toBeVisible()
  await expect(page.getByText('export function createReceiver').first()).toBeVisible()
})
