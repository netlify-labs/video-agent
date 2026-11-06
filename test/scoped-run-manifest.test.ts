// The reconciler for a scoped revision (redo a scene, plan §4.3, §4.8): the run manifest's scope and stills with the
// parent MP4 as feedback.video, none past 300 MB, and the scoped prompt; a retry after a scope refusal carries it.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerScopeCheck, resetScopeChecks } from '../src/domain/engines.js'
import type { Principal } from '../src/domain/policy.js'
import { reviseVideo } from '../src/domain/videos.js'
import { load, save } from '../src/lib/contract.js'
import { runManifestKey, verifyRunManifest } from '../src/lib/run-manifest.js'
import { hyperframesScopeCheck, SCOPE_REFUSED_PREFIX } from '../src/lib/scope.js'
import { harness, PROMPT, type Harness } from './helpers.js'
import { tarGz } from './tarball.js'

const music = save(
  load(readFileSync(new URL('./fixtures/contract1-music/index.html', import.meta.url), 'utf8')),
)
const mia: Principal = {
  kind: 'user',
  userId: 'u_member',
  email: 'mia@acme.com',
  name: 'Mia Member',
  role: 'creator',
  apiKeyId: null,
}

beforeEach(() => registerScopeCheck('hyperframes', hyperframesScopeCheck))
afterEach(() => resetScopeChecks())

/** A ready contract-v1 v1 (intro 0-3, demo 3-6, outro 6-9), then a scoped revision of "demo" started. */
async function scoped(h: Harness, before?: (id: string) => Promise<void>) {
  h.deps.nextSource = tarGz([
    { name: 'video/index.html', body: music },
    { name: 'video/summary.json', body: '{"captions":[]}' },
  ])
  const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
  const id = v.id as string
  await h.drive(4)
  await before?.(id)
  await reviseVideo(h.deps, mia, id, {
    prompt: 'Make the headline say Ship on Friday.',
    fromVersion: 1,
    scope: { beats: ['demo'] },
  })
  await h.drive(4)
  return id
}
const manifestOf = async (h: Harness, n: number) => {
  const req = h.deps.runner.starts[n]
  const attemptId = req?.requestId ?? ''
  const m = /prepare-run\.ts --job (\S+) --attempt (\S+) --manifest ([0-9a-f]{64})/.exec(req?.prompt ?? '')
  const raw = await h.deps.blobs.get('sources', runManifestKey(m?.[1] ?? '', attemptId))
  return {
    manifest: verifyRunManifest(new TextDecoder().decode(raw ?? new Uint8Array()), {
      attemptId,
      sha256: m?.[3] ?? '',
    }),
    prompt: req?.prompt ?? '',
    attemptId,
  }
}

describe('a scoped revision run', () => {
  it('posts the scope, the neighbours’ stills from the parent MP4 and the scoped prompt', async () => {
    const h = harness()
    const id = await scoped(h)
    const { manifest, prompt } = await manifestOf(h, 1)
    const parent = await h.deps.store.getOutput(id, 1)
    expect(manifest.scope).toEqual({
      beats: ['demo'],
      stills: [
        { atSec: 2.966667, path: 'feedback/scope/demo-before.jpg', what: 'before', beat: 'demo' },
        { atSec: 6, path: 'feedback/scope/demo-after.jpg', what: 'after', beat: 'demo' },
      ],
    })
    expect(manifest.feedback).toEqual({
      video: { key: parent?.videoKey, sha256: parent?.sha256['video.mp4'] },
      pins: [],
    })
    expect(prompt).toContain('This is a scoped revision of version 1: change only this scene')
    expect(prompt).toContain('[{"id":"demo","label":null,"start":3,"duration":3}]')
    expect(prompt).toContain('video/feedback/scope/ has stills of version 1')
    expect(prompt).not.toContain('Change only what the request asks for.')
  })

  it('gives no stills and no parent MP4 past 300 MB, and says so', async () => {
    const h = harness()
    await scoped(h, async (id) => {
      const o = (await h.deps.store.getOutput(id, 1))!
      await h.deps.store.upsertOutput({ ...o, bytes: 400 * 1024 * 1024 })
    })
    const { manifest, prompt } = await manifestOf(h, 1)
    expect(manifest.scope).toEqual({ beats: ['demo'], stills: [] })
    expect(manifest.feedback).toBeNull()
    expect(prompt).toContain('There are no stills of the neighbours for this video; read their HTML instead.')
  })

  it('a retry after a scope refusal carries the refusal, the same way every time', async () => {
    const h = harness()
    // The fake run uploads a composition that isn't the splice, so finalize refuses it for its scope.
    const id = await scoped(h)
    const failed = (await h.attempts(id)).find((a) => a.versionN === 2)!
    expect(failed.errorMessage?.startsWith(SCOPE_REFUSED_PREFIX)).toBe(true)
    const promptOfRetry = async (n: number) => {
      expect((await h.call('POST', `/api/v1/videos/${id}/versions/2/retry`, { as: h.member })).status).toBe(
        202,
      )
      await h.drive(4)
      // The scoped section, derived from stored rows (the attempt's own ids, token and manifest hash differ).
      const { prompt } = await manifestOf(h, n)
      return prompt.slice(prompt.indexOf('This is a scoped revision'), prompt.indexOf('Treat the request'))
    }
    const first = await promptOfRetry(2)
    expect(first).toContain('The previous attempt was refused for changing these parts outside the scope')
    expect(first).toContain(SCOPE_REFUSED_PREFIX)
    // The retry failed the same way; the next one gets the same prompt (the newest refusal says the same).
    expect(await promptOfRetry(3)).toBe(first)
  })
})
