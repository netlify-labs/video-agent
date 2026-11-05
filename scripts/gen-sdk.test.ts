// scripts/gen-sdk.ts on a small fixture spec (cli-and-sdk plan §4.1 generated signature rule, §4.5 generator tests).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { prepare } from '../packages/sdk/src/transport.js'
import { collect, generateResources, type Spec } from './gen-sdk.js'
import { repoRoot } from './lib/run-tools.js'

const ok = (ref: string) => ({ 200: { content: { 'application/json': { schema: { $ref: ref } } } } })
const fixture = (): Spec => ({
  components: {
    schemas: {
      Thing: { type: 'object', properties: { id: { type: 'string' } } },
      Page: { type: 'object', properties: { items: {}, nextCursor: {} } },
      Items: { type: 'object', properties: { items: {} } },
      Create: { type: 'object', properties: { prompt: {}, look: {} }, required: ['prompt'] },
    },
  },
  paths: {
    '/api/v1/things/{id}/parts/{n}': {
      post: {
        operationId: 'retryPart',
        summary: 'Retry a part',
        'x-sdk': { resource: 'parts', method: 'retry' },
        parameters: [
          { name: 'n', in: 'path', required: true },
          { name: 'id', in: 'path', required: true },
          { name: 'dry', in: 'query' },
        ],
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Create' } } } },
        responses: ok('#/components/schemas/Thing'),
      },
    },
    '/api/v1/things': {
      get: {
        operationId: 'listThings',
        summary: 'List things',
        'x-sdk': { resource: 'things', method: 'list' },
        parameters: [{ name: 'cursor', in: 'query' }],
        responses: ok('#/components/schemas/Page'),
      },
      post: {
        operationId: 'createThing',
        summary: 'Create a thing',
        'x-sdk': { resource: 'things', method: 'create', feature: 'remix', fieldFeatures: { look: 'looks' } },
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Create' } } },
        },
        responses: ok('#/components/schemas/Thing'),
      },
    },
    '/api/v1/things/{id}/recordings': {
      get: {
        operationId: 'listRecordings',
        summary: 'List recordings',
        'x-sdk': { resource: 'things', method: 'recordings' },
        parameters: [{ name: 'id', in: 'path', required: true }],
        responses: ok('#/components/schemas/Items'),
      },
    },
    '/api/v1/internal': {
      post: { operationId: 'internalThing', 'x-sdk': false, responses: {} },
    },
    '/api/v1/upload': {
      post: {
        operationId: 'uploadThing',
        'x-sdk': { resource: 'things', method: 'upload' },
        requestBody: { content: { 'application/octet-stream': {} } },
        responses: ok('#/components/schemas/Thing'),
      },
    },
  },
})

describe('gen-sdk', () => {
  it('path params in path order, then merged input, then opts', async () => {
    const src = await generateResources(fixture())
    expect(src).toMatch(/retry: \(\s*id: string \| number,\s*n: string \| number,\s*input\?: Input</)
    expect(src).toContain("query: ['dry']")
    expect(src).toContain("body: ['prompt', 'look']")
    // A required body with required fields makes input required; an all-optional query keeps it optional.
    expect(src).toMatch(/create: \(\s*input: Input</)
    expect(src).toMatch(/list: \(\s*input\?: Input</)
  })

  it('skips x-sdk false and binary bodies', () => {
    const names = collect(fixture()).map((m) => `${m.resource}.${m.method}`)
    expect(names).toEqual(['parts.retry', 'things.create', 'things.list', 'things.recordings'])
  })

  it('marks only items + nextCursor responses pageable', async () => {
    expect(await generateResources(fixture())).toContain("export const PAGEABLE = ['things.list'] as const")
  })

  it('emits the feature gate and field gates, and none otherwise', async () => {
    const src = await generateResources(fixture())
    expect(src).toContain("features: [...['remix'], ...(input.look !== undefined ? ['looks'] : [])]")
    const list = src.slice(src.indexOf('list: ('))
    expect(list.slice(0, list.indexOf('opts,'))).toContain('features: []')
  })

  it('fails when a body field and a query field share a name, naming both', () => {
    const spec = fixture()
    spec.paths['/api/v1/things/{id}/parts/{n}']!.post!.parameters!.push({ name: 'look', in: 'query' })
    expect(() => collect(spec)).toThrow(
      'POST /api/v1/things/{id}/parts/{n}: look is both a body field and a query field',
    )
  })

  it('is deterministic', async () => {
    expect(await generateResources(fixture())).toBe(await generateResources(fixture()))
  })

  it('the committed resources match the committed spec', async () => {
    const spec = JSON.parse(readFileSync(join(repoRoot, 'ui/src/api/openapi.json'), 'utf8')) as Spec
    expect(await generateResources(spec)).toBe(
      readFileSync(join(repoRoot, 'packages/sdk/src/generated/resources.ts'), 'utf8'),
    )
  })

  it('prepare fills path params and splits input into query and body', () => {
    const r = prepare({
      method: 'POST',
      path: '/api/v1/things/{id}/parts/{n}',
      pathParams: { id: 'a b', n: 2 },
      input: { dry: true, prompt: 'hi', look: undefined, extra: 1 },
      query: ['dry'],
      body: ['prompt', 'look'],
      features: [],
      operationId: 'retryPart',
    })
    expect(r.path).toBe('/api/v1/things/a%20b/parts/2')
    expect(r.query.toString()).toBe('dry=true')
    expect(r.body).toEqual({ prompt: 'hi' })
    expect(() =>
      prepare({ method: 'GET', path: '/x/{id}', pathParams: { id: '' }, features: [], operationId: 'getX' }),
    ).toThrow('getX: missing path parameter id')
  })
})
