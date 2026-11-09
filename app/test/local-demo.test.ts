// local demo's inputs (screen-recording plan §6.3; va-rsk5.5.4): a recording becomes the run manifest's recording block
// (the server's format, accepted by prepare-run --inputs, which writes .va-run/recording/<id>/ as on the runner), with
// its trace, privacy mode and hide strings; the prompt is the server's demo prompt, or the Quick demo's with --quick.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { INPUTS_DIR, prepareLocalRun } from '../../packages/cli/src/local/run.js'
import { fromInputs, prepare } from '../../scripts/prepare-run.js'
import { runManifestKey, verifyRunManifest } from '../server/lib/run-manifest.js'

const RECORDING = join(import.meta.dirname, 'fixtures', 'recording', 'privacy', 'secrets.mp4')
const log = () => {}

function workspace() {
  const ws = mkdtempSync(join(tmpdir(), 'va-demo-ws-'))
  mkdirSync(join(ws, 'video'))
  const trace = join(ws, '..', `trace-${String(Date.now())}.json`)
  const base = JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'recording', 'trace-good.json'), 'utf8'),
  ) as Record<string, unknown>
  writeFileSync(
    trace,
    JSON.stringify({
      ...base,
      frame: { width: 1280, height: 720, fps: 30, duration: 6 },
      moves: [[0, 0.5, 0.5]],
      events: [
        {
          kind: 'click',
          t: 1,
          x: 0.5,
          y: 0.3,
          button: 0,
          target: { role: 'button', name: 'Save', box: [0.45, 0.28, 0.1, 0.04] },
        },
      ],
      redact: [],
    }),
  )
  return { ws, trace }
}

describe('local demo', () => {
  it('a recording rides in the manifest as on the server, and prepare-run hydrates it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ws, trace } = workspace()
    const run = prepareLocalRun(
      ws,
      {
        prompt: 'A demo of the account page.',
        aspect: '16:9',
        recording: { path: RECORDING, trace, trim: [0.5, 5.5], privacy: true, hideStrings: ['Priya Raman'] },
      },
      log,
    )
    const raw = readFileSync(
      join(ws, INPUTS_DIR, 'sources', runManifestKey(run.jobId, run.attemptId)),
      'utf8',
    )
    const m = verifyRunManifest(raw, { attemptId: run.attemptId, sha256: run.manifestSha256 })
    console.log(JSON.stringify({ test: 'local-demo', recording: m.recording }))
    expect(m.recording).toMatchObject({
      trim: [0.5, 5.5],
      privacy: true,
      hideStrings: ['Priya Raman'],
      boxes: [],
    })
    expect(m.recording?.trace?.key).toMatch(/^med_loc[0-9a-f]+\/trace\.json$/)
    // The server's demo prompt: the Screen recording section, privacy mode, the clicked element from the trace.
    expect(run.prompt).toContain('Screen recording: this video is a demo made from')
    expect(run.prompt).toContain('Privacy mode is on')
    expect(run.prompt).toContain('button "Save"')
    expect(run.prompt).not.toContain('Priya')
    await prepare(m, {
      tmp: mkdtempSync(join(tmpdir(), 'va-tmp-')),
      root: ws,
      fetch: fromInputs(join(ws, INPUTS_DIR)),
    })
    const id = m.recording?.mediaId ?? ''
    expect(
      JSON.parse(readFileSync(join(ws, '.va-run', 'recording', id, 'input.json'), 'utf8')),
    ).toMatchObject({
      privacy: true,
      hideStrings: ['Priya Raman'],
      trim: [0.5, 5.5],
    })
    expect(readFileSync(join(ws, '.va-run', 'recording', id, 'trace.json'), 'utf8')).toBe(
      readFileSync(trace, 'utf8'),
    )
  })

  it('--quick: the Quick demo prompt and compose in the manifest', () => {
    const { ws } = workspace()
    const run = prepareLocalRun(
      ws,
      { prompt: 'A demo.', aspect: '16:9', recording: { path: RECORDING, quick: true } },
      log,
    )
    const raw = readFileSync(
      join(ws, INPUTS_DIR, 'sources', runManifestKey(run.jobId, run.attemptId)),
      'utf8',
    )
    expect(
      verifyRunManifest(raw, { attemptId: run.attemptId, sha256: run.manifestSha256 }).recording?.compose,
    ).toBe(true)
    expect(run.prompt).toContain('a Quick demo from a screen recording, with no authoring')
    expect(run.prompt).toMatch(/\d\. Run: npx tsx scripts\/recording\.ts compose/)
    expect(run.prompt).toContain('--upload local')
  })
})
