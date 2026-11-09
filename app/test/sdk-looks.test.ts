// Looks through the SDK (plan 2026-11-04-looks §4.9, bead va-nifa.5.1) against the real app: looks.list() and look on
// create, revise and remix. Nothing is hand-written for looks; these prove the generated methods carry the field.
import { describe, expect, it } from 'vitest'
import { VideoAgent } from '../../packages/sdk/src/index.js'
import { apiKey, harness, PROMPT } from './helpers.js'
import { appFetch } from './sdk-fetch.js'

async function sdk() {
  const h = harness()
  const va = new VideoAgent({
    url: 'https://video.example.com',
    apiKey: await apiKey(h, h.member),
    fetch: (input: string | URL | Request, init?: RequestInit) => appFetch(h, new Request(input, init)),
  })
  return { h, va }
}

describe('looks in the SDK', () => {
  it('looks.list() returns the catalog and the default', async () => {
    const { h, va } = await sdk()
    const { looks, default: def } = await va.looks.list()
    expect(looks.map((l) => l.id)).toEqual(h.deps.looks.catalog().map((l) => l.id))
    expect(looks.every((l) => l.enabled)).toBe(true)
    expect(def).toBeNull()
  })

  it('create, revise and remix carry look; the version reports it', async () => {
    const { h, va } = await sdk()
    const made = await va.videos.create({ prompt: PROMPT, look: 'kinetic' })
    expect(made.versions[0]?.look?.id).toBe('kinetic')
    await h.drive(4)
    const restyled = await va.videos.revise(made.id, { prompt: 'Like a terminal', look: 'terminal' })
    expect(restyled.versions.find((v) => v.n === 2)?.look?.id).toBe('terminal')
    await h.drive(4)
    const remix = await va.videos.remix(made.id, { prompt: 'For payments', fromVersion: 1, look: null })
    expect(remix.versions[0]?.look).toBeNull()
  })

  it('an unknown look is a typed 400 unknown_look', async () => {
    const { va } = await sdk()
    await expect(va.videos.create({ prompt: PROMPT, look: 'nope' })).rejects.toMatchObject({
      status: 400,
      code: 'unknown_look',
    })
  })
})
