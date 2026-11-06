// Looks phase 2 gate (plan 2026-11-04-looks §10, bead va-nifa.3.16): the whole run path in the harness on both stores.
// A look reaches the run's manifest and prepare-run restores it; revisions inherit or restyle; a remix keeps its own
// copy; a retry after the catalog changes keeps the old snapshot; a missing snapshot fails before any run; the API,
// admin settings and MCP agree. One JSON line per step, so a failing step names itself.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { prepare } from '../scripts/prepare-run.js'
import { getSettings } from '../src/domain/settings.js'
import { runManifestKey, sha256Hex, verifyRunManifest } from '../src/lib/run-manifest.js'
import { failedSnap } from './fakes.js'
import { apiKey, harness, mcpCall, pgStore, PROMPT, type Harness } from './helpers.js'

interface Dto {
  id: string
  versions: { n: number; status: string; look: { id: string; name: string; hash: string } | null }[]
  error?: { code: string }
}

async function gate(h: Harness, store: string) {
  const started = Date.now()
  const step = (name: string, f: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ step: name, store, ok: true, ms: Date.now() - started, ...f }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await getSettings(h.deps)
  const post = async (path: string, body: unknown) => {
    const res = await h.call('POST', path, { as: h.member, body })
    return { status: res.status, body: await h.json<Dto>(res) }
  }
  const lookOf = (d: Dto, n: number) => d.versions.find((v) => v.n === n)?.look ?? null
  const manifest = async (jobId: string, n: number) => {
    const a = (await h.attempts(jobId)).filter((x) => x.versionN === n).at(-1)!
    const raw = new TextDecoder().decode((await h.deps.blobs.get('sources', runManifestKey(jobId, a.id))))
    return verifyRunManifest(raw, { attemptId: a.id, sha256: sha256Hex(raw) })
  }
  const lastPrompt = () => h.deps.runner.starts.at(-1)!.prompt

  // 1. Create with kinetic: the run's manifest has the look and prepare-run restores it into context/look/.
  const kinetic = h.deps.looks.catalog().find((l) => l.id === 'kinetic')!
  const a = await post('/api/v1/videos', { prompt: PROMPT, look: 'kinetic' })
  expect(a.status).toBe(202)
  await h.drive(1)
  const m1 = await manifest(a.body.id, 1)
  expect(m1.look).toMatchObject({ id: 'kinetic', hash: kinetic.hash })
  const root = mkdtempSync(join(tmpdir(), 'looks-gate-'))
  await prepare(m1, {
    tmp: root,
    root,
    fetch: async (key, to) => {
      const b = await h.deps.blobs.get('sources', key)
      if (!b) throw new Error(`missing ${key}`)
      writeFileSync(to, b)
    },
  })
  expect(readFileSync(join(root, 'context', 'look', 'LOOK.md'), 'utf8')).toContain('kinetic')
  await h.drive(4)
  step('create', { jobId: a.body.id, look: 'kinetic' })

  // 2. Revise without a look inherits the snapshot; with terminal it restyles (new snapshot, restyle lines).
  const r2 = await post(`/api/v1/videos/${a.body.id}/versions`, { prompt: 'Tighter' })
  expect(lookOf(r2.body, 2)).toEqual(lookOf(a.body, 1))
  await h.drive(4)
  const r3 = await post(`/api/v1/videos/${a.body.id}/versions`, {
    prompt: 'Like a terminal',
    look: 'terminal',
  })
  expect(lookOf(r3.body, 3)?.id).toBe('terminal')
  await h.drive(1)
  expect(lastPrompt()).toContain('This is a restyle into that look.')
  await h.drive(4)
  const r4 = await post(`/api/v1/videos/${a.body.id}/versions`, { prompt: 'No look', look: null })
  expect(lookOf(r4.body, 4)).toBeNull()
  await h.drive(1)
  expect(lastPrompt()).not.toContain('context/look')
  await h.drive(4)
  step('revise', { jobId: a.body.id })

  // 3. A remix keeps the source's look under its own prefix, and still runs once the source is deleted.
  const remix = await post(`/api/v1/videos/${a.body.id}/remix`, { prompt: 'For payments', fromVersion: 1 })
  expect(lookOf(remix.body, 1)?.id).toBe('kinetic')
  expect(await h.deps.blobs.get('sources', `${remix.body.id}/looks/${kinetic.hash}.tar.gz`)).not.toBeNull()
  expect((await h.call('DELETE', `/api/v1/videos/${a.body.id}`, { as: h.member })).status).toBe(202)
  await h.drive(4)
  expect((await manifest(remix.body.id, 1)).look?.key).toBe(`${remix.body.id}/looks/${kinetic.hash}.tar.gz`)
  step('remix', { jobId: remix.body.id })

  // 4. A failed attempt retried after the catalog changed keeps the old snapshot.
  h.deps.runner.nextScripts.push({ timeline: [failedSnap()] })
  const b = await post('/api/v1/videos', { prompt: PROMPT, look: 'kinetic' })
  await h.drive(4)
  h.deps.looks.entries = h.deps.looks.entries.map((e) =>
    e.id === 'kinetic' ? h.deps.looks.make('kinetic', { body: 'v2' }) : e,
  )
  expect(
    (await h.call('POST', `/api/v1/videos/${b.body.id}/versions/1/retry`, { as: h.member })).status,
  ).toBe(202)
  await h.drive(1)
  expect((await manifest(b.body.id, 1)).look?.hash).toBe(kinetic.hash)
  await h.drive(4)
  step('retry-after-change', { jobId: b.body.id })

  // 5. A missing snapshot fails the attempt before any run starts.
  h.deps.runner.nextScripts.push({ timeline: [failedSnap()] })
  const c = await post('/api/v1/videos', { prompt: PROMPT, look: 'clean' })
  await h.drive(4)
  const clean = h.deps.looks.catalog().find((l) => l.id === 'clean')!
  await h.deps.blobs.delete('sources', `${c.body.id}/looks/${clean.hash}.tar.gz`)
  const starts = h.deps.runner.starts.length
  await h.call('POST', `/api/v1/videos/${c.body.id}/versions/1/retry`, { as: h.member })
  await h.drive(2)
  expect(h.deps.runner.starts.length).toBe(starts)
  expect((await h.attempts(c.body.id)).at(-1)?.stage).toBe('failed')
  step('preflight', { jobId: c.body.id })

  // 6. Refusals: a disabled pick is 409 while an inherited one still runs; render with a look is 400.
  await h.call('PATCH', '/api/v1/admin/settings', { as: h.admin, body: { disabledLooks: ['kinetic'] } })
  expect((await post('/api/v1/videos', { prompt: PROMPT, look: 'kinetic' })).status).toBe(409)
  const inherit = await post(`/api/v1/videos/${remix.body.id}/versions`, { prompt: 'Again' })
  expect([inherit.status, lookOf(inherit.body, 2)?.id]).toEqual([202, 'kinetic'])
  const render = await h.call('POST', '/api/v1/edits/edt_unknown/render', {
    as: h.member,
    body: { look: 'clean' },
  })
  expect(render.status).toBe(400)
  step('refusals')

  // 7. GET /looks, admin settings and MCP list_looks agree.
  const looks = await h.json<{ looks: { id: string; enabled: boolean }[] }>(
    await h.call('GET', '/api/v1/looks', { as: h.member }),
  )
  const admin = await h.json<{ disabledLooks: string[] }>(
    await h.call('GET', '/api/v1/admin/settings', { as: h.admin }),
  )
  const mcp = await mcpCall(h, await apiKey(h, h.member), 'tools/call', { name: 'list_looks', arguments: {} })
  const listed = JSON.parse((mcp as { content: { text: string }[] }).content[0]!.text) as {
    looks: { id: string }[]
  }
  expect(looks.looks.filter((l) => !l.enabled).map((l) => l.id)).toEqual(admin.disabledLooks)
  expect(listed.looks.map((l) => l.id)).toEqual(looks.looks.filter((l) => l.enabled).map((l) => l.id))
  step('agree')
}

describe('looks phase 2 gate', () => {
  it('runs end to end (memory)', async () => {
    await gate(harness(), 'memory')
  }, 60_000)

  it('runs end to end (Postgres)', async () => {
    await gate(harness({}, { store: await pgStore() }), 'postgres')
  }, 120_000)
})
