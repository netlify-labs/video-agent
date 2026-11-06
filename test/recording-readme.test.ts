// The README's screen-recording limits come from the code (va-rsk5.4.8), so they can't drift apart.
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { RECORDING_QUOTA_DEFAULT } from '../src/domain/media-roles.js'
import { RECORDING_LIMITS } from '../src/lib/media/classify.js'

it('the README states every screen-recording limit as the code has it', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const section = readme.slice(readme.indexOf('## Screen recording demos'), readme.indexOf('## Redo a scene'))
  for (const s of [
    `${String(RECORDING_LIMITS.seconds / 60)} minutes`,
    `${String(RECORDING_LIMITS.bytes / 1024 / 1024)} MB`,
    `${String(RECORDING_LIMITS.maxSide)} pixels`,
    `${String(RECORDING_LIMITS.minFps)} to ${String(RECORDING_LIMITS.maxFps)} frames per second`,
    `every ${String(RECORDING_LIMITS.maxKeyframeGapSec)} seconds`,
  ])
    expect(section.replace(/\s+/g, ' '), s).toContain(s)
  expect(readme).toContain(`their own ${String(RECORDING_QUOTA_DEFAULT / 1024 ** 3)} GiB budget`)
})
