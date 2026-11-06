// render-job's local mode (cli-and-sdk plan §7; bead va-p1th.5.1), up to where a real render starts: a file:
// callback must sit under <repoRoot>/.render/ and go with --upload local, and needs no token. The full local run
// (done.json, no Netlify call) is covered by the phase 4 gate's fixture-agent run (va-p1th.5.15).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { writeAtomic } from '../scripts/checkpoint.js'
import { repoRoot } from '../scripts/lib/run-tools.js'

/** render-job in a fresh workspace (VA_REPO_ROOT) with Netlify CLI calls forbidden. */
function renderJob(args: (ws: string) => string[]) {
  const ws = mkdtempSync(join(tmpdir(), 'va-ws-'))
  mkdirSync(join(ws, 'video'))
  // node with tsx's loader, not `npx tsx`: npx's own start-up was most of each spawn's time.
  const tsx = join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')
  const r = spawnSync(
    process.execPath,
    ['--import', tsx, join(repoRoot, 'scripts/render-job.ts'), ...args(ws)],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, VA_REPO_ROOT: ws, VA_NETLIFY_CLI: 'off' },
      timeout: 60_000,
    },
  )
  return { ws, code: r.status, err: r.stderr }
}
const done = (ws: string, attempt = 'att_1') => pathToFileURL(join(ws, '.render', attempt, 'done')).href

describe('render-job --upload local', () => {
  it('refuses a file: callback outside .render/', () => {
    const r = renderJob((ws) => [
      '--job',
      'vid_1',
      '--attempt',
      'att_1',
      '--upload',
      'local',
      '--callback',
      pathToFileURL(join(ws, 'video', 'done')).href,
    ])
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/is outside .*\.render/)
  })

  it('a file: callback goes with --upload local', () => {
    const r = renderJob((ws) => [
      '--job',
      'vid_1',
      '--attempt',
      'att_1',
      '--upload',
      'blobs',
      '--callback',
      done(ws),
    ])
    expect(r.code).toBe(1)
    expect(r.err).toContain('A file: callback goes with --upload local.')
  })

  // Past the argument checks render-job runs the engine's `npx hyperframes --version` before it finds the empty
  // composition: genuinely a few seconds on a busy CI runner (5 s timed out on 49c1eb0).
  it('needs no token with a file: callback, and gets past the argument checks', { timeout: 30_000 }, () => {
    const r = renderJob((ws) => [
      '--job',
      'vid_1',
      '--attempt',
      'att_1',
      '--upload',
      'local',
      '--callback',
      done(ws),
    ])
    expect(r.err).not.toContain('Usage:')
    expect(r.err).not.toContain('VA_NETLIFY_CLI')
    // It stops later, at the empty composition, with nothing written as done.
    expect(r.code).toBe(1)
    expect(existsSync(join(r.ws, '.render', 'att_1', 'done.json'))).toBe(false)
  })

  it('an https callback still needs a token', () => {
    const r = renderJob(() => ['--job', 'vid_1', '--attempt', 'att_1', '--callback', 'https://x/done'])
    expect(r.err).toContain('Usage:')
  })

  it('done.json is written whole: through a temp file and a rename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'va-done-'))
    writeAtomic(join(dir, 'done.json'), JSON.stringify({ jobId: 'vid_1' }))
    expect(readdirSync(dir)).toEqual(['done.json'])
    expect(JSON.parse(readFileSync(join(dir, 'done.json'), 'utf8'))).toEqual({ jobId: 'vid_1' })
  })
})
