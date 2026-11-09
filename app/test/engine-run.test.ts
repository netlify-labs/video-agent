// Remotion run wiring (render-engines plan §4.2, §7): the run manifest pins the engine, its license tier and whether
// renders are development ones; a deployment that can't install Remotion refuses the run before a runner starts.
import { describe, expect, it } from 'vitest'
import { getSettings } from '../server/domain/settings.js'
import { runManifestKey, verifyRunManifest } from '../server/lib/run-manifest.js'
import { harness, pgStore, PROMPT, type Harness } from './helpers.js'

const ack = (tier: 'free' | 'company') => ({
  by: 'u_admin',
  email: 'admin@acme.com',
  at: '2026-11-05T00:00:00Z',
  tier,
  note: null,
})

/** One video whose first version is a Remotion one, driven until its run starts (or is refused). */
async function remotionVideo(h: Harness, tier: 'free' | 'company' | null) {
  await getSettings(h.deps)
  if (tier) await h.deps.store.updateSettings({ remotionLicenseAck: ack(tier) })
  // Paused, so the version is Remotion's before anything starts it (choosing it on create is bead 3.4's).
  await h.deps.store.updateSettings({ queuePausedReason: 'test' })
  const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
  await h.deps.store.updateVersion(v.id, 1, { engine: 'remotion' })
  await h.deps.store.updateSettings({ queuePausedReason: null })
  await h.drive(2)
  return v.id as string
}

/** The engine the run's manifest names, read the way prepare-run reads it (hash and shape checked). */
async function manifestEngine(h: Harness, jobId: string) {
  const req = h.deps.runner.starts[0]
  const attemptId = req?.requestId ?? ''
  const raw = new TextDecoder().decode(
    (await h.deps.blobs.get('sources', runManifestKey(jobId, attemptId))) ?? undefined,
  )
  const sha256 = /--manifest ([0-9a-f]{64})/.exec(req?.prompt ?? '')?.[1] ?? ''
  return verifyRunManifest(raw, { attemptId, sha256 }).engine
}

describe.each([
  ['memory', () => Promise.resolve({})],
  ['postgres', async () => ({ store: await pgStore() })],
])('Remotion run wiring (%s)', { timeout: 20_000 }, (_name, stores) => {
  it.each([
    ['free', {}, { id: 'remotion', tier: 'free' }],
    ['company', { VIDEO_AGENT_REMOTION_KEY: 'rm_sec_test' }, { id: 'remotion', tier: 'company' }],
    [
      'free, development renders',
      { VIDEO_AGENT_REMOTION_DEVELOPMENT: '1' },
      { id: 'remotion', tier: 'free', development: true },
    ],
  ] as const)('the manifest pins the engine (%s)', async (_label, env, want) => {
    const h = harness({ ENGINES: 'remotion', ...env }, await stores())
    const id = await remotionVideo(h, want.tier)
    expect(h.deps.runner.starts).toHaveLength(1)
    expect(await manifestEngine(h, id)).toEqual(want)
    // A first version gets a manifest too: prepare-run sets the Remotion project up from it.
    expect(h.deps.runner.starts[0]?.prompt).toContain('npx tsx scripts/prepare-run.ts')
  })

  it('a HyperFrames manifest still names no engine', async () => {
    // With the run secret (no callback token to deliver) and no inputs to restore, no manifest at all: the prompt is
    // exactly what it was before engines.
    const h = harness({ ENGINES: 'remotion', VIDEO_AGENT_RUN_SECRET: 's'.repeat(40) }, await stores())
    const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
    await h.drive(2)
    expect(
      await h.deps.blobs.get('sources', runManifestKey(v.id, h.deps.runner.starts[0]?.requestId ?? '')),
    ).toBeNull()
    expect(h.deps.runner.starts[0]?.prompt).not.toContain('prepare-run')
  })

  it.each([
    ['ENGINES without remotion', {}, 'free', /ENGINES doesn't include remotion/],
    ['no license recorded', { ENGINES: 'remotion' }, null, /No Remotion license is recorded/],
    [
      'a Company License without its key',
      { ENGINES: 'remotion' },
      'company',
      /VIDEO_AGENT_REMOTION_KEY isn't set/,
    ],
  ] as const)(
    '%s: the run fails with engine_unavailable and no runner starts',
    async (_l, env, tier, message) => {
      const h = harness(env, await stores())
      const id = await remotionVideo(h, tier)
      expect(h.deps.runner.starts).toHaveLength(0)
      const [attempt] = await h.deps.store.listAttempts(id)
      expect(attempt).toMatchObject({ stage: 'failed', errorCategory: 'engine_unavailable', usage: null })
      expect(attempt?.errorMessage).toMatch(message)
      const line = h.deps.logs
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((l) => l.event === 'attempt.engine_unavailable')
      expect(line).toMatchObject({ attemptId: attempt?.id, jobId: id })
    },
  )

  it('turning the admin switch off strands nothing: a recorded license still runs', async () => {
    const h = harness({ ENGINES: 'remotion' }, await stores())
    await getSettings(h.deps)
    await h.deps.store.updateSettings({ remotionEnabled: false })
    const id = await remotionVideo(h, 'free')
    expect(await manifestEngine(h, id)).toEqual({ id: 'remotion', tier: 'free' })
  })
})
