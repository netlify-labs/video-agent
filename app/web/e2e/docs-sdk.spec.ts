// /docs/sdk (cli-and-sdk plan §8): this site's URL in the quickstart, the right package name, and no API reference
// (Scalar) loaded for it.
import { expect, test } from '@playwright/test'

test('the SDK page fills in this site and never loads the API reference', async ({ page, baseURL }) => {
  const scripts: string[] = []
  page.on('request', (r) => {
    if (r.resourceType() === 'script') scripts.push(r.url())
  })
  await page.goto('/docs/sdk')
  await expect(page.getByRole('heading', { level: 1, name: 'TypeScript SDK' })).toBeVisible()
  await expect(page.getByText('npm install netlify-video-agent-sdk')).toBeVisible()
  await expect(page.getByText(`url: '${baseURL}'`)).toBeVisible()
  await expect(page.getByText("import { VideoAgent } from 'netlify-video-agent-sdk'")).toBeVisible()
  await expect(page.getByRole('link', { name: 'REST API' }).first()).toBeVisible()
  expect(scripts.filter((u) => /scalar|ApiReference/i.test(u))).toEqual([])
})
