// The microphone Permissions-Policy (record-your-own-voice-over plan §8): the app's static pages allow it for their
// own origin (netlify.toml); the share/embed page and the composition preview, both edge responses, deny it.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  APP_PERMISSIONS_POLICY,
  EDGE_PERMISSIONS_POLICY,
  denyMicrophone,
} from '../src/lib/permissions-policy.js'
import { FakeBlobs } from './fakes.js'
import { loadEdge } from './edge.js'

let blobs: FakeBlobs | undefined
vi.mock('@netlify/blobs', async () => (await import('./edge.js')).fakeBlobsModule(() => blobs))

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('denyMicrophone', () => {
  it('adds microphone=() and keeps the other headers', () => {
    expect(EDGE_PERMISSIONS_POLICY).toBe('microphone=()')
    expect(denyMicrophone({ 'cache-control': 'no-store' })).toEqual({
      'cache-control': 'no-store',
      'permissions-policy': 'microphone=()',
    })
    // It wins over a policy the caller already set.
    expect(denyMicrophone({ 'permissions-policy': APP_PERMISSIONS_POLICY })['permissions-policy']).toBe(
      'microphone=()',
    )
  })
})

describe('where the microphone is allowed', () => {
  it('netlify.toml allows it for the app (every static route) from its own origin', () => {
    const block =
      /\[\[headers\]\]\s+for = "\/\*"\s+\[headers\.values\]\s+Permissions-Policy = "([^"]+)"/.exec(
        read('netlify.toml'),
      )
    expect(block?.[1]).toBe(APP_PERMISSIONS_POLICY)
  })

  it('the preview iframe is never granted it', () => {
    const ui = read('ui/src/components/CompositionPreview.tsx')
    expect(ui).toContain('allow="autoplay"')
    expect(ui).not.toMatch(/allow="[^"]*microphone/)
  })
})

describe('the public share page', () => {
  beforeEach(() => {
    vi.stubGlobal('Netlify', { env: { get: () => undefined } })
    blobs = new FakeBlobs()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    blobs = undefined
  })
  const get = async (path: string) =>
    (await loadEdge('public'))(new Request(`https://video.example.com${path}`), {
      deploy: { published: true },
    })

  it('denies the microphone on the page (also the embed player) and on its not-found page', async () => {
    await blobs?.set(
      'internal',
      'pub/abcdefgh.json',
      JSON.stringify({
        slug: 'abcdefgh',
        jobId: 'vid_1',
        versionN: 1,
        title: 'Hi',
        width: 1920,
        height: 1080,
        durationSec: 5,
        keys: { video: 'v', poster: 'p', gif: 'g', captions: 'c' },
      }),
    )
    const page = await get('/v/abcdefgh')
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(page.headers.get('permissions-policy')).toBe('microphone=()')
    const missing = await get('/v/zzzzzzzz')
    expect(missing.status).toBe(404)
    expect(missing.headers.get('permissions-policy')).toBe('microphone=()')
  })
})
