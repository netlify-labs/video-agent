// /docs/github (github-action plan §9; bead va-mg4i.5.1): this site's URL to copy, a link to make a key, the server's
// features from /api/v1/config (with and without context and external_ref), the examples pinned to a full SHA, and
// the inputs and outputs tables.
import { expect, test, type Page } from '@playwright/test'

/** Adds features to the mock's /api/v1/config answer: wraps window.fetch whenever the mock replaces it. */
async function withFeatures(page: Page, extra: string[]) {
  await page.addInitScript((add) => {
    let inner = globalThis.fetch.bind(globalThis)
    const wrapped: typeof fetch = async (input, init) => {
      const res = await inner(input, init)
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!new URL(url, 'http://localhost').pathname.endsWith('/api/v1/config')) return res
      const body = (await res.json()) as { features: string[] }
      body.features = [...body.features, ...add]
      return Response.json(body)
    }
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      get: () => wrapped,
      set: (f: typeof fetch) => {
        inner = f
      },
    })
  }, extra)
}

const feature = (page: Page, id: string) => page.locator(`[data-feature="${id}"]`)

test('the GitHub Action page fills in this site and lists the examples, inputs and outputs', async ({
  page,
  baseURL,
}) => {
  await page.goto('/docs/github')
  await expect(page.getByRole('heading', { level: 1, name: 'GitHub Action' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'VIDEO_AGENT_URL' })).toHaveValue(baseURL ?? '')
  await expect(page.getByRole('link', { name: 'create an API key' })).toHaveAttribute('href', '/keys')
  for (const title of ['A video for labelled PRs', '/video commands', 'A changelog video on every release'])
    await expect(page.getByRole('heading', { name: title })).toBeVisible()
  await expect(
    page.getByText(/netlify-labs\/video-agent\/packages\/action@[0-9a-f]{40} # action-v1/).first(),
  ).toBeVisible()
  await expect(page.getByRole('table', { name: 'Inputs' }).getByText('max-runs-per-day')).toBeVisible()
  await expect(page.getByRole('table', { name: 'Outputs' }).getByText('share-url')).toBeVisible()
  // The mock lists scoped_revision and remix, not context or external_ref.
  await expect(feature(page, 'scoped_revision')).toContainText('On')
  await expect(feature(page, 'context')).toContainText('Off')
  await expect(feature(page, 'context')).toContainText('the text goes in the prompt')
  await expect(feature(page, 'external_ref')).toContainText('Off')
})

test('with context and external_ref on the server, both show as on', async ({ page }) => {
  await withFeatures(page, ['context', 'external_ref'])
  await page.goto('/docs/github')
  await expect(feature(page, 'context')).toContainText('On')
  await expect(feature(page, 'context')).not.toContainText('off here')
  await expect(feature(page, 'external_ref')).toContainText('On')
})
