// The library's Recordings filter (plan 2026-11-02 §2.3, §6.1 draft expiry), on the mock build: your voice-over
// recordings stay out of the default list, the Recordings filter lists them with where each is used, a recording
// opens its video, and Delete unused recordings asks first, then deletes only the unused ones.
import { expect, test, type Page } from '@playwright/test'

const mock = (page: Page, key: string, value = '1') =>
  page.addInitScript(({ k, v }) => localStorage.setItem(k, v), { k: key, v: value })

test.beforeEach(async ({ page }) => {
  await mock(page, 'mockRecordings')
  await mock(page, 'va-media-view', 'table')
})

test('recordings are left out of the library and listed under Recordings, with where each is used', async ({
  page,
}) => {
  await page.goto('/media')
  await expect(page.getByText('Nothing here yet')).toBeVisible()
  await page.getByText('Recordings', { exact: true }).click()
  await expect(page.getByText('Your voice-over recordings.', { exact: false })).toBeVisible()
  const used = page.getByTestId('media-med_take0001')
  await expect(used.getByText('Intro take')).toBeVisible()
  await expect(page.getByTestId('used-med_take0001')).toHaveText('v2')
  await expect(page.getByTestId('used-med_take0002')).toHaveText('your draft')
  await expect(page.getByTestId('used-med_take0003')).toHaveText(/^Unused · kept until /)
  // Names and notes edit as for any library item.
  await page.getByRole('button', { name: 'Actions for Warm-up' }).click()
  await page.getByRole('menuitem', { name: 'Edit name and notes' }).click()
  const edit = page.getByRole('dialog', { name: 'Edit Warm-up' })
  // The dialog has the recording itself, to listen to.
  await expect(edit.getByTestId('media-preview-audio')).toHaveJSProperty('tagName', 'AUDIO')
  await edit.getByLabel('Notes').fill('Too fast')
  await edit.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('media-med_take0003').getByText('Too fast', { exact: false })).toBeVisible()
  // A recording opens its video.
  await used.getByRole('button', { name: 'Actions for Intro take' }).click()
  await page.getByRole('menuitem', { name: 'Open video' }).click()
  await expect(page).toHaveURL(/\/videos\/vid_teaser$/)
})

test('Delete unused recordings asks first, then deletes only the unused ones', async ({ page }) => {
  await page.goto('/media')
  await page.getByText('Recordings', { exact: true }).click()
  await expect(page.getByTestId('media-med_take0003')).toBeVisible()
  await page.getByRole('button', { name: 'Delete unused recordings' }).click()
  const confirm = page.getByRole('dialog', { name: 'Delete unused recordings?' })
  await expect(confirm).toContainText('Recordings in use are kept.')
  // Cancel keeps everything.
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByTestId('media-med_take0003')).toBeVisible()
  await page.getByRole('button', { name: 'Delete unused recordings' }).click()
  await page
    .getByRole('dialog', { name: 'Delete unused recordings?' })
    .getByRole('button', { name: 'Delete unused' })
    .click()
  await expect(page.getByText('Deleted 1 unused recording.')).toBeVisible()
  await expect(page.getByTestId('media-med_take0003')).toHaveCount(0)
  await expect(page.getByTestId('media-med_take0001')).toBeVisible()
  await expect(page.getByTestId('media-med_take0002')).toBeVisible()
  // A recording can be deleted on its own too.
  await page.getByRole('button', { name: 'Actions for Second try' }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await expect(page.getByRole('dialog')).toContainText('Drafts and versions that already use it keep it.')
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByTestId('media-med_take0002')).toHaveCount(0)
})
