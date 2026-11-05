// The engine registry (render-engines plan §4.1): names, licenses, the capability table, what's enabled in Phase 1,
// and the ScopeCheck hook the regenerate-beat plan registers into.
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import {
  ENGINE_IDS,
  type EditOpName,
  enabledEngines,
  engineInfo,
  isEngineId,
  registerScopeCheck,
  resetScopeChecks,
  type ScopeCheck,
  scopeCheckFor,
} from '../src/domain/engines.js'
import { readConfig } from '../src/deps.js'
import { getSettings } from '../src/domain/settings.js'
import { remotionConfigured } from '../src/domain/engines.js'
import { makeDeps } from './fakes.js'
import { harness, pgStore } from './helpers.js'

afterEach(() => resetScopeChecks())

describe('engines', () => {
  it('names both engines and their licenses', () => {
    expect(ENGINE_IDS).toEqual(['hyperframes', 'remotion'])
    expect(engineInfo('hyperframes')).toMatchObject({
      id: 'hyperframes',
      name: 'HyperFrames',
      license: { kind: 'open', spdx: 'Apache-2.0' },
    })
    expect(engineInfo('remotion')).toMatchObject({
      id: 'remotion',
      name: 'Remotion',
      license: { kind: 'remotion', url: 'https://www.remotion.dev/docs/license' },
    })
  })

  it("HyperFrames has the eight contract ops, the recording scenes' four and every authoring feature", () => {
    expect(engineInfo('hyperframes').capabilities).toEqual({
      editOps: [
        'text',
        'retime',
        'reorder',
        'delete',
        'color',
        'media',
        'audio',
        'voice',
        'span',
        'camera',
        'cursor',
        'redact',
      ],
      liveDraftPreview: true,
      sound: 'all',
      voiceover: true,
      revoice: true,
      recordedNarration: true,
      scopedRevision: false,
      recording: true,
    })
  })

  it('Remotion matches the plan’s Phase 2 column: music only, not editable', () => {
    expect(engineInfo('remotion').capabilities).toEqual({
      editOps: [],
      liveDraftPreview: false,
      sound: 'music',
      voiceover: false,
      revoice: false,
      recordedNarration: false,
      scopedRevision: false,
      recording: false,
    })
  })

  it('enables only HyperFrames in Phase 1', async () => {
    expect((await enabledEngines(makeDeps())).map((e) => e.id)).toEqual(['hyperframes'])
  })

  it('isEngineId accepts only the exact ids', () => {
    expect(isEngineId('hyperframes')).toBe(true)
    expect(isEngineId('remotion')).toBe(true)
    for (const x of ['Remotion', 'HyperFrames', '', 'lottie', null, undefined, 1])
      expect(isEngineId(x)).toBe(false)
  })

  it('scopeCheckFor is null until a check is registered, and scopedRevision follows it', () => {
    expect(scopeCheckFor('hyperframes')).toBeNull()
    expect(scopeCheckFor('remotion')).toBeNull()
    const check: ScopeCheck = (parent) => ({ problems: [], files: parent })
    registerScopeCheck('hyperframes', check)
    expect(scopeCheckFor('hyperframes')).toBe(check)
    expect(engineInfo('hyperframes').capabilities.scopedRevision).toBe(true)
    expect(scopeCheckFor('remotion')).toBeNull()
    expect(engineInfo('remotion').capabilities.scopedRevision).toBe(false)
  })

  it('the registry resets between tests', () => {
    expect(scopeCheckFor('hyperframes')).toBeNull()
    expect(engineInfo('hyperframes').capabilities.scopedRevision).toBe(false)
  })

  it('EditOpName admits the screen-recording ops', () => {
    expectTypeOf<'span' | 'camera' | 'cursor' | 'redact' | 'text'>().toExtend<EditOpName>()
    expectTypeOf<'fly'>().not.toExtend<EditOpName>()
  })
})

describe('which engines a deployment offers (render-engines §7)', () => {
  const ack = (tier: 'free' | 'company') => ({
    by: 'u_admin',
    email: 'a@acme.com',
    at: '2026-11-05T00:00:00Z',
    tier,
    note: null,
  })
  async function offered(
    env: Record<string, string>,
    settings: { remotionEnabled?: boolean; remotionLicenseAck?: ReturnType<typeof ack> | null },
  ) {
    const deps = makeDeps(env)
    await getSettings(deps)
    await deps.store.updateSettings(settings)
    return (await enabledEngines(deps)).map((e) => e.id)
  }

  it.each([
    ['ENGINES unset', {}, { remotionEnabled: true, remotionLicenseAck: ack('free') }, ['hyperframes']],
    [
      'listed, switched off',
      { ENGINES: 'hyperframes,remotion' },
      { remotionEnabled: false, remotionLicenseAck: ack('free') },
      ['hyperframes'],
    ],
    [
      'listed, on, no license choice',
      { ENGINES: 'remotion' },
      { remotionEnabled: true, remotionLicenseAck: null },
      ['hyperframes'],
    ],
    [
      'listed, on, Free License',
      { ENGINES: 'remotion' },
      { remotionEnabled: true, remotionLicenseAck: ack('free') },
      ['hyperframes', 'remotion'],
    ],
    [
      'listed, on, Company License with its key',
      { ENGINES: 'remotion', VIDEO_AGENT_REMOTION_KEY: 'rm_sec_x' },
      { remotionEnabled: true, remotionLicenseAck: ack('company') },
      ['hyperframes', 'remotion'],
    ],
    [
      'listed, on, Company License without its key',
      { ENGINES: 'remotion' },
      { remotionEnabled: true, remotionLicenseAck: ack('company') },
      ['hyperframes'],
    ],
    [
      'not listed, key set, on',
      { VIDEO_AGENT_REMOTION_KEY: 'rm_sec_x' },
      { remotionEnabled: true, remotionLicenseAck: ack('company') },
      ['hyperframes'],
    ],
    ['listed, never configured', { ENGINES: 'remotion' }, {}, ['hyperframes']],
  ])('%s', async (_name, env, settings, want) => {
    expect(await offered(env, settings)).toEqual(want)
  })

  it('reads ENGINES leniently: spaces and case, HyperFrames always first, unknown ids set aside', () => {
    expect(readConfig({ ENGINES: ' Remotion , hyperframes ,lottie' })).toMatchObject({
      engines: ['hyperframes', 'remotion'],
      enginesIgnored: ['lottie'],
    })
    expect(readConfig({}).engines).toEqual(['hyperframes'])
    expect(readConfig({ VIDEO_AGENT_REMOTION_KEY: '  ' }).remotionKeySet).toBe(false)
    expect(readConfig({ VIDEO_AGENT_REMOTION_DEVELOPMENT: '1' }).remotionDevelopmentRenders).toBe(true)
    expect(remotionConfigured({ config: readConfig({ ENGINES: 'remotion' }) })).toBe(true)
    expect(remotionConfigured({ config: readConfig({}) })).toBe(false)
  })

  it('with ENGINES unset, /api/v1/config is what it was', async () => {
    const plain = harness()
    const named = harness({ ENGINES: 'hyperframes' })
    const body = async (h: ReturnType<typeof harness>) =>
      (await h.call('GET', '/api/v1/config', { as: h.member })).text()
    const [a, b] = [await body(plain), await body(named)]
    expect(a).toBe(b)
    expect(a).not.toContain('remotion')
  })

  it('the settings columns default off and round-trip on Postgres', async () => {
    const deps = makeDeps({}, await pgStore())
    await getSettings(deps)
    expect(await deps.store.getSettings()).toMatchObject({ remotionEnabled: false, remotionLicenseAck: null })
    await deps.store.updateSettings({ remotionEnabled: true, remotionLicenseAck: ack('company') })
    expect(await deps.store.getSettings()).toMatchObject({
      remotionEnabled: true,
      remotionLicenseAck: ack('company'),
    })
  })
})
