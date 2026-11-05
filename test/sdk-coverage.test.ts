// The SDK stays in step with the API (cli-and-sdk plan §4.4, §4.5): the committed API report is current, the names
// other plans and the GitHub Action rely on exist, and every fieldFeatures key is a real input field.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { VideoAgent } from '../packages/sdk/src/index.js'
import type { Input } from '../packages/sdk/src/transport.js'
import { apiReport } from '../scripts/sdk-api-report.js'
import { collect, type Spec } from '../scripts/gen-sdk.js'
import { repoRoot } from '../scripts/lib/run-tools.js'

const spec = JSON.parse(readFileSync(join(repoRoot, 'ui/src/api/openapi.json'), 'utf8')) as Spec
const va = new VideoAgent({ url: 'https://video.example.com', apiKey: 'nva_x', fetch: (() => {}) as never })

/** Names other plans rely on (§4.1 table, github-action plan). Each plan adds its own here when its routes land. */
const RELIED_ON = [
  'videos.create',
  'videos.get',
  'videos.list',
  'videos.listAll',
  'videos.update',
  'videos.revise',
  'videos.remix',
  'videos.favorite',
  'videos.progress',
  'videos.wait',
  'videos.resolve',
  'versions.retry',
  'versions.cancel',
  'versions.publish',
  'versions.unpublish',
  'versions.setVerdict',
  'versions.captions',
  'files.url',
  'files.download',
  'plans.create',
  'plans.questions',
  'plans.brief',
  'comments.list',
  'comments.add',
  'comments.addBatch',
  'media.upload',
  'media.check',
  'media.list',
  'media.get',
  'media.delete',
  'music.search',
  'music.import',
  'music.importAndWait',
  'keys.list',
  'keys.revoke',
  'me.get',
  'me.usage',
  'config.get',
  'config.supports',
]

describe('SDK coverage', () => {
  it('api.md is current (run `npx tsx scripts/sdk-api-report.ts`)', () => {
    expect(apiReport()).toBe(readFileSync(join(repoRoot, 'packages/sdk/api.md'), 'utf8'))
  })

  it('has every name other plans rely on', () => {
    const missing = RELIED_ON.filter((n) => {
      const [r, m] = n.split('.') as [string, string]
      return (
        typeof (va as unknown as Record<string, Record<string, unknown> | undefined>)[r]?.[m] !== 'function'
      )
    })
    expect(missing).toEqual([])
  })

  it('every fieldFeatures key is an input field of its operation', () => {
    const bad = collect(spec).flatMap((m) =>
      m.fieldFeatures
        .filter(([field]) => !m.body.includes(field) && !m.query.includes(field))
        .map(([field]) => `${m.operationId}: ${field}`),
    )
    expect(bad).toEqual([])
  })

  it("videos.list takes the API's own query names", () => {
    type ListInput = Input<'/api/v1/videos', 'get'>
    expectTypeOf<ListInput>().toHaveProperty('owner')
    expectTypeOf<ListInput['owner']>().toEqualTypeOf<'me' | 'all' | undefined>()
    expectTypeOf<ListInput>().toHaveProperty('q')
    expectTypeOf<ListInput>().toHaveProperty('status')
    expectTypeOf<ListInput>().toHaveProperty('cursor')
    expectTypeOf<ListInput>().toHaveProperty('limit')
  })
})
