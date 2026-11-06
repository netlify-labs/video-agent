// video-agent looks, --look on create, revise, remix and plans, and restyle, against the real routes (looks plan §4.13;
// bead va-nifa.5.2). `none` is the API's null; an unknown Look is a usage error before anything is made.
import { describe, expect, it } from 'vitest'
import { EXIT } from '../packages/cli/src/exit.js'
import { cli } from './cli-io.js'
import { harness, PROMPT } from './helpers.js'

const sent = async (requests: Request[], path: string) => {
  const r = requests.filter((q) => q.method === 'POST' && new URL(q.url).pathname === path).at(-1)
  return r ? ((await r.clone().json()) as Record<string, unknown>) : null
}

describe('video-agent looks', () => {
  it('lists the Looks with the default and the ones turned off', async () => {
    const h = harness()
    await h.call('PATCH', '/api/v1/admin/settings', {
      as: h.admin,
      body: { defaultLook: 'clean', disabledLooks: ['terminal'] },
    })
    const { run } = await cli(h)
    const r = await run(['looks', '--json'])
    expect(r.code).toBe(0)
    expect(r.json().looks.map((l: { id: string }) => l.id)).toEqual(['clean', 'kinetic', 'terminal'])
    expect(r.json().default).toBe('clean')
    const text = await run(['looks'])
    expect(text.stdout).toMatch(/clean\s+Clean\s+\(default\)/)
    expect(text.stdout).toMatch(/terminal\s+Terminal\s+\(turned off\)/)
  })
})

describe('--look', () => {
  it('create, plans, revise and remix send look; none is null', async () => {
    const h = harness()
    const { run, requests } = await cli(h)
    const made = await run(['create', PROMPT, '--look', 'kinetic', '--json'])
    expect(made.code).toBe(0)
    expect(await sent(requests, '/api/v1/videos')).toMatchObject({ look: 'kinetic' })
    expect(made.json().versions[0].look.id).toBe('kinetic')
    const id = made.json().id as string
    await h.drive(4)

    expect((await run(['revise', id, 'Like a terminal', '--look', 'terminal', '--json'])).code).toBe(0)
    expect(await sent(requests, `/api/v1/videos/${id}/versions`)).toMatchObject({ look: 'terminal' })
    await h.drive(4)
    expect((await run(['remix', id, 'For payments', '--look', 'none', '--json'])).code).toBe(0)
    expect(await sent(requests, `/api/v1/videos/${id}/remix`)).toMatchObject({ look: null })

    h.deps.gateway.routeAnswers = {
      needs_questions: 'yes',
      template: 'launch',
      complexity: 'standard',
      aspect: 'landscape',
    }
    h.deps.gateway.replies.push(JSON.stringify({ questions: [] }))
    expect((await run(['create', PROMPT, '--plan', '--look', 'clean', '--json'])).code).toBe(0)
    expect(await sent(requests, '/api/v1/plans')).toMatchObject({ look: 'clean' })
  })

  it('an unknown look is refused by the server with its message', async () => {
    const h = harness()
    const { run } = await cli(h)
    const r = await run(['create', PROMPT, '--look', 'nope', '--json'])
    expect(r.code).not.toBe(0)
    expect(r.json().error).toMatchObject({ code: 'unknown_look', message: 'There\'s no look called "nope".' })
  })
})

describe('video-agent restyle', () => {
  it('revises with the Look and a stock request; none drops the look; unknown exits 2', async () => {
    const h = harness()
    const { run, requests } = await cli(h)
    const id = (await run(['create', PROMPT, '--look', 'kinetic', '--json'])).json().id as string
    await h.drive(4)
    const r = await run(['restyle', id, 'terminal', '--json'])
    expect(r.code).toBe(0)
    expect(await sent(requests, `/api/v1/videos/${id}/versions`)).toEqual({
      prompt: 'Restyle this video in the Terminal look.',
      look: 'terminal',
    })
    expect(r.json().versions.find((v: { n: number }) => v.n === 2).look.id).toBe('terminal')
    await h.drive(4)
    expect((await run(['restyle', id, 'none', '--json'])).code).toBe(0)
    expect(await sent(requests, `/api/v1/videos/${id}/versions`)).toEqual({
      prompt: 'Restyle this video without a look.',
      look: null,
    })
    await h.drive(4)
    const before = requests.length
    const bad = await run(['restyle', id, 'nope'])
    expect(bad.code).toBe(EXIT.usage)
    expect(bad.stderr).toContain('video-agent looks')
    expect(requests.slice(before).some((q) => q.method === 'POST')).toBe(false)
  })
})
