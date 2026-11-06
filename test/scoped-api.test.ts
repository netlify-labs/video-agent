// Redo a scene over the REST API (plan §4.1, §4.2, §5): scope on the revise body, the version DTO's beats and scope
// with the parent's scene names, scoped_revision in /api/v1/config, the SDK gate on the field, and not_editable.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerScopeCheck, resetScopeChecks } from '../src/domain/engines.js'
import { load, save } from '../src/lib/contract.js'
import { hyperframesScopeCheck } from '../src/lib/scope.js'
import { harness, PROMPT, type Harness } from './helpers.js'
import { tarGz } from './tarball.js'

const music = save(
  load(readFileSync(new URL('./fixtures/contract1-music/index.html', import.meta.url), 'utf8')),
)

beforeEach(() => registerScopeCheck('hyperframes', hyperframesScopeCheck))
afterEach(() => resetScopeChecks())

async function parentVideo(h: Harness) {
  h.deps.nextSource = tarGz([
    { name: 'video/index.html', body: music },
    { name: 'video/summary.json', body: '{"captions":[]}' },
  ])
  const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
  await h.drive(4)
  return v.id as string
}
const revise = (h: Harness, id: string, body: Record<string, unknown>) =>
  h.call('POST', `/api/v1/videos/${id}/versions`, { as: h.member, body: { prompt: 'Redo it.', ...body } })

describe('redo a scene over REST', () => {
  it('takes scope on revise and shows beats and the named scope on the versions', async () => {
    const h = harness()
    const id = await parentVideo(h)
    const res = await revise(h, id, { fromVersion: 1, scope: { beats: ['outro', 'intro'] } })
    expect(res.status).toBe(202)
    const video = await h.json(res)
    const [v2, v1] = video.versions
    expect(v2.scope).toEqual({
      beats: [
        { id: 'intro', label: 'Opening' },
        { id: 'outro', label: 'outro' },
      ],
    })
    expect(v1.scope).toBeNull()
    expect(v1.beats.map((b: { id: string }) => b.id)).toEqual(['intro', 'demo', 'outro'])
    expect(v1.beats[0]).toEqual({ id: 'intro', label: 'Opening', start: 0, duration: 3 })
  })

  it('refuses a scope without fromVersion, bad ids, and a version that can’t be redone', async () => {
    const h = harness()
    const id = await parentVideo(h)
    const missing = await revise(h, id, { scope: { beats: ['demo'] } })
    expect(missing.status).toBe(400)
    expect(JSON.stringify(await h.json(missing))).toContain(
      'Say which version the scenes are from (fromVersion)',
    )
    expect((await revise(h, id, { fromVersion: 1, scope: { beats: ['Bad Id'] } })).status).toBe(400)
    await h.deps.store.updateVersion(id, 1, { contract: null })
    const notEditable = await revise(h, id, { fromVersion: 1, scope: { beats: ['demo'] } })
    expect(notEditable.status).toBe(409)
    expect((await h.json(notEditable)).error.code).toBe('not_editable')
  })

  it('lists scoped_revision only once HyperFrames’ scope check is registered', async () => {
    const h = harness()
    const features = async () =>
      (await h.json(await h.call('GET', '/api/v1/config', { as: h.member }))).features
    expect(await features()).toContain('scoped_revision')
    resetScopeChecks()
    expect(await features()).not.toContain('scoped_revision')
  })

  it('documents scope behind the SDK field gate', () => {
    const h = harness()
    const doc = h.app.getOpenAPIDocument({
      openapi: '3.0.0',
      info: { title: 't', version: '0' },
    }) as unknown as {
      paths: Record<string, Record<string, { 'x-sdk'?: { fieldFeatures?: Record<string, string> } }>>
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> }
    }
    expect(doc.paths['/api/v1/videos/{id}/versions']?.post?.['x-sdk']?.fieldFeatures).toMatchObject({
      scope: 'scoped_revision',
    })
    expect(doc.components.schemas.Revise?.properties).toHaveProperty('scope')
    expect(doc.components.schemas.Version?.properties).toHaveProperty('beats')
    expect(doc.components.schemas.Version?.properties).toHaveProperty('scope')
  })
})
