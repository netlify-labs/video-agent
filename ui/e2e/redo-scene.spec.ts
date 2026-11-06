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
  await expect(page.getByTestId('scene-picker').getByRole('checkbox')).toHaveCount(5)
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

// Redo this part (va-8cy4.4.2) and the scoped Incorporate (va-8cy4.4.3), on the mockRedo comments (server.ts).
const comment = (page: Page, body: string) => page.getByTestId('comment').filter({ hasText: body })

test('Redo this part opens the dialog with the comment’s scene and the comment, and sends nothing until asked', async ({
  page,
}) => {
  await mock(page, 'mockRedo')
  await page.goto('/videos/vid_teaser')
  await expect(comment(page, 'The hook needs a bigger title.')).toBeVisible()
  // Every open pinned comment but the one in the held frame; never the unpinned one.
  await expect(page.getByRole('button', { name: 'Redo this part' })).toHaveCount(4)
  await expect(
    comment(page, 'Hold the last frame a bit longer.').getByRole('button', { name: 'Redo this part' }),
  ).toHaveCount(0)
  await expect(
    comment(page, 'Overall the pacing is good.').getByRole('button', { name: 'Redo this part' }),
  ).toHaveCount(0)
  // A pin at 0:04, the boundary between the problem and the demo, is the demo's.
  await comment(page, 'Start the demo on the dashboard.')
    .getByRole('button', { name: 'Redo this part' })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Redo part of v3' })
  await expect(dialog.getByRole('checkbox', { name: /Demo/ })).toBeChecked()
  await expect(dialog.getByRole('checkbox', { name: /Problem/ })).not.toBeChecked()
  await expect(dialog.getByRole('checkbox', { name: /Start the demo on the dashboard/ })).toBeChecked()
  expect(await lastRevise(page)).toBeUndefined()
  await dialog.getByRole('button', { name: 'Make v5' }).click()
  await expect(dialog).toHaveCount(0)
  expect(await lastRevise(page)).toEqual({
    prompt: 'Incorporate the feedback below.',
    fromVersion: 3,
    scope: { beats: ['demo'] },
    commentIds: ['c_r2'],
  })
})

test('Redo this part is for the owner or an admin: not a Creator on someone else’s video', async ({
  page,
}) => {
  await mock(page, 'mockRedo')
  await mock(page, 'mockRole', 'creator')
  await page.goto('/videos/vid_webhooks')
  await expect(comment(page, 'Show the endpoint URL here.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Redo this part' })).toHaveCount(0)
  // They can still pick scenes in the revise panel.
  await scope(page).getByText('Some scenes').click()
  await expect(pick(page, '2. After · 0:08–0:17')).toBeVisible()
})

test('Incorporate offers only-these-scenes when every pick is pinned, on by default under half the scenes', async ({
  page,
}) => {
  await mock(page, 'mockRedo')
  await page.goto('/videos/vid_teaser')
  await page.getByRole('button', { name: 'Incorporate feedback' }).click()
  const dialog = page.getByRole('dialog')
  const only = dialog.getByRole('switch', { name: 'Only change the scenes these comments point at' })
  const box = (body: string) => dialog.getByRole('checkbox', { name: new RegExp(body) })
  // An unpinned pick, or one in the held frame, rules it out.
  await expect(only).toHaveCount(0)
  await box('Overall the pacing is good.').uncheck()
  await expect(only).toHaveCount(0)
  await box('Hold the last frame').uncheck()
  // Hook, demo and proof: 3 of 5 scenes, off by default.
  await expect(only).not.toBeChecked()
  await box('Add a customer logo').uncheck()
  // Hook and demo: 2 of 5, on, saying which.
  await expect(only).toBeChecked()
  await expect(dialog.getByText('Redoes Hook and Demo.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Make v5 with 3 comments' }).click()
  await expect(dialog).toHaveCount(0)
  expect(await lastRevise(page)).toEqual({
    prompt: 'Incorporate the feedback below.',
    fromVersion: 3,
    commentIds: ['c_r1', 'c_r2', 'c_r3'],
    scope: { beats: ['hook', 'demo'] },
  })
})

test('Incorporate with the switch off is an ordinary revision; pins on every scene hide it', async ({
  page,
}) => {
  await mock(page, 'mockRedo')
  await page.goto('/videos/vid_teaser')
  await page.getByRole('button', { name: 'Incorporate feedback' }).click()
  const dialog = page.getByRole('dialog')
  const only = dialog.getByRole('switch', { name: 'Only change the scenes these comments point at' })
  for (const b of ['Overall the pacing', 'Hold the last frame', 'Add a customer logo', 'The demo cursor'])
    await dialog.getByRole('checkbox', { name: new RegExp(b) }).uncheck()
  await expect(only).toBeChecked()
  await only.click({ force: true })
  await expect(only).not.toBeChecked()
  await dialog.getByRole('button', { name: 'Make v5 with 2 comments' }).click()
  await expect(dialog).toHaveCount(0)
  expect(await lastRevise(page)).toEqual({
    prompt: 'Incorporate the feedback below.',
    fromVersion: 3,
    commentIds: ['c_r1', 'c_r2'],
  })

  // v2 has a pinned comment in each of its four scenes: that's every scene.
  await page.getByRole('button', { name: /v2 from v1/ }).click()
  await page.getByRole('button', { name: 'Incorporate feedback' }).click()
  await dialog.getByRole('checkbox', { name: /Love the end card/ }).uncheck()
  await expect(dialog).toContainText('4 of 5 checked')
  await expect(only).toHaveCount(0)
})

// After the gate: hovering a scene chip seeks the player (va-8cy4.5.9); switching to a scoped version starts at the
// scene it redid (va-8cy4.5.10).
/** The player's state (the specs aren't typechecked against the DOM library). */
type Player = { currentTime: number; readyState: number }
const player = (page: Page) => page.locator('.va-review-frame video')
const currentTime = (page: Page) => player(page).evaluate((v) => (v as unknown as Player).currentTime)

test('hovering a scene chip seeks the player to that scene', async ({ page }) => {
  await page.goto('/videos/vid_teaser')
  await expect
    .poll(() => player(page).evaluate((v) => (v as unknown as Player).readyState))
    .toBeGreaterThan(0)
  await scope(page).getByText('Some scenes').click()
  await pick(page, /Demo/).hover()
  await expect.poll(() => currentTime(page)).toBe(4)
  await pick(page, /Problem/).hover()
  await expect.poll(() => currentTime(page)).toBe(2)
})

test('switching to a scoped version starts at the scene it redid', async ({ page }) => {
  await mock(page, 'mockRedo')
  await page.goto('/videos/vid_teaser')
  await page.getByRole('button', { name: /v2 from v1/ }).click()
  await expect.poll(() => currentTime(page)).toBe(0)
  // v3 redid the demo, which starts at 0:04 in it.
  await page.getByRole('button', { name: /v3 from v2/ }).click()
  await expect.poll(() => currentTime(page)).toBe(4)
})
