// The Remotion switch on Admin (render-engines plan §7), against the mock build: absent unless ENGINES lists Remotion
// (localStorage.mockEngines), and turning it on asks which license the organisation has.
import { expect, test, type Page } from '@playwright/test'

const mock = (page: Page, key: string, value = '1') =>
  page.addInitScript(({ k, v }) => localStorage.setItem(k, v), { k: key, v: value })

test('without ENGINES there is no Remotion anywhere on Admin', async ({ page }) => {
  await page.goto('/admin')
  await expect(page.getByText('Remixing', { exact: true })).toBeVisible()
  await expect(page.getByText('Render engines')).toHaveCount(0)
  await expect(page.getByText(/Remotion/)).toHaveCount(0)
})

test('turning Remotion on asks for the license, and a Company License needs its key', async ({ page }) => {
  await mock(page, 'mockEngines', 'remotion')
  await page.goto('/admin')
  await page.getByRole('switch', { name: /Use Remotion \(a license is required/ }).click({ force: true })
  const dialog = page.getByRole('dialog', { name: 'Use Remotion' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(/Remotion isn't open source/)).toBeVisible()
  const save = dialog.getByRole('button', { name: 'Turn Remotion on' })
  await expect(save).toBeDisabled()
  await dialog.getByLabel(/has a Remotion Company License/).check()
  await expect(dialog.getByText("VIDEO_AGENT_REMOTION_KEY isn't set")).toBeVisible()
  await save.click()
  await expect(page.getByText(/Set VIDEO_AGENT_REMOTION_KEY on the project first/).first()).toBeVisible()
  await dialog.getByLabel(/qualifies for the Free License/).check()
  await dialog.getByLabel('License reference or who approved it').fill('Evaluation, approved by legal')
  await save.click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText(/Free License, recorded by .* \(Evaluation, approved by legal\)/)).toBeVisible()
  await expect(page.getByRole('switch', { name: /Use Remotion/ })).toBeChecked()
})

test('with the key set, a Company License saves', async ({ page }) => {
  await mock(page, 'mockEngines', 'remotion-key')
  await page.goto('/admin')
  await page.getByRole('switch', { name: /Use Remotion \(a license is required/ }).click({ force: true })
  const dialog = page.getByRole('dialog', { name: 'Use Remotion' })
  await dialog.getByLabel(/has a Remotion Company License/).check()
  await expect(dialog.getByText("VIDEO_AGENT_REMOTION_KEY isn't set")).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Turn Remotion on' }).click()
  await expect(page.getByText(/Company License, recorded by/)).toBeVisible()
})

test('the monthly Remotion render count shows only when ENGINES lists Remotion', async ({ page }) => {
  await page.goto('/admin')
  await expect(page.getByText('Credits by person')).toBeVisible()
  await expect(page.getByTestId('remotion-renders')).toHaveCount(0)
  await mock(page, 'mockEngines', 'remotion')
  await page.goto('/admin')
  await expect(page.getByTestId('remotion-renders')).toContainText(
    'Remotion renders this month: 27 (3 videos, 24 stills).',
  )
  await expect(page.getByTestId('remotion-renders')).toContainText('Reconcile with remotion.pro')
})
