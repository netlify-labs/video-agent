// /cli/approve, video-agent login's browser half (cli-and-sdk plan §5.2; bead va-p1th.4.5), on the mock build: the
// mock's fixed codes are BCDF-GHJK (waiting), SCRP-TTAG (an HTML label and a 64-letter host), MNYM-MNYM (over the
// approvals cap); anything else is wrong, and five wrong codes lock the page.
import { expect, test, type Page } from '@playwright/test'

const mock = (page: Page, key: string, value = '1') =>
  page.addInitScript(({ k, v }) => localStorage.setItem(k, v), { k: key, v: value })
const codeInput = (page: Page) => page.getByLabel('Code from your terminal')
const enter = async (page: Page, code: string) => {
  await codeInput(page).fill(code)
  await page.getByRole('button', { name: 'Continue' }).click()
}

test('type the code (any case, spaces), see who asks, approve', async ({ page }) => {
  await page.goto('/cli/approve')
  await codeInput(page).fill('bcdf ghjk')
  await expect(codeInput(page)).toHaveValue('BCDF-GHJK')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(
    page.getByText(/Video Agent CLI on mia-mbp wants an API key that acts as you \(admin\)/),
  ).toBeVisible()
  await expect(page.getByText('203.0.113.7')).toBeVisible()
  await expect(page.getByText('2 min ago')).toBeVisible()
  await expect(page.getByText('Only approve if you just ran video-agent login yourself.')).toBeVisible()
  await page.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByText('Approved. You can close this tab; the terminal is signed in.')).toBeVisible()
})

test('deny', async ({ page }) => {
  await page.goto('/cli/approve')
  await enter(page, 'BCDF-GHJK')
  await page.getByRole('button', { name: 'Deny' }).click()
  await expect(page.getByText('Denied. The terminal was not signed in.')).toBeVisible()
})

test('an HTML label and an over-long host show as literal text, clipped', async ({ page }) => {
  let dialogs = 0
  page.on('dialog', (d) => {
    dialogs++
    void d.dismiss()
  })
  await page.goto('/cli/approve')
  await enter(page, 'SCRP-TTAG')
  const label = page.getByTitle('<img src=x onerror=alert(1)><b>CLI</b>')
  await expect(label).toHaveText('<img src=x onerror=alert(1)><b>CLI</b>')
  await expect(page.locator('main img[src="x"], main b:text("CLI")')).toHaveCount(0)
  await expect(page.getByTitle('h'.repeat(64))).toBeVisible()
  expect(dialogs).toBe(0)
  // Nothing spills sideways, phones included.
  const fits = await page.evaluate(() => {
    const w = globalThis as unknown as {
      innerWidth: number
      document: { documentElement: { scrollWidth: number } }
    }
    return w.document.documentElement.scrollWidth <= w.innerWidth
  })
  expect(fits).toBe(true)
})

test('wrong and expired codes say so; five lock the page', async ({ page }) => {
  await page.goto('/cli/approve')
  for (let i = 0; i < 5; i++) {
    await enter(page, 'XPRD-XPRD')
    await expect(page.getByRole('alert')).toHaveText(/No CLI login is waiting for that code/)
  }
  await enter(page, 'BCDF-GHJK')
  await expect(page.getByRole('alert')).toHaveText('Too many wrong codes. Try again in 15 minutes.')
})

test('too many approvals this hour', async ({ page }) => {
  await page.goto('/cli/approve')
  await enter(page, 'MNYM-MNYM')
  await page.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByRole('alert')).toHaveText(/You approved 10 CLI logins in the last hour/)
})

test('signed out: the sign-in page shows at /cli/approve, with no code in the URL', async ({ page }) => {
  await mock(page, 'mockSignedOut')
  await page.goto('/cli/approve')
  await expect(page.getByRole('button', { name: /Sign in|Log in/ }).first()).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/cli/approve')
  expect(new URL(page.url()).search).toBe('')
})

test('the admin switch turns CLI sign-in off, and the page says so', async ({ page }) => {
  await page.goto('/admin')
  const sw = page.getByRole('switch', { name: 'People can sign in from the CLI' })
  await expect(sw).toBeChecked()
  await sw.click({ force: true })
  await expect(sw).not.toBeChecked()
  // In-app navigation: a reload would restart the mock with the switch on.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      history: { pushState: (s: object, t: string, u: string) => void }
      dispatchEvent: (e: unknown) => void
      PopStateEvent: new (type: string) => unknown
    }
    w.history.pushState({}, '', '/cli/approve')
    w.dispatchEvent(new w.PopStateEvent('popstate'))
  })
  await enter(page, 'BCDF-GHJK')
  await expect(page.getByRole('alert')).toHaveText(/CLI sign-in is turned off for this video agent/)
})
