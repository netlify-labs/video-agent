// The release script (beads va-p1th.8.1, 8.2): it releases exactly the public packages, and a tarball may hold only
// dist/ and the package's own docs, never sources, tests, fixtures or env files.
import { describe, expect, it } from 'vitest'
import { ALLOWED, publicPackages } from '../scripts/release-packages.js'

describe('release-packages', () => {
  it('releases the SDK, the CLI and the player, never the private action', () => {
    expect(publicPackages().map((p) => p.name)).toEqual([
      'netlify-video-agent',
      'netlify-video-agent-player',
      'netlify-video-agent-sdk',
    ])
  })

  it('allows dist/ and the package docs only', () => {
    for (const ok of [
      'package.json',
      'README.md',
      'LICENSE',
      'CHANGELOG.md',
      'dist/bin.js',
      'dist/runtime/fixture/index.html',
    ])
      expect(ALLOWED.test(ok), ok).toBe(true)
    for (const bad of ['src/index.ts', 'test/a.test.ts', '.env', 'tsconfig.json', 'node_modules/x/index.js'])
      expect(ALLOWED.test(bad), bad).toBe(false)
  })
})
