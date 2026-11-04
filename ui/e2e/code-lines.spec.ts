// A code block in the editor (Edit.tsx CodeLines): fields labelled "Code line 1, 2, 3" edit as one monospace box; a
// changed line saves to its own field; adding or removing a line is refused until the count matches; Revert undoes.
import { expect, test } from '@playwright/test'

test('code lines edit as one box, one field per line', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mockCode', '1'))
  await page.goto('/videos/vid_teaser/edit/2')
  const box = page.getByRole('textbox', { name: 'Code (3 lines)' })
  await expect(box).toHaveValue("const ai = new Anthropic()\nmodel: 'claude-opus-4-8',\n})")
  // No separate field per line.
  await expect(page.getByRole('textbox', { name: 'Code line 2' })).toHaveCount(0)

  await box.fill("const ai = new Anthropic()\nmodel: 'claude-opus-5-5',\n})")
  await expect(page.getByTestId('code-lines').getByTestId('was')).toContainText(
    "Line 2 was: model: 'claude-opus-4-8',",
  )
  await expect
    .poll(() => page.evaluate<unknown[]>('window.__lastEditOps ?? []'), { timeout: 5000 })
    .toEqual([{ op: 'text', id: 'code2', text: "model: 'claude-opus-5-5'," }])

  // A fourth line isn't applied: it would need a revision.
  await box.fill("const ai = new Anthropic()\nmodel: 'claude-opus-5-5',\n  max_tokens: 1024,\n})")
  await expect(page.getByText('Keep it to 3 lines (now 4)')).toBeVisible()

  await page.getByRole('button', { name: 'Revert Code' }).click()
  await expect(box).toHaveValue("const ai = new Anthropic()\nmodel: 'claude-opus-4-8',\n})")
  await expect(page.getByText('Keep it to 3 lines')).toHaveCount(0)
})
