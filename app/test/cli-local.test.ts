// `video-agent local` and `local revise` argument handling (beads va-p1th.5.11, 5.12). The full run (runtime, agent-kit,
// render broker, copy-out) is scripts/local-fixture-e2e.ts, the phase 4 gate's CI job.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../../packages/cli/src/router.js'
import type { Io } from '../../packages/cli/src/io.js'
import { slugify } from '../../packages/cli/src/local/index.js'
import { reviseAudio } from '../../packages/cli/src/commands/local.js'

async function run(argv: string[], env: Record<string, string> = {}) {
  let stdout = ''
  let stderr = ''
  const io: Io = {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    stdin: async () => '',
    env: { PATH: process.env.PATH ?? '', ...env },
    fetch: async () => new Response(null, { status: 500 }),
    now: () => Date.now(),
    openBrowser: async () => {},
    configDir: mkdtempSync(join(tmpdir(), 'va-cfg-')),
    pollMs: 0,
  }
  const code = await main(argv, io)
  return { code, stdout, stderr }
}

describe('video-agent local', () => {
  it('codex and gemini are named as not supported yet (exit 9), unknown agents too', async () => {
    for (const agent of ['codex', 'gemini']) {
      const r = await run(['local', 'A video', '--agent', agent])
      expect(r.code).toBe(9)
      expect(r.stderr).toContain("isn't supported in this version yet")
    }
    expect((await run(['local', 'A video', '--agent', 'cursor'])).stderr).toContain('Unknown agent "cursor"')
  })

  it('checks --aspect, --sound and --media before doing anything', async () => {
    expect((await run(['local', 'A video', '--aspect', '3:2'])).code).toBe(2)
    expect((await run(['local', 'A video', '--sound', 'loud'])).code).toBe(2)
    const r = await run(['local', 'A video', '--media', '/nope/missing.png'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('--media /nope/missing.png: no such file.')
  })

  it('needs a prompt', async () => {
    expect((await run(['local'])).code).toBe(2)
  })

  it('makes folder names from titles', () => {
    expect(slugify('Canary Labs: Ships Tuesday!')).toBe('canary-labs-ships-tuesday')
    expect(slugify('One two three four five six seven eight')).toBe('one-two-three-four-five-six')
    expect(slugify('!!!')).toBe('video')
  })
})

describe('video-agent local revise', () => {
  it('needs a folder made by local, with the version to revise', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'va-video-'))
    const r = await run(['local', 'revise', empty, 'Make it orange'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('has no video.json: run video-agent local first.')

    const dir = mkdtempSync(join(tmpdir(), 'va-video-'))
    writeFileSync(
      join(dir, 'video.json'),
      JSON.stringify({
        title: 'T',
        summary: '',
        jobId: 'loc_1',
        versions: [{ n: 1, width: 1920, height: 1080 }],
      }),
    )
    mkdirSync(join(dir, 'v1'))
    const missing = await run(['local', 'revise', dir, 'Make it orange'])
    expect(missing.code).toBe(2)
    expect(missing.stderr).toContain('has no source.tar.gz to revise.')
  })

  it("keeps the version's sound and voice-over unless a flag changes them", () => {
    // A video made before versions recorded their sound is silent.
    expect(reviseAudio({}, {}, false)).toEqual({ sound: 'silent', voice: false })
    expect(reviseAudio({}, { sound: 'music', voice: true }, false)).toEqual({ sound: 'music', voice: true })
    expect(reviseAudio({ sound: 'music_sfx', voice: true }, { sound: 'silent' }, false)).toEqual({
      sound: 'music_sfx',
      voice: true,
    })
    expect(reviseAudio({ noVoice: true, sound: 'silent' }, { sound: 'music', voice: true }, false)).toEqual({
      sound: 'silent',
      voice: false,
    })
    // Redoing scenes keeps both.
    expect(reviseAudio({}, { sound: 'music', voice: true }, true)).toEqual({ sound: 'music', voice: true })
    expect(() => reviseAudio({ voice: true }, { sound: 'music' }, true)).toThrow(/Redoing scenes keeps/)
    expect(() => reviseAudio({ sound: 'loud' }, undefined, false)).toThrow(/--sound takes/)
    expect(() => reviseAudio({ voice: true, noVoice: true }, undefined, false)).toThrow(/not both/)
  })

  it('refuses a bad --sound before doing anything', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'va-video-'))
    writeFileSync(
      join(dir, 'video.json'),
      JSON.stringify({
        title: 'T',
        summary: '',
        jobId: 'loc_1',
        versions: [{ n: 1, width: 1920, height: 1080 }],
      }),
    )
    mkdirSync(join(dir, 'v1'))
    writeFileSync(join(dir, 'v1', 'source.tar.gz'), '')
    const r = await run(['local', 'revise', dir, 'Add music', '--sound', 'loud'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('--sound takes silent, music or music_sfx.')
  })
})
