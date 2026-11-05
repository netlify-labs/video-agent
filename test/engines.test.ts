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
import { makeDeps } from './fakes.js'

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
