// Fit the video to my narration (plan 2026-11-02 §6.4, bead va-2qq.6.1): renderEdit freezes the edited draft with
// the narration (AI voice always replaced, target = audible end + 0.5 s in whole frames) as an authoring version; the
// reconciler writes an author_from_frozen run manifest that restores that draft, never the parent's archive; the
// verifier carries its bundle and narration; prepare-run keeps the whole frozen composition for the guard and tells
// scripts/narration.ts to mix at the frozen target. A retry starts from the same frozen inputs.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCleanup } from '../src/domain/cleanup.js'
import { bundleManifest, manifestHash } from '../src/lib/bundle-manifest.js'
import { isReference } from '../src/lib/bundle-references.js'
import { NARRATION_SRC } from '../src/lib/contract.js'
import { FROZEN_DIR } from '../src/lib/revoice.js'
import {
  RUN_MANIFEST_VERSION,
  runManifestKey,
  serializeRunManifest,
  sha256Hex,
  verifyRunManifest,
  type FrozenNarration,
  type RunManifest,
} from '../src/lib/run-manifest.js'
import { readTarGz } from '../src/lib/tar.js'
import { fitTarget } from '../src/lib/timeline.js'
import { prepare } from '../scripts/prepare-run.js'
import { readNarrationInputs } from '../scripts/lib/narration-inputs.js'
import { which } from '../scripts/lib/run-tools.js'
import { failedSnap, running } from './fakes.js'
import { harness, type Harness } from './helpers.js'
import {
  BUS,
  S,
  contractSource,
  draftNarration,
  narratedDraft,
  narrationOp,
  render,
  report,
} from './narration-render.js'

const ffmpeg = which('ffmpeg') && which('ffprobe')
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const fit = (h: Harness, editId: string, body: object = {}) =>
  h.call('POST', `/api/v1/edits/${editId}/render`, {
    as: h.member,
    body: { mode: 'fit_to_narration', ...body },
  })
const error = async (res: Response) => {
  const body = (await res.json()) as { error: { code: string; message: string } }
  return { status: res.status, ...body.error }
}

/** A fitted draft whose one take plays 1 s at `at` seconds, with the AI voice set to `mode` in the editor. */
async function fitted(h: Harness, at = 9.5, mode = 'keep') {
  const { id, editId } = await narratedDraft(h, 1)
  const take = (await h.deps.store.getEdit(editId))!.ops[0] as { clips: { mediaId: string }[] }
  const op = narrationOp([take.clips[0]!.mediaId], at)
  op.tracks.aiVoice = { mode, volumeDb: -12 }
  const e = await draftNarration(h, id, 1, op)
  return { id, editId: e, op }
}

/** The run manifest the reconciler wrote for start `i`, verified against the hash in its prompt. */
async function manifestOf(h: Harness, id: string, i: number) {
  const req = h.deps.runner.starts[i]!
  const sha = /--manifest ([0-9a-f]{64})/.exec(req.prompt)?.[1] ?? ''
  const raw = new TextDecoder().decode(await h.deps.blobs.get('sources', runManifestKey(id, req.requestId)))
  return verifyRunManifest(raw, { attemptId: req.requestId, sha256: sha })
}

describe('renderEdit fit_to_narration', () => {
  it('freezes the edited draft as an authoring version: AI voice replaced, target = end + 0.5 s in frames', async () => {
    const h = harness({ MAX_ACTIVE_RUNS: '0' })
    const { id, editId } = await fitted(h)
    expect((await fit(h, editId)).status).toBe(202)
    const v = (await h.deps.store.getVersion(id, 2))!
    // The narration ends at 10.5 s: + 0.5 s is 11 s, 330 frames, past the 9 s of visuals the agent will stretch.
    expect(v).toMatchObject({ mode: 'author', editedFromN: 1, parentN: 1, targetDurationSec: 11 })
    const n = v.frozen!.narration!
    expect(n.targetSamples).toBe(11 * S)
    expect(n.targetSamples).toBe(fitTarget(n.op.clips, 30))
    // Keep (or Under) applies to keep-visuals renders only (§12 decision 11).
    expect(n.op.tracks.aiVoice.mode).toBe('replace')
    expect(v.frozen!.editId).toBe(editId)
    // The frozen archive is the edited draft with its narration layer, without a bus (the run mixes it).
    const files = readTarGz((await h.deps.blobs.get('sources', v.frozen!.key))!)
    expect(new TextDecoder().decode(files.get('index.html'))).toContain('id="va-narration"')
    expect([...files.keys()]).not.toContain('assets/narration/bus.wav')
    const dto = await h.json(await h.call('GET', `/api/v1/videos/${id}`, { as: h.member }))
    expect(dto.versions[0]).toMatchObject({ n: 2, mode: 'author', editedFromN: 1 })
  })

  it('a target shorter than the visuals is fine: the agent tightens them', async () => {
    const h = harness({ MAX_ACTIVE_RUNS: '0' })
    const { id, editId } = await fitted(h, 2)
    expect((await fit(h, editId)).status).toBe(202)
    expect((await h.deps.store.getVersion(id, 2))!.frozen!.narration!.targetSamples).toBe(3.5 * S)
  })

  it('refuses a draft without narration, a held frame, leaving the narration out, or a target past the limit', async () => {
    const h = harness({ MAX_ACTIVE_RUNS: '0' })
    const { id, editId } = await fitted(h)
    expect(await error(await fit(h, editId, { holdFinalFrame: true }))).toMatchObject({
      status: 400,
      message: expect.stringContaining('neither holds the last frame'),
    })
    expect((await fit(h, editId, { excludeNarration: true })).status).toBe(400)
    // Narration ending right at the output limit (9 s + 120 s) saves, but its post-roll would pass it.
    const far = await fitted(h, 128)
    expect(await error(await fit(h, far.editId))).toMatchObject({
      status: 400,
      message: expect.stringContaining('129s at most'),
    })
    // A draft whose only edit is a retime has nothing to fit to.
    const e = await h.json<{ id: string; rev: number }>(
      await h.call('POST', `/api/v1/videos/${id}/versions/1/edits`, { as: h.admin }),
    )
    await h.call('PUT', `/api/v1/edits/${e.id}`, {
      as: h.admin,
      body: { rev: e.rev, ops: [{ op: 'retime', beat: 'intro', duration: 2 }] },
    })
    const none = await h.call('POST', `/api/v1/edits/${e.id}/render`, {
      as: h.admin,
      body: { mode: 'fit_to_narration' },
    })
    expect(await error(none)).toMatchObject({
      status: 400,
      message: expect.stringContaining('needs recorded narration'),
    })
    expect((await h.deps.store.listVersions(id)).map((v) => v.n)).toEqual([1])
  })
})

describe('run manifest author_from_frozen', () => {
  const H = (c: string) => c.repeat(64)
  const narration = (): FrozenNarration => ({
    op: narrationOp(['med_abcdef12']) as FrozenNarration['op'],
    takes: [{ mediaId: 'med_abcdef12', key: 'med_abcdef12/original.wav', sha256: H('e'), bytes: 1000 }],
    recipe: { pipeline: 1, cleanup: 'light' },
    targetSamples: 11 * S,
    captions: 'sidecar',
  })
  const manifest = (over: Partial<RunManifest> = {}): RunManifest => ({
    v: RUN_MANIFEST_VERSION,
    jobId: 'vid_1',
    attemptId: 'att_1',
    versionN: 2,
    kind: 'author_from_frozen',
    source: null,
    bundle: { key: 'vid_1/v2/frozen.tar.gz', sha256: H('b'), manifestHash: H('c'), narration: narration() },
    media: null,
    feedback: null,
    ...over,
  })
  const verify = (m: RunManifest) => {
    const raw = serializeRunManifest(m)
    return verifyRunManifest(raw, { attemptId: 'att_1', sha256: sha256Hex(raw) })
  }

  it('the serializer carries the bundle and its narration, and the verifier gives them back', () => {
    expect(verify(manifest())).toEqual(manifest())
    const revoice = { beats: ['intro'], keptHash: H('d') }
    expect(verify(manifest({ bundle: { ...manifest().bundle!, revoice } })).bundle?.revoice).toEqual(revoice)
  })

  it('refuses a fit without a frozen narration, or with a source to restore', () => {
    const bare = { ...manifest().bundle!, narration: undefined }
    expect(() => verify(manifest({ bundle: bare }))).toThrow('needs a frozen bundle with narration')
    expect(() => verify(manifest({ bundle: null }))).toThrow('needs a frozen bundle with narration')
    expect(() =>
      verify(manifest({ source: { key: 'vid_1/v1/source.tar.gz', sha256: H('a'), parentN: 1 } })),
    ).toThrow('needs a frozen bundle with narration')
    expect(() => verify({ ...manifest(), kind: 'fit' as RunManifest['kind'] })).toThrow('Unknown run kind')
  })
})

describe('reconciler <-> prepare-run for a fit', () => {
  /** prepare-run's fetch over the fake stores. */
  const fetchFrom =
    (h: Harness) => async (key: string, to: string, store?: 'sources' | 'videos' | 'media') => {
      const b = await h.deps.blobs.get(store ?? 'sources', key)
      if (!b) throw new Error(`no blob ${store ?? 'sources'}/${key}`)
      writeFileSync(to, b)
    }

  it.skipIf(!ffmpeg)(
    'restores the frozen edited draft (not v1), keeps all of it for the guard, and mixes at the frozen target',
    async () => {
      const h = harness()
      const { id, editId } = await fitted(h)
      // Make the draft's composition differ from v1's archive, so restoring the parent would show.
      const e = (await h.deps.store.getEdit(editId))!
      await h.call('PUT', `/api/v1/edits/${editId}`, {
        as: h.member,
        body: { rev: e.rev, ops: [...e.ops, { op: 'retime', beat: 'intro', duration: 2 }] },
      })
      h.deps.runner.nextScripts.push({ timeline: [running()] })
      expect((await fit(h, editId)).status).toBe(202)
      await h.drive(2)
      const v = (await h.deps.store.getVersion(id, 2))!
      const m = await manifestOf(h, id, 1)
      expect(m).toMatchObject({ kind: 'author_from_frozen', source: null })
      expect(m.bundle).toMatchObject({
        key: v.frozen!.key,
        sha256: v.frozen!.sha256,
        manifestHash: v.frozen!.manifestHash,
      })
      expect(m.bundle?.narration).toEqual(v.frozen!.narration)
      const root = mkdtempSync(join(tmpdir(), 'va-fit-'))
      dirs.push(root)
      await prepare(m, { tmp: root, root, fetch: fetchFrom(h) })
      const html = readFileSync(join(root, 'video', 'index.html'), 'utf8')
      const frozen = new TextDecoder().decode(
        readTarGz((await h.deps.blobs.get('sources', v.frozen!.key))!).get('index.html'),
      )
      expect(html).toBe(frozen)
      expect(html).toMatch(/data-va-beat="intro"[^>]*data-duration="2"/)
      // The whole frozen composition is kept, and it proves itself against the bundle's manifest hash.
      const kept = bundleManifest(join(root, FROZEN_DIR)).files.filter((f) => !isReference(f.path))
      expect(kept.map((f) => f.path)).toEqual(expect.arrayContaining(['index.html', 'summary.json']))
      expect(manifestHash(kept, [])).toBe(m.bundle!.manifestHash)
      // scripts/narration.ts mixes at the frozen target, which the run inputs say.
      expect(readNarrationInputs(root)).toMatchObject({ fit: true, targetSamples: 11 * S })
    },
    60_000,
  )

  it('a retry after the draft expired restores the same frozen inputs', async () => {
    const h = harness()
    const { id, editId } = await fitted(h)
    h.deps.runner.nextScripts.push({ timeline: [running(), failedSnap()] })
    expect((await fit(h, editId)).status).toBe(202)
    await h.drive(5)
    expect((await h.deps.store.getVersion(id, 2))?.status).toBe('failed')
    const first = await manifestOf(h, id, 1)
    h.deps.clock.advance(8 * 24 * 3600_000)
    await runCleanup(h.deps, { deadline: Date.now() + 5000, maxItems: 10 })
    expect(await h.deps.store.getEdit(editId)).toBeNull()
    h.deps.runner.nextScripts.push({ timeline: [running()] })
    expect((await h.call('POST', `/api/v1/videos/${id}/versions/2/retry`, { as: h.member })).status).toBe(202)
    await h.drive(2)
    const again = await manifestOf(h, id, 2)
    expect(again.attemptId).not.toBe(first.attemptId)
    expect(again).toMatchObject({ kind: 'author_from_frozen', source: null })
    expect(again.bundle).toEqual(first.bundle)
    expect(await h.deps.blobs.get('sources', first.bundle!.key)).not.toBeNull()
  })
})

describe('the fit prompt and the lock through later revisions', () => {
  it('the fit run gets the fit prompt: exact target, locked narration, no voice-over instructions', async () => {
    const h = harness()
    const { id, editId } = await fitted(h)
    h.deps.runner.nextScripts.push({ timeline: [running()] })
    expect((await fit(h, editId)).status).toBe(202)
    await h.drive(2)
    const prompt = h.deps.runner.starts[1]!.prompt
    expect(prompt).toContain('Fit the video to that narration.')
    expect(prompt).toContain('exactly 11 seconds (330 frames at 30 fps)')
    expect(prompt).toContain('Never change, move or remove <audio id="va-narration">')
    expect(prompt).not.toContain('Voice-over: follow')
    expect((await manifestOf(h, id, 1)).kind).toBe('author_from_frozen')
  })

  it.skipIf(!ffmpeg)(
    'a revision of a narrated version keeps the narration locked, and prepare-run keeps its composition',
    async () => {
      vi.stubGlobal('Netlify', { env: { get: () => undefined } })
      try {
        const h = harness()
        const { id, editId } = await narratedDraft(h)
        h.deps.nextBus = BUS
        h.deps.nextExtra = { manifest: { narration: report() } }
        // v2's composition as its run saves it (plain file entries, as render-job's tar writes them).
        h.deps.nextSource = contractSource()
        expect((await render(h, editId)).status).toBe(202)
        await h.drive(4)
        expect((await h.deps.store.getVersion(id, 2))?.narration?.bus.samples).toBe(9 * S)
        h.deps.runner.nextScripts.push({ timeline: [running()] })
        await h.call('POST', `/api/v1/videos/${id}/versions`, {
          as: h.member,
          body: { prompt: 'Shorter title', fromVersion: 2 },
        })
        await h.drive(2)
        const req = h.deps.runner.starts.at(-1)!
        expect(req.prompt).toContain('Keep it exactly 9 seconds (270 frames at 30 fps)')
        expect(req.prompt).toContain('Never change, move or remove <audio id="va-narration">')
        const m = await manifestOf(h, id, h.deps.runner.starts.length - 1)
        expect(m.kind).toBe('revision')
        expect(m.source?.references?.map((r) => r.path)).toEqual([NARRATION_SRC])
        const root = mkdtempSync(join(tmpdir(), 'va-kept-'))
        dirs.push(root)
        const fetchFrom = async (key: string, to: string, store?: 'sources' | 'videos' | 'media') => {
          writeFileSync(to, (await h.deps.blobs.get(store ?? 'sources', key))!)
        }
        await prepare(m, { tmp: root, root, fetch: fetchFrom })
        expect(readFileSync(join(root, FROZEN_DIR, 'index.html'), 'utf8')).toBe(
          readFileSync(join(root, 'video', 'index.html'), 'utf8'),
        )
      } finally {
        vi.unstubAllGlobals()
      }
    },
    60_000,
  )
})
