// scripts/public-snapshot.ts: the rules catch what they're for and leave alone what's fine, every excluded path still
// exists (so a move doesn't quietly publish it), and an export leaves those paths out.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXCLUDES, scanText } from './public-snapshot.js'

const rules = (line: string) => scanText('f.md', line).map((h) => h.rule)

describe('rules', () => {
  it.each([
    ['ask dev@netlify.com', 'company-email'],
    ['see gtm-services for the gateway', 'gtm'],
    ["const SITE = '3a3f4565-083a-4b98-b01b-9011f70f53df'", 'site-id'],
    ['through `nax run agent`', 'nax'],
    ['run `6ae78a43e2327820c2eebd42`', 'netlify-id'],
    ['(CI run 42117243317)', 'ci-run-id'],
    ['https://github.com/acme/x/actions/runs/123456', 'ci-run-id'],
    ['pinned in netlify-labs/video-site-template', 'private-repo'],
    ['the netlify-labs/video-agent-action-sandbox repo', 'private-repo'],
    ['billed to netliclaw', 'internal-name'],
    ['the site-vendor service', 'internal-name'],
    ['made for BambooHR', 'customer'],
    ['open /Users/jane/projects/x', 'home-path'],
    ['VIDEO_AGENT_KEY=nva_Zx81kQ2mN7pL4vR9sT3wY6uB0cE5fH1jK8dG', 'token'],
  ])('%s → %s', (line, rule) => expect(rules(line)).toContain(rule))

  it.each([
    'uses: netlify-labs/video-agent/packages/action@89d737ce734c308660ec7c55aa9f8b8c6d1bef3e # action-v1.0.0',
    'git clone https://github.com/netlify-labs/video-agent.git',
    'superseded by `@netlify-labs/video-agent-cli`',
    'sha256 70bb6685eb0c2a1d18e2918dca3fbfbd39317010b1802eb1b6ea73a92f3fdec0',
    "deployId: '6ae5000000000000000000a1'",
    "token: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaa'",
    "'nvat_abcdefghijklmnopqrstuvwxyz'",
    'cd /Users/runner/work and /Users/me/videos',
    'mia@acme.com and https://netlify-video-agent.netlify.app',
    'a Netlify Agent Runner run at commit `19740d8`',
  ])('fine: %s', (line) => expect(rules(line)).toEqual([]))

  it('reports the line number', () => {
    expect(scanText('a.md', 'one\ntwo dev@netlify.com\n')).toEqual([
      { file: 'a.md', line: 2, rule: 'company-email', text: 'dev@netlify.com' },
    ])
  })
})

describe('excludes', () => {
  const root = new URL('..', import.meta.url).pathname

  it('every excluded path is still in the repo, and each says why', () => {
    for (const e of EXCLUDES) {
      expect(
        execFileSync('git', ['ls-files', '--', e.path], { cwd: root, encoding: 'utf8' }).trim(),
        e.path,
      ).not.toBe('')
      expect(e.why.length, e.path).toBeGreaterThan(10)
    }
  })

  it('an export of HEAD leaves them out and keeps the rest', () => {
    const out = mkdtempSync(join(tmpdir(), 'public-snapshot-test-'))
    try {
      spawnSync('npx', ['tsx', 'scripts/public-snapshot.ts', join(out, 'snap'), '--ref', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      })
      for (const e of EXCLUDES) expect(existsSync(join(out, 'snap', e.path)), e.path).toBe(false)
      expect(existsSync(join(out, 'snap', 'README.md'))).toBe(true)
      expect(existsSync(join(out, 'snap', 'app', 'server', 'app.ts'))).toBe(true)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  }, 120_000)

  it('--scan exits 1 with file:line on a hit and 0 when clean', () => {
    const dir = mkdtempSync(join(tmpdir(), 'public-snapshot-scan-'))
    try {
      writeFileSync(join(dir, 'notes.md'), 'fine\nask dev@netlify.com\n')
      const hit = spawnSync('npx', ['tsx', 'scripts/public-snapshot.ts', '--scan', dir], {
        cwd: root,
        encoding: 'utf8',
      })
      expect(hit.status).toBe(1)
      expect(hit.stdout).toContain('notes.md:2  company-email  dev@netlify.com')
      writeFileSync(join(dir, 'notes.md'), 'fine\n')
      const clean = spawnSync('npx', ['tsx', 'scripts/public-snapshot.ts', '--scan', dir], {
        cwd: root,
        encoding: 'utf8',
      })
      expect(clean.status, clean.stdout).toBe(0)
      expect(clean.stdout).toContain('clean: no hits')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
