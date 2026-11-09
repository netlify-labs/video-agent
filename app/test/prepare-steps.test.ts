// prepare-run's step order (render-engines plan §4.3): the engine's scaffold for author runs, a restore then its
// hydrate for every other kind, then media, then the stills last; one prepare.step log line per step.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepare } from '../../scripts/prepare-run.js'
import { bundleManifest } from '../server/lib/bundle-manifest.js'
import { RUN_MANIFEST_VERSION, sha256Hex, type RunManifest } from '../server/lib/run-manifest.js'

const base: RunManifest = {
  v: RUN_MANIFEST_VERSION,
  jobId: 'vid_1',
  attemptId: 'att_1',
  versionN: 2,
  kind: 'author',
  source: null,
  bundle: null,
  media: null,
  feedback: null,
}

/** A composition archived like render-job does, and an empty workspace to prepare into. */
function setup() {
  const src = mkdtempSync(join(tmpdir(), 'va-src-'))
  mkdirSync(join(src, 'video'))
  writeFileSync(join(src, 'video', 'index.html'), '<div>v1</div>')
  writeFileSync(join(src, 'video', 'summary.json'), '{}')
  const archive = join(src, 'source.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', src, 'video'])
  const target = mkdtempSync(join(tmpdir(), 'va-target-'))
  mkdirSync(join(target, 'video'))
  return {
    target,
    sha256: sha256Hex(readFileSync(archive)),
    manifestHash: bundleManifest(join(src, 'video')).hash,
    fetch: async (_key: string, to: string) => {
      copyFileSync(archive, to)
    },
  }
}

/** Records each hook call with what video/ held at that moment. */
function stubEngine() {
  const calls: { hook: string; files: string[] }[] = []
  const seen = (hook: string) => async (dir: string) => {
    calls.push({ hook, files: existsSync(dir) ? readdirSync(dir).sort() : [] })
  }
  return { calls, engine: { scaffold: seen('scaffold'), hydrate: seen('hydrate') } }
}

function steps(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls
    .map((c) => JSON.parse(String(c[0])) as { step: string; name?: string; skipped?: boolean })
    .filter((l) => l.step === 'prepare.step')
    .map((l) => [l.name, l.skipped])
}

describe('prepare-run steps', () => {
  afterEach(() => vi.restoreAllMocks())

  it('scaffolds an author run and logs every step', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { target, fetch } = setup()
    const { calls, engine } = stubEngine()
    await prepare(base, { tmp: target, root: target, fetch, engine })
    expect(calls).toEqual([{ hook: 'scaffold', files: [] }])
    expect(steps(spy)).toEqual([
      ['source', false],
      ['media', true],
      ['look', true],
      ['recording', true],
      ['scope', true],
      ['stills', true],
    ])
  })

  it('hydrates a revision after its source is restored', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { target, fetch, sha256 } = setup()
    const { calls, engine } = stubEngine()
    await prepare(
      { ...base, kind: 'revision', source: { key: 'vid_1/v1/source.tar.gz', sha256, parentN: 1 } },
      { tmp: target, root: target, fetch, engine },
    )
    expect(calls).toEqual([{ hook: 'hydrate', files: ['index.html', 'summary.json'] }])
  })

  it('hydrates a render-unchanged run after its bundle is restored and checked', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { target, fetch, sha256, manifestHash } = setup()
    const { calls, engine } = stubEngine()
    await prepare(
      { ...base, kind: 'render_unchanged', bundle: { key: 'vid_1/v2/bundle.tar.gz', sha256, manifestHash } },
      { tmp: target, root: target, fetch, engine },
    )
    expect(calls).toEqual([{ hook: 'hydrate', files: ['index.html', 'summary.json'] }])
  })

  it('HyperFrames has neither hook, so the files on disk are what they were', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { target, fetch, sha256 } = setup()
    await prepare(
      { ...base, kind: 'revision', source: { key: 'vid_1/v1/source.tar.gz', sha256, parentN: 1 } },
      { tmp: target, root: target, fetch },
    )
    expect(readdirSync(join(target, 'video')).sort()).toEqual(['index.html', 'summary.json'])
    expect(steps(spy)[0]).toEqual(['source', false])
    const author = setup()
    await prepare(base, { tmp: author.target, root: author.target, fetch: author.fetch })
    expect(readdirSync(join(author.target, 'video'))).toEqual([])
    // source, media, look, recording, scope, stills: the author run's source step is the sixth from the end.
    expect(steps(spy).at(-6)).toEqual(['source', true])
  })

  it('stops on an engine the manifest names that this repo has no code for', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { target, fetch } = setup()
    await expect(
      prepare({ ...base, engine: { id: 'lottie' } as never }, { tmp: target, root: target, fetch }),
    ).rejects.toThrow(/unknown engine/)
  })
})
