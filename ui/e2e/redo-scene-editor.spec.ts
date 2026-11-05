// Redo a scene from the editor (docs/plans/2026-11-04-regenerate-beat.md, after the gate; beads va-8cy4.5.7 and
// 5.8), against the mock build: a beat card's Redo icon and a timeline scene block's menu open the scoped dialog
// with that scene picked, warn when the draft has changes it won't include, and redo from the rendered version.
// The mock editor's scenes are the contract fixture's (intro, demo, outro); only demo is also one of v2's scenes.
import { expect, test, type Page } from '@playwright/test'

const lastRevise = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { __lastRevise?: Record<string, unknown> }).__lastRevise)
const redoButton = (page: Page, beat: string) =>
  page.getByTestId(`beat-${beat}`).getByRole('button', { name: /^Redo .*…$/ })

test('a beat card’s Redo opens the dialog with that scene, and redoes it from the rendered version', async ({
  page,
}) => {
  await page.goto('/videos/vid_teaser/edit/2')
  await expect(page.getByTestId('beat-demo')).toBeVisible()
  // Only scenes of the rendered version can be redone.
  await expect(redoButton(page, 'demo')).toBeVisible()
  await expect(redoButton(page, 'intro')).toHaveCount(0)
  await redoButton(page, 'demo').click()
  const dialog = page.getByRole('dialog', { name: 'Redo part of v2' })
  await expect(dialog.getByRole('checkbox', { name: /Demo/ })).toBeChecked()
  await expect(dialog.getByTestId('redo-warning')).toHaveCount(0)
  expect(await lastRevise(page)).toBeUndefined()
  await dialog.getByRole('textbox', { name: 'What should change?' }).fill('Make the demo faster.')
  await dialog.getByRole('button', { name: 'Make v3' }).click()
  await expect(page).toHaveURL(/\/videos\/vid_teaser$/)
  expect(await lastRevise(page)).toEqual({
    prompt: 'Make the demo faster.',
    fromVersion: 2,
    scope: { beats: ['demo'] },
  })
})

test('with changes in the draft, the dialog says they aren’t included', async ({ page }) => {
  await page.goto('/videos/vid_teaser/edit/2')
  const length = page.getByRole('textbox', { name: /^Length of .*demo/i })
  await length.fill('4')
  await length.blur()
  await redoButton(page, 'demo').click()
  await expect(page.getByTestId('redo-warning')).toContainText(
    "This starts from v2 as rendered; your draft's changes aren't included.",
  )
})

test('a timeline scene block’s menu offers Redo this scene…', async ({ page }) => {
  await page.goto('/videos/vid_teaser/edit/2')
  const scenes = page.getByRole('group', { name: 'Scenes lane' })
  await expect(scenes).toBeVisible()
  await expect(scenes.getByRole('button', { name: /actions$/ })).toHaveCount(1)
  await scenes.getByRole('button', { name: /actions$/ }).click()
  await page.getByRole('menuitem', { name: 'Redo this scene…' }).click()
  await expect(
    page.getByRole('dialog', { name: 'Redo part of v2' }).getByRole('checkbox', { name: /Demo/ }),
  ).toBeChecked()
})
