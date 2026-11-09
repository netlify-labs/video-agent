// A local run's inputs, prompt and file handoff (cli-and-sdk plan §7; bead va-p1th.5.6): the manifest is the server's
// format and prepare-run --inputs accepts it; the prompt is buildPrompt's with file: URLs and --upload local; a stub
// agent's checkpoints and done.json come back in order, with fs.watch and with the poll alone.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  INPUTS_DIR,
  outputPath,
  prepareLocalRun,
  watchRun,
  type Checkpoint,
} from '../../packages/cli/src/local/run.js'
import { fromInputs, prepare } from '../../scripts/prepare-run.js'
import { runManifestKey, verifyRunManifest } from '../server/lib/run-manifest.js'

const log = () => {}
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'

function workspace() {
  const ws = mkdtempSync(join(tmpdir(), 'va-ws-'))
  mkdirSync(join(ws, 'video'))
  const logo = join(ws, '..', `logo-${Date.now()}.svg`)
  writeFileSync(logo, SVG)
  return { ws, logo }
}

describe('local run inputs and prompt', () => {
  it('writes a manifest prepare-run --inputs accepts, and puts the media in video/', async () => {
    const { ws, logo } = workspace()
    const run = prepareLocalRun(
      ws,
      { prompt: 'A launch video.', aspect: '16:9', media: [{ path: logo, caption: 'Our logo' }] },
      log,
    )
    const raw = readFileSync(
      join(ws, INPUTS_DIR, 'sources', runManifestKey(run.jobId, run.attemptId)),
      'utf8',
    )
    const m = verifyRunManifest(raw, { attemptId: run.attemptId, sha256: run.manifestSha256 })
    expect(m.media).toHaveLength(1)
    await prepare(m, {
      tmp: mkdtempSync(join(tmpdir(), 'va-tmp-')),
      root: ws,
      fetch: fromInputs(join(ws, INPUTS_DIR)),
    })
    expect(readFileSync(join(ws, 'video', 'assets', 'media', m.media![0]!.filename), 'utf8')).toBe(SVG)
  })

  it("the prompt is buildPrompt's: file: URLs, --upload local, the manifest hash; saved as prompt.txt", () => {
    const { ws } = workspace()
    const run = prepareLocalRun(ws, { prompt: 'A launch video.', aspect: '9:16', durationSec: 20 }, log)
    const done = pathToFileURL(join(run.renderDir, 'done')).href
    expect(run.prompt).toContain(`--callback ${done}`)
    expect(run.prompt).toContain('--upload local')
    expect(run.prompt).not.toContain('--upload blobs')
    expect(run.prompt).toContain(pathToFileURL(join(run.renderDir, 'checkpoint')).href)
    expect(run.prompt).toContain(run.manifestSha256)
    expect(readFileSync(join(ws, 'prompt.txt'), 'utf8')).toBe(run.prompt)
  })
})

/** A stand-in agent: three checkpoints, then done.json, a few ms apart. */
function stubAgent(renderDir: string, files: Record<string, unknown> = { 'video.mp4': {} }) {
  const script = `
const { mkdirSync, writeFileSync, renameSync } = require('node:fs')
const dir = ${JSON.stringify(renderDir)}
const put = (f, body) => { writeFileSync(f + '.tmp', JSON.stringify(body)); renameSync(f + '.tmp', f) }
const steps = [
  () => { mkdirSync(dir + '/checkpoint', { recursive: true }); put(dir + '/checkpoint/1.json', { seq: 1, message: 'Writing' }) },
  () => put(dir + '/checkpoint/2.json', { seq: 2, renderPercent: 40 }),
  () => put(dir + '/checkpoint/3.json', { seq: 3, renderPercent: 100 }),
  () => put(dir + '/done.json', { jobId: 'loc_1', files: ${JSON.stringify(files)} }),
]
let i = 0
const t = setInterval(() => { steps[i++](); if (i === steps.length) clearInterval(t) }, 30)
`
  return spawn(process.execPath, ['-e', script], { stdio: 'ignore' })
}

describe('watching a local run', () => {
  it.each([
    ['fs.watch', true],
    ['the poll alone', false],
  ])('prints checkpoints in order and detects done.json with %s', async (_name, watchFiles) => {
    const renderDir = join(mkdtempSync(join(tmpdir(), 'va-ws-')), '.render', 'loc_att')
    const seen: Checkpoint[] = []
    const result = watchRun({ renderDir, onCheckpoint: (c) => seen.push(c), log, pollMs: 50, watchFiles })
    stubAgent(renderDir)
    await expect(result).resolves.toMatchObject({ jobId: 'loc_1' })
    expect(seen.map((c) => c.seq)).toEqual([1, 2, 3])
    expect(seen.map((c) => c.renderPercent ?? null)).toEqual([null, 40, 100])
  })

  it('refuses a done manifest that names a file outside the run folder', async () => {
    const renderDir = join(mkdtempSync(join(tmpdir(), 'va-ws-')), '.render', 'loc_att')
    const result = watchRun({ renderDir, onCheckpoint: () => {}, log, pollMs: 50 })
    stubAgent(renderDir, { '../../etc/passwd': {} })
    await expect(result).rejects.toThrow('The run named an output outside its folder')
  })

  it('outputPath allows plain names only', () => {
    expect(outputPath('/r', 'video.mp4')).toBe('/r/video.mp4')
    for (const bad of ['', '/etc/passwd', '../x', 'a/b.mp4', '..'])
      expect(() => outputPath('/r', bad)).toThrow()
  })

  it('stops when asked', async () => {
    const renderDir = join(mkdtempSync(join(tmpdir(), 'va-ws-')), '.render', 'loc_att')
    const ac = new AbortController()
    const result = watchRun({ renderDir, onCheckpoint: () => {}, log, pollMs: 50, signal: ac.signal })
    ac.abort()
    await expect(result).rejects.toThrow('Stopped.')
  })
})
