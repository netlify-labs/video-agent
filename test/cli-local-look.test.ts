// local --look (looks plan §4.13; bead va-nifa.5.3): a Look bundled with the CLI or a look folder becomes the run's
// look exactly as on the runner: the server's archive bytes and hash, a manifest entry under <jobId>/looks/, the
// prompt's look lines, and prepare-run restoring it into context/look/.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolveLocalLook } from '../packages/cli/src/local/look.js'
import { prepareLocalRun } from '../packages/cli/src/local/run.js'
import { prepare } from '../scripts/prepare-run.js'
import { buildRuntime } from '../scripts/lib/cli-runtime.js'
import { looksCatalog } from '../src/generated/looks.js'
import { lookRunFiles } from '../src/lib/looks.js'
import { runManifestKey, sha256Hex, verifyRunManifest } from '../src/lib/run-manifest.js'

const repo = new URL('..', import.meta.url).pathname
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p))

/** A runtime with the repo's looks, as buildRuntime lays them out (run files only). */
function fakeRuntime() {
  const runtime = tmp('va-rt-')
  for (const l of looksCatalog)
    for (const f of lookRunFiles(join(repo, 'looks', l.id))) {
      mkdirSync(join(runtime, 'looks', l.id, f, '..'), { recursive: true })
      cpSync(join(repo, 'looks', l.id, f), join(runtime, 'looks', l.id, f))
    }
  return runtime
}

describe('local --look', () => {
  it('resolves a bundled id to the same archive hash the server snapshots', () => {
    const runtime = fakeRuntime()
    for (const entry of looksCatalog) {
      const look = resolveLocalLook(entry.id, runtime)
      expect([look.id, look.name, look.hash]).toEqual([entry.id, entry.name, entry.hash])
    }
  })

  it("takes a look folder by path, checked by look.json's own id; refuses unknown ids and broken folders", () => {
    const runtime = fakeRuntime()
    const dir = join(tmp('va-mylook-'), 'drafts')
    cpSync(join(repo, 'looks', 'clean'), dir, { recursive: true })
    const look = resolveLocalLook(dir, runtime)
    expect(look.id).toBe('clean')
    expect(() => resolveLocalLook('nope', runtime)).toThrow(/no Look called "nope".*clean/)
    expect(() => resolveLocalLook('./does-not-exist', runtime)).toThrow(/no such look folder/)
    writeFileSync(join(dir, 'look.json'), JSON.stringify({ id: 'clean', name: '' }))
    expect(() => resolveLocalLook(dir, runtime)).toThrow(/look\.json/)
  })

  it('goes into the run as on the runner: inputs, manifest, prompt, then context/look/ after prepare-run', async () => {
    const look = resolveLocalLook('kinetic', fakeRuntime())
    const ws = tmp('va-ws-')
    const run = prepareLocalRun(ws, { prompt: 'A launch video.', aspect: '16:9', look }, () => {})
    const key = `${run.jobId}/looks/${look.hash}.tar.gz`
    expect(readFileSync(join(ws, '.va-inputs', 'sources', key))).toEqual(Buffer.from(look.bytes))
    const raw = readFileSync(
      join(ws, '.va-inputs', 'sources', runManifestKey(run.jobId, run.attemptId)),
      'utf8',
    )
    const manifest = verifyRunManifest(raw, { attemptId: run.attemptId, sha256: sha256Hex(raw) })
    expect(manifest.look).toEqual({ id: 'kinetic', key, sha256: look.sha256, hash: look.hash })
    expect(run.prompt).toContain('Read context/look/LOOK.md')
    expect(run.prompt).toContain('{"id":"kinetic","name":"Kinetic type"}')

    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = tmp('va-root-')
    await prepare(manifest, {
      tmp: root,
      root,
      fetch: async (k, to) => writeFileSync(to, readFileSync(join(ws, '.va-inputs', 'sources', k))),
    })
    expect(readFileSync(join(root, 'context', 'look', 'LOOK.md'), 'utf8')).toContain('Kinetic type')
    vi.restoreAllMocks()
  })

  it('a run without --look has no look', () => {
    const ws = tmp('va-ws-')
    const run = prepareLocalRun(ws, { prompt: 'A launch video.', aspect: '16:9' }, () => {})
    expect(run.prompt).not.toContain('context/look')
    expect(existsSync(join(ws, '.va-inputs', 'sources', run.jobId, 'looks'))).toBe(false)
  })

  it("the CLI's runtime bundles every look's run files, no previews", async () => {
    const out = tmp('va-runtime-')
    const report = await buildRuntime({ repo, out, lockfile: false })
    expect(report.looks).toEqual(looksCatalog.map((l) => l.id).sort())
    expect(existsSync(join(out, 'looks', 'kinetic', 'LOOK.md'))).toBe(true)
    expect(existsSync(join(out, 'looks', 'kinetic', 'preview.mp4'))).toBe(false)
    expect(existsSync(join(out, 'looks', '_template'))).toBe(false)
    expect(resolveLocalLook('whiteboard', out).hash).toBe(
      looksCatalog.find((l) => l.id === 'whiteboard')?.hash,
    )
  }, 120_000)
})
