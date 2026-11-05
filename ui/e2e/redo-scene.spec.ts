// Redo a scene in the web app (docs/plans/2026-11-04-regenerate-beat.md §4.12; beads va-8cy4.4.1 and 4.4.4), against
// the mock build: the revise panel's Whole video / Some scenes choice and its scene chips, the limits the chips
// follow, the history label of a scoped version, and the way out of a scope refusal.
import { expect, test, type Page } from '@playwright/test'

const mock = (page: Page, key: string, value = '1') =>
  page.addInitScript(({ k, v }) => localStorage.setItem(k, v), { k: key, v: value })
const lastRevise = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { __lastRevise?: Record<string, unknown> }).__lastRevise)
const scope = (page: Page) => page.getByTestId('revise-scope')
// A chip's checkbox is visually hidden: its state is read from the checkbox, clicks and hovers go to its label.
const chip = (page: Page, name: string | RegExp) =>
  page.getByTestId('scene-picker').getByRole('checkbox', { name })
const pick = (page: Page, name: string | RegExp) =>
  page.getByTestId('scene-picker').locator('label').filter({ hasText: name })

test('Some scenes lists the shown version’s scenes and sends scope with fromVersion', async ({ page }) => {
  await page.goto('/videos/vid_teaser')
  await expect(scope(page).getByText('Whole video')).toBeVisible()
  await expect(page.getByLabel('Sound')).toBeVisible()
  await scope(page).getByText('Some scenes').click()
  await expect(pick(page, '1. Hook · 0:00–0:02')).toBeVisible()
  await expect(pick(page, '4. End card · 0:06–0:08')).toBeVisible()
  // Length, sound, voice and plan stay the parent's: their controls go, with one line saying so.
  await expect(page.getByText('Length, sound and voice stay as they are.')).toBeVisible()
  await expect(page.getByLabel('Sound')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Plan it first' })).toHaveCount(0)
  await page.getByLabel('What should change?').fill('Make these two scenes brighter.')
  await expect(page.getByRole('button', { name: 'Make v3' })).toBeDisabled()
  await pick(page, /Problem/).click()
  await pick(page, /Hook/).click()
  await page.getByRole('button', { name: 'Make v3' }).click()
  await expect
    .poll(() => lastRevise(page))
    .toMatchObject({
      prompt: 'Make these two scenes brighter.',
      fromVersion: 2,
      scope: { beats: ['hook', 'problem'] },
    })
  expect(await lastRevise(page)).not.toHaveProperty('sound')
})

test('the chips follow the server’s rules: all but one picked, the held frame', async ({ page }) => {
  await page.goto('/videos/vid_teaser')
  await scope(page).getByText('Some scenes').click()
  for (const n of ['Hook', 'Problem', 'Demo']) await pick(page, new RegExp(n)).click()
  await expect(chip(page, /End card/)).toBeDisabled()
  await pick(page, /End card/).hover()
  await expect(page.getByText("That's every scene: choose Whole video instead")).toBeVisible()

  // v3 ends on a held frame under recorded narration: va-hold is never a chip, the scene it holds can't be picked.
  await mock(page, 'mockRedo')
  await page.goto('/videos/vid_teaser')
  await expect(page.getByTestId('video-actions')).toBeVisible()
  await scope(page).getByText('Some scenes').click()
  await expect(page.getByTestId('scene-picker').getByRole('checkbox')).toHaveCount(4)
  await expect(chip(page, /End card/)).toBeDisabled()
  await pick(page, /End card/).hover()
  await expect(page.getByText('holds its last frame; redo it with a whole-video revision')).toBeVisible()
})

test('a version that can’t be redone scene by scene says why; no scoped_revision hides the choice', async ({
  page,
}) => {
  await page.goto('/videos/vid_teaser')
  // v1 doesn't keep the editing contract.
  await page.getByRole('button', { name: /^v1/ }).click()
  await expect(scope(page).getByRole('radio', { name: 'Some scenes' })).toBeDisabled()
  await expect(
    page.getByText("This version doesn't keep the editing contract, so it can only be revised whole."),
  ).toBeVisible()

  await mock(page, 'mockNoScopedRevision')
  await page.goto('/videos/vid_teaser')
  await expect(page.getByLabel('What should change?')).toBeVisible()
  await expect(scope(page)).toHaveCount(0)
})

test('a refusal from the server is shown as written', async ({ page }) => {
  await mock(
    page,
    'mockScopeError',
    'There\'s no scene "intro". This video\'s scenes: hook (Hook), demo (Demo).',
  )
  await page.goto('/videos/vid_teaser')
  await scope(page).getByText('Some scenes').click()
  await pick(page, /Demo/).click()
  await page.getByLabel('What should change?').fill('Redo the demo.')
  await page.getByRole('button', { name: 'Make v3' }).click()
  await expect(
    page.getByText('There\'s no scene "intro". This video\'s scenes: hook (Hook), demo (Demo).'),
  ).toBeVisible()
})

test('history names the scenes a version redid; a scope refusal offers Revise the whole video', async ({
  page,
}) => {
  await mock(page, 'mockRedo')
  await page.goto('/videos/vid_teaser')
  await expect(page.getByTestId('version-scope')).toHaveText(['Redid Problem', 'Redid Demo'])
  await page.getByRole('button', { name: /v4 from v3/ }).click()
  await expect(page.getByText('This run changed parts of the video outside the scenes').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
  await page.getByRole('button', { name: 'Revise the whole video' }).click()
  // The panel starts from v3, on Whole video, with the request filled in.
  await expect(page.getByText('Starts from v3')).toBeVisible()
  await expect(page.getByLabel('What should change?')).toHaveValue('Make the problem scene darker.')
  await expect(scope(page).getByRole('radio', { name: 'Whole video' })).toBeChecked()
})
