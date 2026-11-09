// The run prompt per engine (render-engines plan §5.3): HyperFrames' is byte-identical whether the input names it or
// not, and a Remotion prompt names no HyperFrames tool and carries the Remotion rules.
import { describe, expect, it } from 'vitest'
import { buildPrompt, type PromptInput } from '../server/domain/prompt.js'
import { getSettings } from '../server/domain/settings.js'
import { runManifestKey } from '../server/lib/run-manifest.js'
import { harness } from './helpers.js'

const base: PromptInput = {
  jobId: 'vid_1',
  attemptId: 'att_1',
  versionN: 1,
  requesterName: 'Mia',
  userPrompt: 'A launch video for org webhooks.',
  aspect: '16:9',
  targetDurationSec: 20,
  callbackUrl: 'https://x/done',
  checkpointUrl: 'https://x/checkpoint',
  upload: { mode: 'blobs' },
  revision: null,
  runManifestSha256: null,
}
const remotion = (over: Partial<PromptInput> = {}) => buildPrompt({ ...base, engine: 'remotion', ...over })

describe('the prompt per engine', () => {
  it.each([
    ['silent', {}],
    [
      'music',
      {
        sound: 'music' as const,
        media: [{ file: 'assets/media/med_a.mp3', kind: 'audio', caption: 'bed', seconds: 30 }],
      },
    ],
    ['revision', { versionN: 2, revision: { parentN: 1 }, runManifestSha256: 'a'.repeat(64) }],
  ])('HyperFrames (%s) is the same with or without the engine named', (_name, over) => {
    expect(buildPrompt({ ...base, ...over, engine: 'hyperframes' })).toBe(buildPrompt({ ...base, ...over }))
  })

  it('a Remotion author prompt has the Remotion rules and no HyperFrames tool', () => {
    const p = remotion({
      media: [{ file: 'assets/media/med_logo.svg', kind: 'image', caption: 'Logo' }],
    })
    expect(p).not.toMatch(/hyperframes/i)
    for (const want of [
      "Don't start Remotion Studio or open a browser",
      'npx tsx scripts/engine.ts check',
      'npx tsx scripts/engine.ts snapshot --at',
      'never Google Fonts or any URL',
      "don't install packages",
      'process.env',
      'contrast was reviewed by eye, not measured',
      '<VaImage slot>',
      'Write video/props.json first (1920x1080, fps 30)',
      'npx tsx scripts/render-job.ts --job vid_1',
    ])
      expect(p).toContain(want)
    expect(p).not.toContain('--bundle')
  })

  it('a Remotion music prompt sets audio.music and the level with engine.ts mix', () => {
    const p = remotion({
      sound: 'music',
      media: [{ file: 'assets/media/med_a.mp3', kind: 'audio', caption: 'bed', seconds: 30 }],
    })
    expect(p).not.toMatch(/hyperframes/i)
    expect(p).toContain('set props.json audio.music')
    expect(p).toContain('npx tsx scripts/engine.ts mix')
    expect(p).toContain('"file":"assets/media/med_a.mp3"')
    expect(p).toContain('the mix was measured, not heard')
  })

  it('a Remotion revision restores and changes only what was asked', () => {
    const p = remotion({ versionN: 2, revision: { parentN: 1 }, runManifestSha256: 'a'.repeat(64) })
    expect(p).toContain("It restores video/ to version 1's composition.")
    expect(p).toContain('This is a revision of version 1. Change only what the request asks for.')
    expect(p).not.toMatch(/hyperframes/i)
  })

  it('the reconciler names the engine only for a non-HyperFrames version', async () => {
    // Remotion runs need it installed and a license recorded (render-engines plan §7).
    const h = harness({ MAX_ACTIVE_RUNS: '1', ENGINES: 'remotion' })
    await getSettings(h.deps)
    await h.deps.store.updateSettings({
      remotionLicenseAck: {
        by: 'u_admin',
        email: 'admin@acme.com',
        at: '2026-11-05T00:00:00Z',
        tier: 'free',
        note: null,
      },
    })
    const create = async (prompt: string) =>
      (await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt } }))).id as string
    const first = await create('A short launch video for org webhooks.')
    await h.drive(4)
    await create('A short launch video for org secrets.')
    await h.call('POST', `/api/v1/videos/${first}/versions`, { as: h.member, body: { prompt: 'Warmer.' } })
    await h.deps.store.updateVersion(first, 2, { engine: 'remotion' })
    await h.drive(8)
    const prompts = h.deps.runner.starts.map((s) => s.prompt)
    expect(prompts[0]).toContain('npx hyperframes check')
    expect(prompts[2]).toContain('npx tsx scripts/engine.ts check')
    expect(prompts[2]).not.toMatch(/hyperframes/i)
    // The run manifest names the engine too, so prepare-run hydrates it.
    const req = h.deps.runner.starts[2]
    const raw = await h.deps.blobs.get('sources', runManifestKey(first, req?.requestId ?? ''))
    expect(JSON.parse(new TextDecoder().decode(raw ?? new Uint8Array())).engine).toEqual({
      id: 'remotion',
      tier: 'free',
    })
  })
})
