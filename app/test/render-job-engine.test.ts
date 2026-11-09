// render-job on another engine (render-engines plan §4.3, §5.1): the manifest's engine picks it, its own checks run
// before anything renders, and the render tally rides in the callback's engine report.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  checkBeforeRender,
  engineReport,
  runEngineFor,
  runEngineIdFromManifest,
} from '../../scripts/lib/engines/index.js'
import { StepError } from '../../scripts/lib/run-tools.js'

function root(manifest: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'va-render-engine-'))
  mkdirSync(join(dir, '.render'))
  writeFileSync(join(dir, '.render', 'run-manifest.json'), JSON.stringify(manifest))
  return dir
}

describe('render-job on the Remotion engine', () => {
  it('the manifest picks the engine, for this attempt only', () => {
    const dir = root({ attemptId: 'att_1', engine: { id: 'remotion', tier: 'free' } })
    expect(runEngineIdFromManifest(dir, 'att_1')).toBe('remotion')
    expect(runEngineIdFromManifest(dir, 'att_2')).toBe('hyperframes')
    expect(runEngineFor('remotion').id).toBe('remotion')
    expect(runEngineFor('hyperframes').id).toBe('hyperframes')
  })

  it('check errors stop it before rendering, with engine_check_failed and every error', async () => {
    const check = vi.fn(() =>
      Promise.resolve({ errors: ['props.json: title is missing', 'Root.tsx changed'], warnings: [] }),
    )
    const err = await checkBeforeRender({ check }, '/v').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StepError)
    const message = err instanceof Error ? err.message : ''
    expect(message).toMatch(/^engine_check_failed: run npx tsx scripts\/engine.ts check and fix:/)
    expect(message).toContain('- props.json: title is missing\n- Root.tsx changed')
    expect(check).toHaveBeenCalledWith('/v')
  })

  it('a clean check is logged and lets it render; an engine without checks skips it', async () => {
    const log = vi.fn()
    await checkBeforeRender({ check: () => Promise.resolve({ errors: [], warnings: ['w'] }) }, '/v', log)
    expect(log).toHaveBeenCalledWith('engine.check_ok', { warnings: 1 })
    log.mockClear()
    await checkBeforeRender({}, '/v', log)
    expect(log).not.toHaveBeenCalled()
  })

  it('the callback reports the render tally next to the engine and its version', () => {
    expect(
      engineReport({ id: 'remotion' }, '4.0.540', { renders: { video: 1, stills: 6, audio: 0 } }),
    ).toEqual({
      id: 'remotion',
      version: '4.0.540',
      renders: { video: 1, stills: 6, audio: 0 },
    })
    expect(engineReport({ id: 'hyperframes' }, '0.4.2', {})).toEqual({ id: 'hyperframes', version: '0.4.2' })
  })
})
