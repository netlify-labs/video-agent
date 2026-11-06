// Phase 2 gate for redo a scene (docs/plans/2026-11-04-regenerate-beat.md §7): the service end to end in the harness.
// Scenes route → scoped revise over REST → manifest and prompt → an honest run → ready with scope and beats and the
// video.ready webhook → a run that touched a frozen scene → refused, nothing stored → retry carries the refusal → MCP.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { registerScopeCheck, resetScopeChecks } from '../src/domain/engines.js'
import { getSettings } from '../src/domain/settings.js'
import { deliverWebhooks } from '../src/domain/webhooks.js'
import { encrypt } from '../src/lib/crypto.js'
import { attr, editText, load, save, walk, type Doc } from '../src/lib/contract.js'
import { runManifestKey, verifyRunManifest } from '../src/lib/run-manifest.js'
import { hyperframesScopeCheck, SCOPE_REFUSED_PREFIX, spliceBytes, spliceScoped } from '../src/lib/scope.js'
import type { Store } from '../src/store/types.js'
import { apiKey, harness, pgStore, PROMPT, type Harness } from './helpers.js'
import { tarGz } from './tarball.js'

const music = save(
  load(readFileSync(new URL('./fixtures/contract1-music/index.html', import.meta.url), 'utf8')),
)
const summary = { title: 'Org webhooks', captions: [] }
const step = (name: string, f: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ step: `gate2.${name}`, ...f }))

/** A 9 s 1920x1080 H.264 MP4: as long as the composition, like render-job's. */
let mp4 = new Uint8Array()
beforeAll(() => {
  const out = join(mkdtempSync(join(tmpdir(), 'va-gate2-')), 'v.mp4')
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=1920x1080:r=30:d=9',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    out,
  ])
  mp4 = new Uint8Array(readFileSync(out))
}, 60_000)
beforeEach(() => registerScopeCheck('hyperframes', hyperframesScopeCheck))
afterEach(() => resetScopeChecks())

const edit = (f: (d: Doc) => void) => {
  const d = load(music)
  f(d)
  return save(d)
}
const text = (d: Doc, id: string, value: string) =>
  editText(
    [...walk(d.root)].find((e) => attr(e, 'data-va-text') === id)!,
    value,
  )
const archive = (html: string, s: unknown) =>
  tarGz([
    { name: 'video/index.html', body: html },
    { name: 'video/summary.json', body: typeof s === 'string' ? s : JSON.stringify(s) },
  ])
/** What an honest render-job uploads for an agent edit: the splice's bytes. */
const honest = (agentHtml: string) => {
  const b = spliceBytes(
    spliceScoped({
      parent: { html: music, summary },
      agent: { html: agentHtml, summary },
      beats: ['demo'],
      lockedLength: false,
    }),
  )
  return archive(b['index.html'], b['summary.json'])
}
const started = async (h: Harness, n: number) => {
  const req = h.deps.runner.starts[n]
  const attemptId = req?.requestId ?? ''
  const m = /prepare-run\.ts --job (\S+) --attempt (\S+) --manifest ([0-9a-f]{64})/.exec(req?.prompt ?? '')
  const raw = await h.deps.blobs.get('sources', runManifestKey(m?.[1] ?? '', attemptId))
  return {
    prompt: req?.prompt ?? '',
    manifest: verifyRunManifest(new TextDecoder().decode(raw ?? new Uint8Array()), {
      attemptId,
      sha256: m?.[3] ?? '',
    }),
  }
}

const stores: [string, () => Promise<Store | undefined>][] = [
  ['memory', async () => undefined],
  ['postgres', pgStore],
]
const opts = async (store: () => Promise<Store | undefined>) => {
  const s = await store()
  return s ? { store: s } : {}
}

describe.each(stores)('redo a scene, the service end to end (%s)', (_name, store) => {
  it('scenes → scoped revise → honest run ready → tampered run refused → retry → MCP', async () => {
    const h = harness({}, await opts(store))
    await h.call('GET', '/api/v1/me', { as: h.member })
    const now = h.deps.clock.now().toISOString()
    await h.deps.store.putUserWebhook({
      userId: 'u_member',
      url: 'https://me.example.com/hook',
      secretEnc: encrypt((await getSettings(h.deps)).dataEncryptionKey, 's'),
      createdAt: now,
      updatedAt: now,
    })

    // 1. A ready contract-v1 video whose scenes aren't stored yet: the beats route fills them.
    h.deps.nextSource = archive(music, summary)
    const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
    const id = v.id as string
    await h.drive(4)
    await h.deps.store.updateVersion(id, 1, { beats: null })
    const beats = await h.json(await h.call('GET', `/api/v1/videos/${id}/versions/1/beats`, { as: h.member }))
    expect(beats.beats.map((b: { id: string }) => b.id)).toEqual(['intro', 'demo', 'outro'])
    step('beats', { count: beats.beats.length })

    // 2. A scoped revision over REST; its run gets the scope, the stills and the scoped prompt.
    h.deps.nextSource = honest(edit((d) => text(d, 'demo-sub', 'Ship on Friday')))
    h.deps.nextExtra = { files: { 'video.mp4': mp4 } }
    const r2 = await h.call('POST', `/api/v1/videos/${id}/versions`, {
      as: h.member,
      body: { prompt: 'Make the subtitle say Ship on Friday.', fromVersion: 1, scope: { beats: ['demo'] } },
    })
    expect(r2.status).toBe(202)
    expect((await h.json(r2)).versions[0].scope).toEqual({ beats: [{ id: 'demo', label: 'demo' }] })
    await h.drive(4)
    const run2 = await started(h, 1)
    expect(run2.manifest.scope?.beats).toEqual(['demo'])
    expect(run2.manifest.scope?.stills).toHaveLength(2)
    expect(run2.prompt).toContain('This is a scoped revision of version 1')
    step('scoped_run', { stills: run2.manifest.scope?.stills.length })

    // 3. The honest run is ready with its scope and beats, and video.ready carries the scope.
    const v2 = await h.deps.store.getVersion(id, 2)
    expect(v2?.status).toBe('ready')
    expect(v2?.scope).toEqual({ beats: ['demo'] })
    expect(v2?.beats?.map((b) => b.id)).toEqual(['intro', 'demo', 'outro'])
    await deliverWebhooks(h.deps, { deadline: Date.now() + 5000, maxItems: 20 })
    const ready = h.deps.http.calls
      .map((c) => c.body)
      .find((b) => b.includes('"scope":{"beats":[{"id":"demo"'))
    expect(ready).toBeDefined()
    step('ready', { webhook: true })

    // 4. A run that also changed a frozen scene: refused, nothing stored.
    h.deps.nextSource = archive(
      edit((d) => {
        text(d, 'demo-sub', 'Ship on Friday')
        text(d, 'intro-title', 'Org hooks')
      }),
      summary,
    )
    const r3 = await h.call('POST', `/api/v1/videos/${id}/versions`, {
      as: h.member,
      body: { prompt: 'Again.', fromVersion: 1, scope: { beats: ['demo'] } },
    })
    expect(r3.status).toBe(202)
    const sets: string[] = []
    const set = h.deps.blobs.set.bind(h.deps.blobs)
    h.deps.blobs.set = async (s, k, b, m) => {
      if (k.startsWith(`${id}/v3`)) sets.push(k)
      return set(s, k, b, m)
    }
    await h.drive(4)
    const failed = (await h.attempts(id)).find((a) => a.versionN === 3)
    expect(failed?.errorCategory).toBe('invalid_output')
    expect(failed?.errorMessage?.startsWith(SCOPE_REFUSED_PREFIX)).toBe(true)
    expect(sets).toEqual([])
    step('refused', { message: failed?.errorMessage?.slice(0, 80) })

    // 5. Its retry carries the refusal in a fence.
    expect((await h.call('POST', `/api/v1/videos/${id}/versions/3/retry`, { as: h.member })).status).toBe(202)
    await h.drive(4)
    expect((await started(h, 3)).prompt).toContain(
      'The previous attempt was refused for changing these parts outside the scope',
    )
    step('retry')

    // 6. The same request through MCP.
    const key = await apiKey(h, h.member)
    const res = await h.call('POST', '/api/mcp', {
      origin: null,
      headers: { accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'revise_video',
          arguments: {
            video_id: id,
            from_version: 2,
            beats: ['outro'],
            change: 'Make the call to action bolder.',
          },
        },
      },
    })
    const mcp = (await res.json()) as { result: { isError?: boolean } }
    expect(mcp.result.isError ?? false).toBe(false)
    const latest = (await h.deps.store.listVersions(id))[0]
    expect(latest?.scope).toEqual({ beats: ['outro'] })
    expect(latest?.parentN).toBe(2)
    step('mcp', { version: latest?.n })
  }, 60_000)
})
