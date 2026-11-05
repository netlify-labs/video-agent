// Every operation carries a tag, a unique verb-first operationId and an `x-sdk` name (cli-and-sdk plan §4.1, §4.4).
// The SDK's resource methods are generated from x-sdk, so a new route fails here until someone names it.
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { FEATURES } from '../src/domain/features.js'
import { makeDeps } from './fakes.js'

type Op = { tags?: string[]; operationId?: string; 'x-sdk'?: unknown }

const VERBS = new Set(
  (
    'abort add ask cancel check claim complete correct create decide delete discard favorite get import list mark publish rebase ' +
    'lookup receive refresh release remix remove render report reset resolve resume retry reveal revise revoke rotate save ' +
    'search set take test transfer unfavorite unpublish update upload write'
  ).split(' '),
)
const CAMEL = /^[a-z]+[A-Z][A-Za-z0-9]*$/
const IDENT = /^[a-z][A-Za-z0-9]*$/

const spec = createApp(makeDeps({ URL: 'https://your-video-agent.netlify.app' }), {
  isLive: () => true,
  contextIsDefault: true,
}).spec() as unknown as { paths: Record<string, Record<string, Op>> }
const ops = Object.entries(spec.paths).flatMap(([path, item]) =>
  Object.entries(item).map(([method, op]) => ({ where: `${method.toUpperCase()} ${path}`, op })),
)

/** Why x-sdk is malformed, or null when it's fine. */
function sdkProblem(v: unknown): string | null {
  if (v === false) return null
  if (!v || typeof v !== 'object') return 'missing x-sdk'
  const { resource, method, feature, fieldFeatures, ...rest } = v as Record<string, unknown>
  if (Object.keys(rest).length) return `unknown x-sdk keys ${Object.keys(rest).join(', ')}`
  if (typeof resource !== 'string' || !IDENT.test(resource)) return 'x-sdk.resource is not a camelCase name'
  if (typeof method !== 'string' || !IDENT.test(method)) return 'x-sdk.method is not a camelCase name'
  const known = (f: unknown) => (FEATURES as readonly unknown[]).includes(f)
  if (feature !== undefined && !known(feature))
    return `x-sdk.feature ${JSON.stringify(feature)} is not in FEATURES`
  if (fieldFeatures !== undefined) {
    if (!fieldFeatures || typeof fieldFeatures !== 'object') return 'x-sdk.fieldFeatures is not an object'
    for (const [k, f] of Object.entries(fieldFeatures))
      if (!known(f)) return `x-sdk.fieldFeatures.${k} ${JSON.stringify(f)} is not in FEATURES`
  }
  return null
}

describe('operationIds and x-sdk', () => {
  it('every operation has a tag, a verb-first camelCase operationId and a well-formed x-sdk', () => {
    const offenders = ops.flatMap(({ where, op }) => {
      const out: string[] = []
      if (!op.tags?.length) out.push(`${where}: no tag`)
      const id = op.operationId
      if (!id) out.push(`${where}: no operationId`)
      else if (!CAMEL.test(id) || !VERBS.has(id.match(/^[a-z]+/)![0]))
        out.push(`${where}: operationId ${id} is not verb-first camelCase`)
      const p = sdkProblem(op['x-sdk'])
      if (p) out.push(`${where}: ${p}`)
      return out
    })
    expect(offenders).toEqual([])
  })

  it('operationIds are unique', () => {
    const seen = new Map<string, string>()
    const dups = ops.flatMap(({ where, op }) => {
      const prev = seen.get(op.operationId!)
      seen.set(op.operationId!, where)
      return prev ? [`${op.operationId} on ${prev} and ${where}`] : []
    })
    expect(dups).toEqual([])
  })

  it('no two operations share an SDK name', () => {
    const seen = new Map<string, string>()
    const dups = ops.flatMap(({ where, op }) => {
      const sdk = op['x-sdk'] as { resource: string; method: string } | false
      if (!sdk) return []
      const name = `${sdk.resource}.${sdk.method}`
      const prev = seen.get(name)
      seen.set(name, where)
      return prev ? [`${name} on ${prev} and ${where}`] : []
    })
    expect(dups).toEqual([])
  })

  it('the names other plans rely on exist', () => {
    const names = new Set(
      ops.flatMap(({ op }) => {
        const sdk = op['x-sdk'] as { resource: string; method: string } | false
        return sdk ? [`${sdk.resource}.${sdk.method}`] : []
      }),
    )
    for (const n of [
      'videos.create',
      'videos.get',
      'videos.list',
      'videos.revise',
      'videos.remix',
      'videos.favorite',
      'videos.progress',
      'versions.retry',
      'versions.cancel',
      'versions.publish',
      'versions.unpublish',
      'versions.setVerdict',
      'versions.captions',
      'plans.create',
      'plans.questions',
      'plans.brief',
      'comments.list',
      'comments.add',
      'comments.addBatch',
      'media.check',
      'media.list',
      'media.get',
      'media.delete',
      'music.search',
      'music.import',
      'keys.list',
      'keys.revoke',
      'me.get',
      'me.usage',
      'config.get',
    ])
      expect(names, n).toContain(n)
  })

  it('matches the committed table, so every rename shows in review', async () => {
    const table = Object.fromEntries(
      ops.map(({ where, op }) => [where, { operationId: op.operationId, sdk: op['x-sdk'] }]),
    )
    await expect(`${JSON.stringify(table, null, 2)}\n`).toMatchFileSnapshot('openapi-ids.snapshot.json')
  })

  it('a route-level x- extension reaches the generated spec', () => {
    const app = new OpenAPIHono()
    app.openapi(
      createRoute({
        method: 'get',
        path: '/fixture',
        operationId: 'getFixture',
        'x-sdk': { resource: 'fixtures', method: 'get' },
        tags: ['fixture'],
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: z.object({}) } } } },
      }),
      (c) => c.json({}, 200),
    )
    const doc = app.getOpenAPIDocument({ openapi: '3.0.0', info: { title: 't', version: '0' } })
    expect(doc.paths['/fixture']?.get).toMatchObject({
      operationId: 'getFixture',
      'x-sdk': { resource: 'fixtures', method: 'get' },
    })
  })
})
