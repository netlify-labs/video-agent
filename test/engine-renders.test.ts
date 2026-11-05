// Remotion render counts (render-engines plan §7): finalize keeps the run's tally on its attempt, and the admin stats
// show this month's total only when ENGINES lists Remotion.
import { describe, expect, it } from 'vitest'
import { remotionRendersThisMonth } from '../src/domain/usage.js'
import { harness, pgStore, PROMPT, type Harness } from './helpers.js'
import { tarGz } from './tarball.js'

/** One finished Remotion run whose manifest reports these renders (a valid Remotion bundle, so it finalizes). */
async function remotionRun(h: Harness, renders: unknown) {
  h.deps.nextSource = tarGz([
    { name: 'video/props.json', body: '{"contract":1}' },
    { name: 'video/src/Root.tsx', body: 'export const Root = () => null' },
    { name: 'video/summary.json', body: '{}' },
  ])
  h.deps.nextExtra = { manifest: { engine: { id: 'remotion', version: '4.0.540', renders } as never } }
  const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
  await h.deps.store.updateVersion(v.id, 1, { engine: 'remotion' })
  await h.drive(4)
  return v.id as string
}
describe.each([
  ['memory', () => Promise.resolve({})],
  ['postgres', async () => ({ store: await pgStore() })],
])('Remotion render counts (%s)', (_name, stores) => {
  it('finalize keeps the tally on the attempt, and the month adds them up', async () => {
    const h = harness({ ENGINES: 'remotion' }, await stores())
    await remotionRun(h, { video: 1, stills: 6, audio: 0 })
    await remotionRun(h, { video: 1, stills: 3, audio: 0 })
    expect(await remotionRendersThisMonth(h.deps)).toMatchObject({
      total: 11,
      videos: 2,
      stills: 9,
      audio: 0,
      attempts: 2,
    })
    const line = h.deps.logs
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.event === 'finalize.engine_renders')
    expect(line).toMatchObject({ video: 1, stills: 6, audio: 0, attemptId: expect.any(String) })
  })

  it('a malformed tally is logged and not stored, and never fails the run', async () => {
    const h = harness({ ENGINES: 'remotion' }, await stores())
    const id = await remotionRun(h, { video: -1, stills: 'many', audio: 0 })
    const video = await h.json(await h.call('GET', `/api/v1/videos/${id}`, { as: h.member }))
    expect(video.versions[0].status).toBe('ready')
    expect((await remotionRendersThisMonth(h.deps)).attempts).toBe(0)
    expect(h.deps.logs.some((l) => l.includes('finalize.engine_renders_invalid'))).toBe(true)
  })

  it('the stats show the month only when ENGINES lists Remotion', async () => {
    const plain = harness({}, await stores())
    expect(
      await plain.json(await plain.call('GET', '/api/v1/stats', { as: plain.admin })),
    ).not.toHaveProperty('remotionRenders')
    const h = harness({ ENGINES: 'remotion' }, await stores())
    await remotionRun(h, { video: 1, stills: 4, audio: 0 })
    expect(
      (await h.json(await h.call('GET', '/api/v1/stats', { as: h.admin }))).remotionRenders,
    ).toMatchObject({
      total: 5,
      videos: 1,
      stills: 4,
      attempts: 1,
    })
  })
})
