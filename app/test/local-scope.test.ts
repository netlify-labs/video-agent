// `video-agent local revise --scene` (regenerate-beat plan §4.13; bead va-8cy4.5.14): scenes by id or label from the
// parent's source.tar.gz, the server's refusals before any agent runs (exit 2, or 7 without the contract), the scope
// in the run manifest and the scoped prompt, and finalize's check before anything is copied out.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXIT } from '../../packages/cli/src/exit.js'
import type { Io } from '../../packages/cli/src/io.js'
import { INPUTS_DIR, prepareLocalRun } from '../../packages/cli/src/local/run.js'
import { localScope, scopeRefusal } from '../../packages/cli/src/local/scope.js'
import { main } from '../../packages/cli/src/router.js'
import { fromInputs, prepare } from '../../scripts/prepare-run.js'
import { attr, editText, load, save, walk } from '../server/lib/contract.js'
import { runManifestKey, verifyRunManifest } from '../server/lib/run-manifest.js'
import { FROZEN_DIR } from '../server/lib/revoice.js'
import { SCOPE_LAYOUT_FILE, SCOPE_REFUSED_PREFIX, spliceBytes, spliceScoped } from '../server/lib/scope.js'
import { tarGz } from './tarball.js'

const music = save(
  load(readFileSync(new URL('./fixtures/contract1-music/index.html', import.meta.url), 'utf8')),
)
const summary = { title: 'Org webhooks', captions: [] }
const log = () => {}
const tmp = () => mkdtempSync(join(tmpdir(), 'va-local-scope-'))

/** A source.tar.gz on disk, as local mode saves it in ./videos/<slug>/vN/. */
function source(html: string, s: unknown = summary) {
  const path = join(tmp(), 'source.tar.gz')
  writeFileSync(
    path,
    tarGz([
      { name: 'video/index.html', body: html },
      { name: 'video/summary.json', body: typeof s === 'string' ? s : JSON.stringify(s) },
    ]),
  )
  return path
}
const edited = (id: string, value: string) => {
  const d = load(music)
  const el = [...walk(d.root)].find((e) => attr(e, 'data-va-text') === id)
  if (el) editText(el, value)
  return save(d)
}

describe('local revise --scene: scenes and refusals', () => {
  it('takes ids or labels, in the version’s order', () => {
    const s = localScope(source(music), ['outro', 'OPENING'], 1)
    expect(s.ids).toEqual(['intro', 'outro'])
    expect(s.beats.map((b) => [b.id, b.label])).toEqual([
      ['intro', 'Opening'],
      ['outro', null],
    ])
    expect(s.voiced).toBe(false)
  })

  it('refuses what the server refuses, and a version without the contract', () => {
    expect(() => localScope(source(music), ['feature'], 1)).toThrow(
      `There's no scene "feature". This version's scenes: intro (Opening), demo, outro.`,
    )
    expect(() => localScope(source(music), ['intro', 'demo', 'outro'], 1)).toThrow("That's every scene")
    expect(() =>
      localScope(source('<!doctype html><html><body>No contract.</body></html>'), ['demo'], 2),
    ).toThrow("v2 doesn't keep the editing contract")
  })

  it('the command refuses before any agent runs: exit 2 for a scene, 7 without the contract', async () => {
    const dir = tmp()
    mkdirSync(join(dir, 'v1'))
    writeFileSync(join(dir, 'v1', 'source.tar.gz'), readFileSync(source(music)))
    writeFileSync(
      join(dir, 'video.json'),
      JSON.stringify({
        title: 't',
        summary: '',
        jobId: 'loc_test',
        versions: [
          {
            n: 1,
            prompt: 'p',
            agent: 'fixture',
            createdAt: '',
            durationSec: 9,
            width: 1920,
            height: 1080,
            files: [],
          },
        ],
      }),
    )
    let stderr = ''
    const io: Io = {
      stdout: () => undefined,
      stderr: (t) => (stderr += t),
      stdin: async () => '',
      env: {},
      fetch: async () => new Response('no network in this test', { status: 500 }),
      now: () => Date.now(),
      openBrowser: async () => undefined,
      configDir: tmp(),
    }
    const run = (argv: string[]) => main(argv, io)
    expect(await run(['local', 'revise', dir, '--scene', 'feature', 'Redo it.', '--agent', 'fixture'])).toBe(
      EXIT.usage,
    )
    expect(stderr).toContain('There\'s no scene "feature"')
    writeFileSync(join(dir, 'v1', 'source.tar.gz'), readFileSync(source('<html><body>none</body></html>')))
    expect(await run(['local', 'revise', dir, '--scene', 'demo', 'Redo it.', '--agent', 'fixture'])).toBe(
      EXIT.conflict,
    )
  })
})

describe('local revise --scene: the run and the check', () => {
  it('puts the scope in the run manifest (no stills) and the scoped prompt', () => {
    const ws = tmp()
    mkdirSync(join(ws, 'video'))
    const parent = source(music)
    const scope = localScope(parent, ['demo'], 1)
    const run = prepareLocalRun(
      ws,
      {
        prompt: 'Make the subtitle say Ship on Friday.',
        aspect: '16:9',
        revision: { jobId: 'loc_test', parentN: 1, source: parent, scope },
      },
      log,
    )
    const raw = readFileSync(
      join(ws, INPUTS_DIR, 'sources', runManifestKey(run.jobId, run.attemptId)),
      'utf8',
    )
    const m = verifyRunManifest(raw, { attemptId: run.attemptId, sha256: run.manifestSha256 })
    expect(m.scope).toEqual({ beats: ['demo'], stills: [] })
    expect(run.prompt).toContain('This is a scoped revision of version 1')
  })

  it('prepare-run takes that manifest from the inputs, freezes the parent and writes its scope layout, as on the runner', async () => {
    const ws = tmp()
    mkdirSync(join(ws, 'video'))
    const parent = source(music)
    const run = prepareLocalRun(
      ws,
      {
        prompt: 'Redo the demo.',
        aspect: '16:9',
        revision: { jobId: 'loc_test', parentN: 1, source: parent, scope: localScope(parent, ['demo'], 1) },
      },
      log,
    )
    const raw = readFileSync(
      join(ws, INPUTS_DIR, 'sources', runManifestKey(run.jobId, run.attemptId)),
      'utf8',
    )
    await prepare(verifyRunManifest(raw, { attemptId: run.attemptId, sha256: run.manifestSha256 }), {
      tmp: tmp(),
      root: ws,
      fetch: fromInputs(join(ws, INPUTS_DIR)),
    })
    expect(existsSync(join(ws, FROZEN_DIR, SCOPE_LAYOUT_FILE))).toBe(true)
    expect(readFileSync(join(ws, FROZEN_DIR, 'index.html'), 'utf8')).toBe(music)
    expect(readFileSync(join(ws, 'video', 'index.html'), 'utf8')).toBe(music)
  })

  it('passes an honest splice of the right length, and refuses a frozen scene changed or a wrong length', () => {
    const parent = source(music)
    const spliced = spliceBytes(
      spliceScoped({
        parent: { html: music, summary },
        agent: { html: edited('demo-sub', 'Ship on Friday'), summary },
        beats: ['demo'],
        lockedLength: false,
      }),
    )
    const honest = source(spliced['index.html'], spliced['summary.json'])
    expect(
      scopeRefusal({ parentSource: parent, childSource: honest, beats: ['demo'], mp4Seconds: 9 }),
    ).toBeNull()
    expect(
      scopeRefusal({ parentSource: parent, childSource: honest, beats: ['demo'], mp4Seconds: 7 }),
    ).toMatch(/^The video is 7.00 s long but its composition is 9.00 s/)
    const tampered = source(edited('intro-title', 'Org hooks'))
    expect(
      scopeRefusal({
        parentSource: parent,
        childSource: tampered,
        beats: ['demo'],
        mp4Seconds: 9,
      })?.startsWith(SCOPE_REFUSED_PREFIX),
    ).toBe(true)
  })
})
