// A code block in the editor (Edit.tsx CodeLines, CodeEditor.tsx): fields labelled "Code line 1, 2, 3" edit together
// in a code editor with their indentation; a changed line saves to its own field (a new indentation too); adding or
// removing a line is refused until the count matches; Revert undoes; Expand opens a big one.
import { expect, test, type Page } from '@playwright/test'

const code = (page: Page, name = 'Code (3 lines)') => page.getByRole('textbox', { name })
const textOf = (page: Page, name = 'Code (3 lines)') =>
  code(page, name).evaluate((el) => (el as { innerText: string }).innerText)
const ops = (page: Page) => page.evaluate<unknown[]>('window.__lastEditOps ?? []')
const ORIGINAL = "const ai = new Anthropic()\n  model: 'claude-opus-4-8',\n})"

test('code lines edit together, with their indentation, one field per line', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mockCode', '1'))
  await page.goto('/videos/vid_teaser/edit/2')
  await expect(code(page)).toBeVisible()
  await expect.poll(() => textOf(page)).toBe(ORIGINAL)
  await expect(page.getByRole('textbox', { name: 'Code line 2' })).toHaveCount(0)

  // Same indentation: the line's text alone is saved.
  await code(page).fill("const ai = new Anthropic()\n  model: 'claude-opus-5-5',\n})")
  await expect(page.getByTestId('code-lines').getByTestId('was')).toContainText(
    "Line 2 was: model: 'claude-opus-4-8',",
  )
  await expect
    .poll(() => ops(page), { timeout: 5000 })
    .toEqual([{ op: 'text', id: 'code2', text: "model: 'claude-opus-5-5'," }])
  // A new indentation is saved with the text.
  await code(page).fill("const ai = new Anthropic()\n    model: 'claude-opus-5-5',\n})")
  await expect
    .poll(() => ops(page), { timeout: 5000 })
    .toEqual([{ op: 'text', id: 'code2', text: "    model: 'claude-opus-5-5'," }])

  // A fourth line isn't applied: it would need a revision.
  await code(page).fill("const ai = new Anthropic()\n  model: 'claude-opus-5-5',\n  max_tokens: 1024,\n})")
  await expect(page.getByText('Keep it to 3 lines (now 4)')).toBeVisible()

  await page.getByRole('button', { name: 'Revert Code' }).click()
  await expect.poll(() => textOf(page)).toBe(ORIGINAL)
  await expect(page.getByText('Keep it to 3 lines')).toHaveCount(0)

  // Expand: the same code in a big editor; Esc closes.
  await page.getByRole('button', { name: 'Expand' }).click()
  const dialog = page.getByRole('dialog', { name: 'Code (3 lines)' })
  await expect(dialog).toBeVisible()
  await expect.poll(() => textOf(page, 'Code, expanded')).toBe(ORIGINAL)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})
