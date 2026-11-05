// The redo-a-scene live test's self-test and dry run, in CI: its frame and caption analysis on local fixtures, and a
// --dry that makes no requests and refuses without its environment.
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync('npx', ['tsx', 'scripts/e2e/regen-beat.ts', ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
  })
const lines = (out: string) =>
  out
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as { step: string; [k: string]: unknown })

describe('scripts/e2e/regen-beat.ts', () => {
  it('--selftest passes on local fixtures', () => {
    const r = run(['--selftest'])
    expect(r.status, r.stderr).toBe(0)
    expect(lines(r.stdout).at(-1)?.step).toBe('SELFTEST_OK')
  }, 120_000)

  it('--dry lists the steps and credits, needs its env, and makes no request', () => {
    const missing = run(['--dry'])
    expect(missing.status).toBe(2)
    expect(lines(missing.stdout).at(-1)).toMatchObject({ step: 'DRY_INCOMPLETE', network: 'none' })
    const ready = run(['--dry', '--steps', '1,2'], {
      VIDEO_AGENT_URL: 'https://example.invalid',
      VIDEO_AGENT_KEY: 'nva_test',
      NETLIFY_SITE_ID: 'site',
      SOURCE_ID: 'vid_test',
    })
    expect(ready.status).toBe(0)
    const out = lines(ready.stdout)
    expect(out.filter((l) => l.step === 'dry_step')).toHaveLength(2)
    expect(out.find((l) => l.step === 'dry_credits')).toMatchObject({ projected: 60, ceiling: 700 })
  }, 60_000)
})
