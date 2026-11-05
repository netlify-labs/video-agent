// prepare-run's look step (plan 2026-11-04-looks §4.6 step 3): the snapshot is unpacked into context/look/, checked by
// sha256, entry paths and look hash, after library media and before scope files; any mismatch stops the run.
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepare } from '../scripts/prepare-run.js'
import { buildLookArchive } from '../src/lib/looks.js'
import { RUN_MANIFEST_VERSION, sha256Hex, type RunManifest } from '../src/lib/run-manifest.js'
import { tarGz } from './tarball.js'

const enc = (s: string) => new TextEncoder().encode(s)
const files = new Map<string, Uint8Array>([
  ['look.json', enc('{"id":"kinetic"}')],
  ['LOOK.md', enc('# Kinetic\n')],
  ['example/index.html', enc('<html></html>')],
])

function setup(archive: Uint8Array) {
  const root = mkdtempSync(join(tmpdir(), 'va-look-'))
  const fetched: string[] = []
  const fetch = async (key: string, to: string) => {
    fetched.push(key)
    writeFileSync(to, archive)
  }
  return { root, fetch, fetched }
}

const manifest = (look: RunManifest['look']): RunManifest => ({
  v: RUN_MANIFEST_VERSION,
  jobId: 'vid_1',
  attemptId: 'att_1',
  versionN: 1,
  kind: 'author',
  source: null,
  bundle: null,
  media: null,
  feedback: null,
  look,
})

const steps = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls
    .map((c) => JSON.parse(String(c[0])) as { step: string; name?: string; skipped?: boolean; id?: string })
    .filter((l) => l.step === 'prepare.step' || l.step === 'look.restored')

describe('prepare-run: the look', () => {
  afterEach(() => vi.restoreAllMocks())

  it('unpacks the snapshot into context/look/ in step 3 and logs it', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = buildLookArchive(files)
    const { root, fetch, fetched } = setup(a.bytes)
    const key = `vid_1/looks/${a.hash}.tar.gz`
    await prepare(manifest({ id: 'kinetic', key, sha256: a.sha256, hash: a.hash }), {
      tmp: root,
      root,
      fetch,
    })
    expect(fetched).toEqual([key])
    expect(readFileSync(join(root, 'context', 'look', 'LOOK.md'), 'utf8')).toBe('# Kinetic\n')
    expect(readdirSync(join(root, 'context', 'look')).sort()).toEqual(['LOOK.md', 'example', 'look.json'])
    expect(existsSync(join(root, 'video', 'LOOK.md'))).toBe(false)
    expect(
      steps(spy).map((l) => (l.step === 'look.restored' ? 'restored' : `${l.name}:${l.skipped}`)),
    ).toEqual(['source:true', 'media:true', 'restored', 'look:false', 'scope:true', 'stills:true'])
  })

  it('refuses a hash mismatch, an entry outside look/, and a .. path', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = buildLookArchive(files)
    const ok = { id: 'kinetic', key: `vid_1/looks/${a.hash}.tar.gz`, sha256: a.sha256, hash: a.hash }

    const wrongSha = setup(a.bytes)
    await expect(
      prepare(manifest({ ...ok, sha256: sha256Hex('x') }), {
        tmp: wrongSha.root,
        root: wrongSha.root,
        fetch: wrongSha.fetch,
      }),
    ).rejects.toThrow(/saved look doesn't match its hash/)

    const wrongHash = setup(a.bytes)
    await expect(
      prepare(manifest({ ...ok, hash: sha256Hex('y') }), {
        tmp: wrongHash.root,
        root: wrongHash.root,
        fetch: wrongHash.fetch,
      }),
    ).rejects.toThrow(/restored look's files don't match/)
    expect(existsSync(join(wrongHash.root, 'context', 'look'))).toBe(false)

    for (const name of ['video/index.html', 'look/../evil.md']) {
      const bad = tarGz([{ name, body: 'x' }])
      const s = setup(bad)
      await expect(
        prepare(manifest({ ...ok, sha256: sha256Hex(bad) }), { tmp: s.root, root: s.root, fetch: s.fetch }),
      ).rejects.toThrow(/unexpected entry/)
    }
  })
})
