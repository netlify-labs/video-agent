// A look's music mood steers the music pick (plan 2026-11-04-looks §3 Sound, §4.6 step 6): it's searched right after
// the request's own words and leads the library fallback's mood words. No look, no change; a look never turns sound on.
import { describe, expect, it } from 'vitest'
import { moodWords, needsMusicPick, queryPlan } from '../src/domain/music-pick.js'
import type { AttemptRow } from '../src/domain/types.js'
import { harness, PROMPT } from './helpers.js'

describe('queryPlan with a look mood', () => {
  it('puts the mood third, after the query and its fallback, and stays capped', () => {
    const without = queryPlan('calm ambient', 'upbeat electronic', 'A product tour')
    const withMood = queryPlan(
      'calm ambient',
      'upbeat electronic',
      'A product tour',
      'punchy electronic, 120 bpm',
    )
    expect(withMood.slice(0, 3)).toEqual(['calm ambient', 'upbeat electronic', 'punchy electronic, 120 bpm'])
    expect(withMood.slice(0, 2)).toEqual(without.slice(0, 2))
    // The mood adds one search; at the cap of 7 the generic tail shrinks, never the request's own searches.
    expect(withMood).toHaveLength(Math.min(7, without.length + 1))
    expect(withMood.filter((q) => q !== 'punchy electronic, 120 bpm')).toEqual(
      without.slice(0, withMood.length - 1),
    )
    const many = queryPlan('a', 'b', 'x', null)
    const capped = queryPlan('a', 'b', 'x', 'c')
    expect(many.length).toBeGreaterThanOrEqual(6)
    expect(capped).toHaveLength(Math.min(7, many.length + 1))
    expect(capped.slice(0, 3)).toEqual(['a', 'b', 'c'])
  })

  it('is unchanged without a mood', () => {
    expect(queryPlan('calm ambient', null, 'x', null)).toEqual(queryPlan('calm ambient', null, 'x'))
  })
})

describe('moodWords with a look mood', () => {
  it("leads with the look's words, then the searches' and the request's", () => {
    const words = moodWords(['calm ambient'], 'A relaxing tour', 'punchy electronic')
    expect(words.slice(0, 2)).toEqual(['punchy', 'electronic'])
    expect(words).toContain('calm')
    expect(moodWords(['calm ambient'], 'A relaxing tour')).toEqual(
      moodWords(['calm ambient'], 'A relaxing tour', null),
    )
  })
})

describe('a look never turns sound on', () => {
  it('a silent version with a look needs no music pick', async () => {
    const h = harness()
    const res = await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } })
    const { id } = await h.json<{ id: string }>(res)
    const look = h.deps.looks.catalog().find((l) => l.id === 'kinetic')!
    await h.deps.store.updateVersion(id, 1, {
      look: {
        id: look.id,
        name: look.name,
        hash: look.hash,
        key: `${id}/looks/${look.hash}.tar.gz`,
        sha256: look.sha256,
        bytes: look.bytes,
        source: 'builtin',
      },
    })
    const a = (await h.attempts(id)).find((x) => x.versionN === 1) as AttemptRow
    expect(await needsMusicPick(h.deps, a)).toBe(false)
  })
})
