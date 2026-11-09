// SCOPED_AGENT_MODEL / SCOPED_AGENT_EFFORT (redo a scene, plan after-the-gate): unset, scoped runs use the
// deployment's model; set, scoped attempts on revise and on retry use it and unscoped ones don't.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerScopeCheck, resetScopeChecks } from '../server/domain/engines.js'
import { attr, editText, load, save, walk } from '../server/lib/contract.js'
import { hyperframesScopeCheck } from '../server/lib/scope.js'
import { harness, PROMPT, type Harness } from './helpers.js'
import { tarGz } from './tarball.js'

const music = save(
  load(readFileSync(new URL('./fixtures/contract1-music/index.html', import.meta.url), 'utf8')),
)
const archive = (html: string) =>
  tarGz([
    { name: 'video/index.html', body: html },
    { name: 'video/summary.json', body: '{"captions":[]}' },
  ])
/** A run that changed the intro (a frozen scene when only the demo is redone): finalize refuses it. */
const tampered = () => {
  const d = load(music)
  const el = [...walk(d.root)].find((e) => attr(e, 'data-va-text') === 'intro-title')
  if (el) editText(el, 'Org hooks')
  return archive(save(d))
}

beforeEach(() => registerScopeCheck('hyperframes', hyperframesScopeCheck))
afterEach(() => resetScopeChecks())

async function ready(h: Harness) {
  h.deps.nextSource = archive(music)
  const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
  await h.drive(4)
  return v.id as string
}
const revise = (h: Harness, id: string, body: Record<string, unknown>) =>
  h.call('POST', `/api/v1/videos/${id}/versions`, { as: h.member, body: { prompt: 'Redo it.', ...body } })
const attemptOf = async (h: Harness, id: string, n: number) =>
  (await h.attempts(id)).filter((a) => a.versionN === n).at(-1)

describe('the scoped run model', () => {
  it('unset: scoped runs use the deployment’s model and effort', async () => {
    const h = harness({ AGENT_MODEL: 'claude-opus-5-5', AGENT_EFFORT: 'high' })
    const id = await ready(h)
    expect((await revise(h, id, { fromVersion: 1, scope: { beats: ['demo'] } })).status).toBe(202)
    expect(await attemptOf(h, id, 2)).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
  })

  it('set: scoped attempts on revise and retry use it; unscoped ones keep the deployment’s', async () => {
    const h = harness({
      AGENT_MODEL: 'claude-opus-5-5',
      AGENT_EFFORT: 'high',
      SCOPED_AGENT_MODEL: 'claude-sonnet-5',
      SCOPED_AGENT_EFFORT: 'medium',
    })
    const id = await ready(h)
    expect(await attemptOf(h, id, 1)).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
    // A whole revision: the deployment's.
    h.deps.nextSource = archive(music)
    expect((await revise(h, id, { fromVersion: 1 })).status).toBe(202)
    expect(await attemptOf(h, id, 2)).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
    await h.drive(4)
    // A scoped revision, refused at finalize, then retried: both attempts are scoped.
    h.deps.nextSource = tampered()
    expect((await revise(h, id, { fromVersion: 1, scope: { beats: ['demo'] } })).status).toBe(202)
    expect(await attemptOf(h, id, 3)).toMatchObject({ model: 'claude-sonnet-5', effort: 'medium' })
    await h.drive(4)
    expect((await h.deps.store.getVersion(id, 3))?.status).toBe('failed')
    expect((await h.call('POST', `/api/v1/videos/${id}/versions/3/retry`, { as: h.member })).status).toBe(202)
    const retried = await attemptOf(h, id, 3)
    expect((await h.attempts(id)).filter((a) => a.versionN === 3)).toHaveLength(2)
    expect(retried).toMatchObject({ model: 'claude-sonnet-5', effort: 'medium' })
  })
})
