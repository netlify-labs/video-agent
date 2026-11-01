// Render-unchanged (plan v2 §8, §14 rules 19, 21): a draft is frozen into version-owned storage and rendered as is.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { prepare } from '../scripts/prepare-run.js'
import { runCleanup } from '../src/domain/cleanup.js'
import { excluded, manifestHash } from '../src/lib/bundle-manifest.js'
import { sha256Hex } from '../src/lib/crypto.js'
import { runManifestKey, verifyRunManifest } from '../src/lib/run-manifest.js'
import { readTarGz } from '../src/lib/tar.js'
import type { Role } from '../src/domain/types.js'
import { failedSnap, running, succeeded } from './fakes.js'
import { harness, type Harness } from './helpers.js'
import { tarGz } from './tarball.js'

const PROMPT = 'A short launch video for org webhooks, with three beats and an end card.'
const fx = (f: string) => readFileSync(new URL(`./fixtures/contract1/${f}`, import.meta.url), 'utf8')

async function draft(h: Harness) {
  h.deps.nextSource = tarGz([
    { name: 'video/index.html', body: fx('index.html') },
    { name: 'video/summary.json', body: fx('summary.json') },
  ])
  const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
  await h.drive(4)
  const e = await h.json<{ id: string }>(
    await h.call('POST', `/api/v1/videos/${v.id}/versions/1/edits`, { as: h.member }),
  )
  await h.call('PUT', `/api/v1/edits/${e.id}`, {
    as: h.member,
    body: {
      rev: 0,
      ops: [
        { op: 'retime', beat: 'intro', duration: 4.5 },
        { op: 'text', id: 'outro-cta', text: 'Start free today' },
      ],
    },
  })
  return { id: v.id as string, editId: e.id }
}
const render = (h: Harness, editId: string, key?: string) =>
  h.call('POST', `/api/v1/edits/${editId}/render`, {
    as: h.member,
    ...(key ? { headers: { 'idempotency-key': key } } : {}),
  })

describe('render unchanged', () => {
  it('freezes the draft and queues an edited version with a frame-accurate target', async () => {
    const h = harness({ MAX_ACTIVE_RUNS: '0' })
    const { id, editId } = await draft(h)
    const res = await render(h, editId)
    expect(res.status).toBe(202)
    const v = await h.json(res)
    expect(v.versions[0]).toMatchObject({
      n: 2,
      status: 'queued',
      mode: 'render_unchanged',
      editedFromN: 1,
      parentN: 1,
      targetDurationSec: 10.5,
    })
    const version = await h.deps.store.getVersion(id, 2)
    const archive = (await h.deps.blobs.get('sources', version!.frozen!.key))!
    expect(sha256Hex(archive)).toBe(version!.frozen!.sha256)
    const files = readTarGz(archive)
    expect(new TextDecoder().decode(files.get('index.html'))).toContain('Start free today')
    const summary = JSON.parse(new TextDecoder().decode(files.get('summary.json'))) as {
      captions: { start: number }[]
    }
    expect(summary.captions.map((c) => c.start)).toEqual([0.6, 5, 7.7])
    const list = [...files].filter(([p]) => !excluded(p)).map(([path, b]) => ({ path, sha256: sha256Hex(b) }))
    expect(manifestHash(list, [])).toBe(version!.frozen!.manifestHash)
    // Rendering again, or editing further, is refused.
    expect((await render(h, editId)).status).toBe(409)
    expect(
      (await h.call('PUT', `/api/v1/edits/${editId}`, { as: h.member, body: { rev: 1, ops: [] } })).status,
    ).toBe(409)
  })

  it('the run restores and verifies the frozen bundle (prepare-run) and is told not to change it', async () => {
    const h = harness()
    const { id, editId } = await draft(h)
    await render(h, editId)
    await h.drive(2)
    const req = h.deps.runner.starts[1]
    expect(req?.prompt).toContain('exactly as someone edited it in the browser from version 1')
    expect(req?.prompt).toContain("Don't write, change or delete any file in video/.")
    const sha = /--manifest ([0-9a-f]{64})/.exec(req?.prompt ?? '')?.[1] ?? ''
    const raw = new TextDecoder().decode(
      await h.deps.blobs.get('sources', runManifestKey(id, req?.requestId ?? '')),
    )
    const m = verifyRunManifest(raw, { attemptId: req?.requestId ?? '', sha256: sha })
    expect(m).toMatchObject({ kind: 'render_unchanged', source: null })
    // prepare-run restores it into a fresh video/ and the canonical manifest matches.
    const root = mkdtempSync(join(tmpdir(), 'va-ru-'))
    await prepare(m, {
      tmp: root,
      root,
      fetch: async (key, to) => {
        const { writeFileSync } = await import('node:fs')
        writeFileSync(to, (await h.deps.blobs.get('sources', key))!)
      },
    })
    expect(readFileSync(join(root, 'video', 'index.html'), 'utf8')).toContain('Start free today')
  })

  it('a retry after the draft expired still renders the frozen input', async () => {
    const h = harness()
    const { id, editId } = await draft(h)
    // The fake render is 2 s long: make the edited composition 2 s too, so finalize's length check passes.
    await h.call('PUT', `/api/v1/edits/${editId}`, {
      as: h.member,
      body: {
        rev: 1,
        ops: [
          { op: 'retime', beat: 'intro', duration: 0.5 },
          { op: 'retime', beat: 'demo', duration: 0.5 },
          { op: 'retime', beat: 'outro', duration: 1 },
        ],
      },
    })
    h.deps.runner.nextScripts.push({ timeline: [running(), failedSnap()] })
    await render(h, editId)
    await h.drive(5)
    expect((await h.deps.store.getVersion(id, 2))?.status).toBe('failed')
    h.deps.clock.advance(8 * 24 * 3600_000)
    await runCleanup(h.deps, { deadline: Date.now() + 5000, maxItems: 10 })
    expect(await h.deps.store.getEdit(editId)).toBeNull()
    expect((await h.call('POST', `/api/v1/videos/${id}/versions/2/retry`, { as: h.member })).status).toBe(202)
    await h.drive(4)
    const v = await h.json(await h.call('GET', `/api/v1/videos/${id}`, { as: h.member }))
    expect(v.versions[0].error).toBeNull()
    expect(v.versions[0]).toMatchObject({ n: 2, status: 'ready', mode: 'render_unchanged' })
    expect(h.deps.runner.starts.at(-1)?.prompt).toContain('exactly as someone edited it')
  })

  it('is idempotent, one version at a time, and Creators or Admins only', async () => {
    const h = harness({ MAX_ACTIVE_RUNS: '0' })
    const { id, editId } = await draft(h)
    const a = await render(h, editId, 'k1')
    const b = await render(h, editId, 'k1')
    expect(a.status).toBe(202)
    expect(b.status).toBe(202)
    expect((await h.json(b)).latestVersion).toBe(2)
    expect((await h.deps.store.listVersions(id)).length).toBe(2)
    // Another person's draft can't render while v2 is unfinished.
    const bob = h.deps.identity.addUser({ id: 'u_bob', email: 'bob@acme.com', name: 'Bob' }).cookie
    await h.call('GET', '/api/v1/me', { as: bob })
    const bobs = await h.json<{ id: string }>(
      await h.call('POST', `/api/v1/videos/${id}/versions/1/edits`, { as: bob }),
    )
    expect((await h.call('POST', `/api/v1/edits/${bobs.id}/render`, { as: bob })).status).toBe(409)
    const rita = h.deps.identity.addUser({ id: 'u_rita', email: 'rita@acme.com', name: 'Rita' }).cookie
    await h.call('GET', '/api/v1/me', { as: rita })
    await h.call('PATCH', '/api/v1/users/u_rita', { as: h.admin, body: { role: 'reviewer' satisfies Role } })
    expect((await h.call('POST', `/api/v1/edits/${bobs.id}/render`, { as: rita })).status).toBe(403)
  })

  it("a run that stops on a failed check fails soon, with the agent's reason", async () => {
    const h = harness()
    const { id, editId } = await draft(h)
    h.deps.runner.nextScripts.push({
      timeline: [
        running(),
        succeeded(
          'Version 2 was not rendered.\n\nThe restore step worked. `npx hyperframes check` failed on one contrast error, so the run stopped before render-job.ts as instructed. Nothing was edited.',
        ),
      ],
    })
    await render(h, editId)
    await h.drive(6)
    const v = await h.json(await h.call('GET', `/api/v1/videos/${id}`, { as: h.member }))
    expect(v.versions[0]).toMatchObject({ n: 2, status: 'failed', mode: 'render_unchanged' })
    expect(v.versions[0].error.category).toBe('check_failed')
    expect(v.versions[0].error.message).toContain("The edited composition didn't pass its check")
    expect(v.versions[0].error.message).toContain('failed on one contrast error')
    expect(v.versions[0].error.message).toContain('Edit it again or ask for a revision instead.')
  })
})
