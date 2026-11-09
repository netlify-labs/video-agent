// Finalize records whether a finished composition keeps editing contract v1 (plan v2 §8): only those are editable.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readBundleIndex } from '../server/domain/bundles.js'
import { editableVideo, harness, readyVideo } from './helpers.js'
import { tarGz } from './tarball.js'

const fx = (f: string) => readFileSync(new URL(`./fixtures/contract1/${f}`, import.meta.url), 'utf8')

describe('contract on versions', () => {
  it('a contract-1 composition makes the version editable', async () => {
    const h = harness()
    const id = await editableVideo(h)
    const video = await h.json(await h.call('GET', `/api/v1/videos/${id}`, { as: h.member }))
    expect(video.versions[0]).toMatchObject({ status: 'ready', editable: true })
    expect((await readBundleIndex(h.deps, id, 1))?.contract).toEqual({ version: 1, violations: [] })
  })

  it('a free-form or broken composition is not editable, and the bundle says why', async () => {
    const h = harness()
    const id = await readyVideo(h)
    expect(
      (await h.json(await h.call('GET', `/api/v1/videos/${id}`, { as: h.member }))).versions[0].editable,
    ).toBe(false)
    h.deps.nextSource = tarGz([
      {
        name: 'video/index.html',
        body: fx('index.html').replace('data-track-index="0"', 'data-track-index="3"'),
      },
      { name: 'video/summary.json', body: fx('summary.json') },
    ])
    await h.call('POST', `/api/v1/videos/${id}/versions`, {
      as: h.member,
      body: { prompt: 'Warmer colours.' },
    })
    await h.drive(4)
    const after = await h.json(await h.call('GET', `/api/v1/videos/${id}`, { as: h.member }))
    expect(after.versions[0]).toMatchObject({ n: 2, status: 'ready', editable: false })
    expect((await readBundleIndex(h.deps, id, 2))?.contract?.violations.join(' ')).toMatch(/track 0/)
  })
})
