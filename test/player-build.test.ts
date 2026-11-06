// /player.js is the same bundle as the player package's dist/index.js (cli-and-sdk plan §7 Delivery).
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { packageBuildOptions, playerBuildOptions } from '../scripts/lib/player-build.js'
import { repoRoot } from '../scripts/lib/run-tools.js'

it('the deployment and the package build the same bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'va-player-'))
  await build(playerBuildOptions(repoRoot, join(dir, 'player.js')))
  await build({ ...packageBuildOptions(join(repoRoot, 'packages/player'), false), outdir: join(dir, 'pkg') })
  const site = readFileSync(join(dir, 'player.js'))
  expect(site.equals(readFileSync(join(dir, 'pkg', 'index.js')))).toBe(true)
  expect(site.toString()).toContain('customElements.define("video-agent-player"')
})
