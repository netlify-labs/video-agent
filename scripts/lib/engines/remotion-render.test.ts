// The Remotion render (render-engines plan §5.5) with a stub renderer, no Remotion installed: the options it passes,
// the license key it reports with, and the render tally.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FREE_LICENSE_ACCEPTS_IS_PRODUCTION, licenseFor, type RemotionApi } from './remotion-check.js'
import { QUALITY_CRF, remotionEngine } from './remotion.js'

const repo = join(import.meta.dirname, '..', '..', '..')

/** A root with a run manifest naming this engine block, and the starter project in video/. */
function workspace(engine: object = { id: 'remotion', tier: 'free' }) {
  const root = mkdtempSync(join(tmpdir(), 'va-rrender-'))
  mkdirSync(join(root, '.render'))
  writeFileSync(join(root, '.render', 'run-manifest.json'), JSON.stringify({ engine }))
  const video = join(root, 'video')
  cpSync(join(repo, 'app', 'engines', 'remotion'), video, {
    recursive: true,
    filter: (src) => !src.includes('node_modules'),
  })
  return { root, video }
}

function stub() {
  const media: Record<string, unknown>[] = []
  const api: RemotionApi = {
    bundle: (o) => {
      mkdirSync(o.outDir, { recursive: true })
      writeFileSync(join(o.outDir, 'index.html'), '')
      return Promise.resolve(o.outDir)
    },
    openBrowser: () => Promise.resolve({ close: () => Promise.resolve() }),
    selectComposition: () => Promise.resolve({ width: 1920, height: 1080, fps: 30, durationInFrames: 90 }),
    renderStill: () => Promise.resolve(),
    renderMedia: (o) => {
      media.push(o)
      ;(o.onProgress as (p: { progress: number }) => void)({ progress: 0.5 })
      ;(o.onProgress as (p: { progress: number }) => void)({ progress: 1 })
      return Promise.resolve()
    },
  }
  return { api, media }
}

afterEach(() => vi.unstubAllEnvs())

describe('Remotion render', () => {
  it.each(Object.entries(QUALITY_CRF))(
    'renders h264 at the %s CRF with no envVariables',
    async (quality, crf) => {
      const { root, video } = workspace()
      const s = stub()
      const pct: number[] = []
      const report = await remotionEngine({ root, remotion: () => s.api, log: () => {} }).render(
        video,
        '/out/video.mp4',
        quality,
        (p) => pct.push(p),
      )
      expect(s.media[0]).toMatchObject({
        codec: 'h264',
        crf,
        outputLocation: '/out/video.mp4',
        licenseKey: 'free-license',
      })
      expect(s.media[0]).not.toHaveProperty('envVariables')
      expect(pct).toEqual([50, 100])
      expect(report.renders).toEqual({ video: 1, stills: 0, audio: 0 })
    },
  )

  it('reports with the deployment’s key for a Company License, read from env, never on a command line', async () => {
    vi.stubEnv('VIDEO_AGENT_REMOTION_KEY', 'rm_sec_test_key_123')
    const { root, video } = workspace({ id: 'remotion', tier: 'company' })
    const s = stub()
    const argv: string[][] = []
    const e = remotionEngine({
      root,
      remotion: () => s.api,
      log: () => {},
      run: (cmd, args) => {
        argv.push([cmd, ...args])
        return Promise.resolve('')
      },
    })
    await e.render(video, '/out/video.mp4', 'standard', () => {})
    expect(s.media[0]?.licenseKey).toBe('rm_sec_test_key_123')
    expect(argv.flat().join(' ')).not.toContain('rm_sec_')
  })

  it('adds up renders across separate commands in one run', async () => {
    const { root, video } = workspace()
    const s = stub()
    const e = remotionEngine({ root, remotion: () => s.api, log: () => {} })
    await e.render(video, '/out/a.mp4', 'standard', () => {})
    const second = await e.render(video, '/out/b.mp4', 'standard', () => {})
    expect(second.renders?.video).toBe(2)
    expect(JSON.parse(readFileSync(join(video, '.render', 'renders.json'), 'utf8'))).toEqual({
      video: 2,
      stills: 0,
      audio: 0,
    })
  })
})

describe('the license a render reports with', () => {
  const at = (engine: object) => workspace(engine).root
  it('is "free-license" for the free tier, or with no tier recorded', () => {
    expect(licenseFor(at({ id: 'remotion', tier: 'free' }), {})).toEqual({ licenseKey: 'free-license' })
    expect(licenseFor(at({ id: 'remotion' }), {})).toEqual({ licenseKey: 'free-license' })
  })

  it('is VIDEO_AGENT_REMOTION_KEY for a Company License, and refuses without it', () => {
    const root = at({ id: 'remotion', tier: 'company' })
    expect(licenseFor(root, { VIDEO_AGENT_REMOTION_KEY: 'rm_sec_x' })).toEqual({ licenseKey: 'rm_sec_x' })
    expect(() => licenseFor(root, {})).toThrow(
      "engine_license_key_missing: the admin recorded a Company License but VIDEO_AGENT_REMOTION_KEY isn't set on this project.",
    )
  })

  it('marks development renders only where isProduction is known to be accepted', () => {
    const logs: string[] = []
    const company = at({ id: 'remotion', tier: 'company', development: true })
    expect(licenseFor(company, { VIDEO_AGENT_REMOTION_KEY: 'rm_sec_x' })).toEqual({
      licenseKey: 'rm_sec_x',
      isProduction: false,
    })
    const free = at({ id: 'remotion', tier: 'free', development: true })
    expect(FREE_LICENSE_ACCEPTS_IS_PRODUCTION).toBe(false)
    expect(licenseFor(free, {}, (step) => logs.push(step))).toEqual({ licenseKey: 'free-license' })
    expect(logs).toEqual(['engine.is_production_omitted'])
  })
})
