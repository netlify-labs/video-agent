// A demo's Looks right (screen-recording plan §8.1; va-rsk5.4.3): POST .../hidden/confirm marks hidden areas checked by
// the owner (or an admin), with the time, in every scene the area spans; unknown ids are refused, other people can't,
// and a version without a recording has nothing to confirm. The DTO's hidden list says why each area is hidden.
import { describe, expect, it } from 'vitest'
import type { HiddenArea } from '../server/domain/types.js'
import { harness, person, readyVideo, type Harness } from './helpers.js'

const area = (id: string, source: HiddenArea['source'], beat: string, reason: string): HiddenArea => ({
  id,
  source,
  beat,
  start: 0,
  end: 5,
  reason,
  checkedBy: null,
  checkedAt: null,
})

async function demo(h: Harness) {
  const id = await readyVideo(h)
  await h.deps.store.updateVersion(id, 1, {
    recording: {
      mediaId: 'med_rec',
      trace: null,
      trim: null,
      boxes: [],
      compose: false,
      summary: null,
      hidden: [
        area('s1', 'setup', 'step-1', 'Hidden by you'),
        area('s1', 'setup', 'step-2', 'Hidden by you'),
        area('p1', 'agent', 'step-1', 'Privacy mode: email'),
      ],
    },
  })
  return id
}

const confirm = (h: Harness, as: string, id: string, ids: string[], n = 1) =>
  h.call('POST', `/api/v1/videos/${id}/versions/${String(n)}/hidden/confirm`, { as, body: { ids } })

describe('Looks right', () => {
  it('marks the areas checked, by whom and when, in every scene; the DTO says why', async () => {
    const h = harness()
    const id = await demo(h)
    const res = await confirm(h, h.member, id, ['s1'])
    expect(res.status).toBe(200)
    const v = await h.json<{ versions: { recording: { hidden: (HiddenArea & { why: string })[] } }[] }>(res)
    const hidden = v.versions[0]?.recording.hidden ?? []
    console.log(
      JSON.stringify({
        test: 'recording-hidden',
        hidden: hidden.map((x) => [x.id, x.beat, x.checkedBy, x.why]),
      }),
    )
    expect(
      hidden.filter((x) => x.id === 's1').every((x) => x.checkedBy !== null && x.checkedAt !== null),
    ).toBe(true)
    expect(hidden.find((x) => x.id === 'p1')?.checkedBy).toBeNull()
    expect(hidden.map((x) => x.why)).toEqual(['You drew it', 'You drew it', 'Privacy mode: email'])
  })

  it('refuses unknown ids, other people, and a version with no recording', async () => {
    const h = harness()
    const id = await demo(h)
    expect((await confirm(h, h.member, id, ['nope'])).status).toBe(400)
    const other = await person(h, 'u_cora', 'creator')
    expect((await confirm(h, other, id, ['s1'])).status).toBe(403)
    const plain = await readyVideo(h)
    expect((await confirm(h, h.member, plain, ['s1'])).status).toBe(404)
  })
})
