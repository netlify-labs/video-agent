// The agent choice on create (`runner`): validated against the catalog, kept on the video, and used by every run of
// it (create, revise, remix); without one, runs take the deployment's agent. Memory store and PGlite.
import { describe, expect, it } from 'vitest'
import { checkRunnerChoice, wireEffort } from '../server/lib/agent-catalog.js'
import { harness, pgStore, PROMPT, type Harness } from './helpers.js'

interface Dto {
  id: string
  versions: { n: number; agent: { agent: string; model: string | null; effort: string | null } | null }[]
  error?: { code: string; message: string }
}

const agent = (d: Dto, n: number) => {
  const a = d.versions.find((v) => v.n === n)?.agent
  return a ? [a.agent, a.model, a.effort] : null
}

async function scenario(h: Harness) {
  const post = async (path: string, body: unknown) => {
    const res = await h.call('POST', path, { as: h.member, body })
    return { status: res.status, body: await h.json<Dto>(res) }
  }
  // Auto: the deployment's agent, no model or effort.
  const plain = await post('/api/v1/videos', { prompt: PROMPT })
  expect(agent(plain.body, 1)).toEqual([h.deps.config.agent, null, null])

  // A full choice; an agent alone; a model alone.
  const runner = { agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' }
  const chosen = await post('/api/v1/videos', { prompt: PROMPT, runner })
  expect(chosen.status).toBe(202)
  expect(agent(chosen.body, 1)).toEqual(['codex', 'gpt-5.6-sol', 'high'])
  expect(
    agent((await post('/api/v1/videos', { prompt: PROMPT, runner: { agent: 'gemini' } })).body, 1),
  ).toEqual(['gemini', null, null])
  // An effort whose wire name differs is sent as Agent Runner takes it.
  const glm = { agent: 'opencode', model: 'z-ai/glm-5.2', effort: 'max' }
  expect(agent((await post('/api/v1/videos', { prompt: PROMPT, runner: glm })).body, 1)).toEqual([
    'opencode',
    'z-ai/glm-5.2',
    'xhigh',
  ])

  // Refused: an unknown agent (the schema), another agent's model, an effort the model lacks, an effort alone.
  for (const bad of [
    { agent: 'nope' },
    { agent: 'claude', model: 'gpt-5.6-sol' },
    { agent: 'opencode', model: 'minimax/minimax-m3', effort: 'high' },
    { agent: 'claude', effort: 'high' },
  ]) {
    const res = await post('/api/v1/videos', { prompt: PROMPT, runner: bad })
    expect([res.status, res.body.error?.code]).toEqual([400, 'invalid_request'])
  }

  // Later versions and remixes keep the video's agent.
  await h.drive(4)
  const revised = await post(`/api/v1/videos/${chosen.body.id}/versions`, { prompt: 'Tighter' })
  expect(agent(revised.body, 2)).toEqual(['codex', 'gpt-5.6-sol', 'high'])
  await h.drive(4)
  const remix = await post(`/api/v1/videos/${chosen.body.id}/remix`, {
    prompt: 'For payments',
    fromVersion: 1,
  })
  expect(remix.status).toBe(202)
  expect(agent(remix.body, 1)).toEqual(['codex', 'gpt-5.6-sol', 'high'])
}

describe('the agent choice on create', () => {
  it('memory store', async () => {
    await scenario(harness())
  })
  it('PGlite', async () => {
    await scenario(harness({}, { store: await pgStore() }))
  })
})

it('checks a choice against the catalog', () => {
  expect(checkRunnerChoice({ agent: 'claude' })).toEqual({
    ok: true,
    choice: { agent: 'claude', model: null, effort: null },
  })
  expect(checkRunnerChoice({ agent: 'claude', model: 'claude-opus-5-5', effort: 'low' }).ok).toBe(true)
  expect(checkRunnerChoice({ agent: 'claude', model: 'claude-opus-5-5', effort: 'max' }).ok).toBe(false)
  expect(wireEffort({ agent: 'opencode', model: 'moonshotai/kimi-k3', effort: 'max' })).toBe('max')
  expect(wireEffort({ agent: 'opencode', model: 'deepseek/deepseek-v4-pro', effort: 'max' })).toBe('xhigh')
})
