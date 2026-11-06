// A version's look on the run path (plan 2026-11-04-looks §4.6): the reconciler writes the look into the run manifest
// (a look alone is enough to write one), puts the look lines (and restyle lines) in the prompt, and fails an attempt
// before any run starts when the snapshot is gone. Versions here get their look set by hand; creating with a look is
// va-nifa.3.4.
import { describe, expect, it } from 'vitest'
import { getSettings } from '../src/domain/settings.js'
import type { VersionLook } from '../src/domain/types.js'
import { runManifestKey, sha256Hex, verifyRunManifest } from '../src/lib/run-manifest.js'
import { harness, PROMPT, type Harness } from './helpers.js'

/** Creates a video while the queue is paused, gives v1 a look (and its blob unless `missing`), then resumes. */
async function withLook(h: Harness, o: { restyle?: boolean; missing?: boolean } = {}) {
  await getSettings(h.deps) // the settings row is made on first read; pausing needs it
  await h.deps.store.updateSettings({ queuePausedReason: 'test: set the look before the run starts' })
  const { id } = await h.json<{ id: string }>(
    await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
  )
  const entry = h.deps.looks.catalog().find((l) => l.id === 'kinetic')!
  const look: VersionLook = {
    id: entry.id,
    name: entry.name,
    hash: entry.hash,
    key: `${id}/looks/${entry.hash}.tar.gz`,
    sha256: entry.sha256,
    bytes: entry.bytes,
    source: 'builtin',
    restyle: o.restyle ?? false,
  }
  if (!o.missing) await h.deps.blobs.set('sources', look.key, await h.deps.looks.archive('kinetic'))
  await h.deps.store.updateVersion(id, 1, { look })
  await h.deps.store.updateSettings({ queuePausedReason: null })
  await h.drive(1)
  return { id, look }
}

async function manifestOf(h: Harness, id: string) {
  const [a] = await h.attempts(id)
  const raw = await h.deps.blobs.get('sources', runManifestKey(id, a!.id))
  const text = new TextDecoder().decode(raw)
  return verifyRunManifest(text, { attemptId: a!.id, sha256: sha256Hex(text) })
}

describe('a version with a look', () => {
  it('gets a run manifest with the look, and the look lines in its prompt', async () => {
    const h = harness()
    const { id, look } = await withLook(h)
    const m = await manifestOf(h, id)
    expect(m.kind).toBe('author')
    expect(m.look).toEqual({ id: look.id, key: look.key, sha256: look.sha256, hash: look.hash })
    const prompt = h.deps.runner.starts.at(-1)!.prompt
    expect(prompt).toContain('First run: npx tsx scripts/prepare-run.ts')
    expect(prompt).toContain('The look for this video is in context/look/')
    expect(prompt).toContain('{"id":"kinetic","name":"Kinetic"}')
    expect(prompt).not.toContain('This is a restyle')
    expect(h.deps.logs.some((l) => l.includes('"run.manifest"') && l.includes('"look":"kinetic"'))).toBe(true)
  })

  it('a restyle gets the restyle lines', async () => {
    const h = harness()
    await withLook(h, { restyle: true })
    expect(h.deps.runner.starts.at(-1)!.prompt).toContain('This is a restyle into that look.')
  })

  it('without a look nothing changes: no manifest for a plain author run', async () => {
    const h = harness()
    const { id } = await h.json<{ id: string }>(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
    )
    await h.drive(1)
    const [a] = await h.attempts(id)
    expect(await h.deps.blobs.get('sources', runManifestKey(id, a!.id))).toBeNull()
    expect(h.deps.runner.starts.at(-1)!.prompt).not.toContain('context/look')
  })

  it('fails the attempt before any run starts when the snapshot is missing', async () => {
    const h = harness()
    const before = h.deps.runner.starts.length
    const { id, look } = await withLook(h, { missing: true })
    const [a] = await h.attempts(id)
    expect(a?.stage).toBe('failed')
    expect(JSON.stringify(a)).toContain(
      "This video's look snapshot is missing; restyle it to pick the look again.",
    )
    expect(h.deps.runner.starts.length).toBe(before)
    expect(h.deps.logs.some((l) => l.includes('look.preflight_failed') && l.includes(look.key))).toBe(true)
  })
})
