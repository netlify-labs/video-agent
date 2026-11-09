// Which look a version gets (plan 2026-11-04-looks §4.3, §4.14): resolution, restyles, the engine rule, aspect
// notices, and the look_not_allowed status override.
import { describe, expect, it } from 'vitest'
import {
  aspectNotice,
  assertLookSupportsEngine,
  chooseEngine,
  getLook,
  isRestyle,
  resolveLook,
  type ResolvedLook,
} from '../server/domain/looks.js'
import type { VersionLook } from '../server/domain/types.js'
import { ApiError, errorBody } from '../server/lib/errors.js'
import { makeDeps } from './fakes.js'

const snapshot = (id: string, hash: string): VersionLook => ({
  id,
  name: id,
  hash,
  key: `vid_1/looks/${hash}.tar.gz`,
  sha256: 'a'.repeat(64),
  bytes: 10,
  source: 'builtin',
  restyle: false,
})

const code = (f: () => unknown) => {
  try {
    f()
  } catch (e) {
    return e instanceof ApiError ? [e.code, e.status] : String(e)
  }
  return null
}
const id = (r: ResolvedLook) =>
  r.kind === 'none' ? null : r.kind === 'inherit' ? `inherit:${r.look.id}` : r.entry.id

describe('resolveLook', () => {
  const create = { defaultLook: null, disabled: [] }

  it('explicit null is never the default, on create or with a parent', () => {
    const deps = makeDeps()
    expect(
      resolveLook(deps, { look: null }, { ...create, defaultLook: 'clean', planLook: 'kinetic' }),
    ).toEqual({
      kind: 'none',
    })
    expect(
      resolveLook(
        deps,
        { look: null },
        { inherited: snapshot('clean', 'h'), defaultLook: 'clean', disabled: [] },
      ),
    ).toEqual({ kind: 'none' })
  })

  it('an explicit id is that look current version; unknown is 400, disabled is 409', () => {
    const deps = makeDeps()
    expect(id(resolveLook(deps, { look: 'kinetic' }, create))).toBe('kinetic')
    expect(code(() => resolveLook(deps, { look: 'nope' }, create))).toEqual(['unknown_look', 400])
    expect(code(() => resolveLook(deps, { look: 'kinetic' }, { ...create, disabled: ['kinetic'] }))).toEqual([
      'look_disabled',
      409,
    ])
  })

  it('create with look omitted: the plan, then the default, then none', () => {
    const deps = makeDeps()
    expect(id(resolveLook(deps, {}, { ...create, planLook: 'kinetic', defaultLook: 'clean' }))).toBe(
      'kinetic',
    )
    expect(id(resolveLook(deps, {}, { ...create, defaultLook: 'clean' }))).toBe('clean')
    expect(resolveLook(deps, {}, create)).toEqual({ kind: 'none' })
  })

  it('a stale plan look or default falls through with a log, never a 400', () => {
    const deps = makeDeps()
    expect(
      id(resolveLook(deps, {}, { planLook: 'kinetic', defaultLook: 'clean', disabled: ['kinetic'] })),
    ).toBe('clean')
    expect(resolveLook(deps, {}, { ...create, defaultLook: 'gone' })).toEqual({ kind: 'none' })
    const fallbacks = deps.logs.filter((l) => l.includes('look.fallback'))
    expect(fallbacks).toHaveLength(2)
    expect(fallbacks[0]).toContain('"from":"plan"')
    expect(fallbacks[0]).toContain('"reason":"disabled"')
    expect(fallbacks[1]).toContain('"from":"default"')
    expect(fallbacks[1]).toContain('"reason":"unknown"')
  })

  it("omitted with a parent keeps the parent's value, none included, even with a default set", () => {
    const deps = makeDeps()
    const ctx = { defaultLook: 'clean', disabled: [] }
    expect(resolveLook(deps, {}, { ...ctx, inherited: null })).toEqual({ kind: 'none' })
    const parent = snapshot('kinetic', 'old')
    expect(resolveLook(deps, {}, { ...ctx, inherited: parent })).toEqual({ kind: 'inherit', look: parent })
  })

  it('inheriting never checks the catalog or the disabled list', () => {
    const deps = makeDeps()
    const removed = snapshot('retro-crt', 'h1')
    expect(resolveLook(deps, {}, { inherited: removed, defaultLook: null, disabled: ['retro-crt'] })).toEqual(
      {
        kind: 'inherit',
        look: removed,
      },
    )
  })
})

describe('isRestyle', () => {
  const deps = makeDeps()
  const kinetic = getLook(deps, 'kinetic')!

  it("the parent's own look at the same hash isn't a restyle; inheriting and none aren't either", () => {
    const parent = snapshot('kinetic', kinetic.hash)
    expect(isRestyle(parent, { kind: 'pick', entry: kinetic })).toBe(false)
    expect(isRestyle(parent, { kind: 'inherit', look: parent })).toBe(false)
    expect(isRestyle(parent, { kind: 'none' })).toBe(false)
    expect(isRestyle(null, { kind: 'none' })).toBe(false)
  })

  it('another look, the same look at a newer hash, or a look where there was none is', () => {
    expect(isRestyle(snapshot('clean', 'x'), { kind: 'pick', entry: kinetic })).toBe(true)
    expect(isRestyle(snapshot('kinetic', 'older'), { kind: 'pick', entry: kinetic })).toBe(true)
    expect(isRestyle(null, { kind: 'pick', entry: kinetic })).toBe(true)
  })

  it('a catalog change gives the same id a new hash', () => {
    const d = makeDeps()
    const before = getLook(d, 'kinetic')!.hash
    d.looks.entries = d.looks.entries.map((e) =>
      e.id === 'kinetic' ? d.looks.make('kinetic', { body: 'v2' }) : e,
    )
    expect(getLook(d, 'kinetic')!.hash).not.toBe(before)
    expect(isRestyle(snapshot('kinetic', before), { kind: 'pick', entry: getLook(d, 'kinetic')! })).toBe(true)
  })
})

describe('chooseEngine', () => {
  const both = { name: 'Both', engines: ['remotion', 'hyperframes'] as ('remotion' | 'hyperframes')[] }
  const hf = { name: 'HF', engines: ['hyperframes'] as 'hyperframes'[] }

  it("takes the request's engine when the look lists it and it's enabled", () => {
    expect(
      chooseEngine({ requestEngine: 'remotion', look: both, enabled: ['hyperframes', 'remotion'] }),
    ).toBe('remotion')
    expect(
      code(() => chooseEngine({ requestEngine: 'remotion', look: hf, enabled: ['hyperframes', 'remotion'] })),
    ).toEqual(['engine_not_supported_by_look', 400])
    expect(
      code(() => chooseEngine({ requestEngine: 'remotion', look: both, enabled: ['hyperframes'] })),
    ).toEqual(['engine_disabled', 409])
  })

  it("else the look's first enabled engine, else HyperFrames", () => {
    expect(chooseEngine({ look: both, enabled: ['hyperframes', 'remotion'] })).toBe('remotion')
    expect(chooseEngine({ look: both, enabled: ['hyperframes'] })).toBe('hyperframes')
    expect(chooseEngine({ look: null, enabled: ['hyperframes'] })).toBe('hyperframes')
  })

  it("a restyle into a look that doesn't list the version's engine is refused", () => {
    expect(code(() => assertLookSupportsEngine(hf, 'remotion'))).toEqual([
      'engine_not_supported_by_look',
      400,
    ])
    expect(code(() => assertLookSupportsEngine(both, 'remotion'))).toBeNull()
  })
})

describe('aspect notices and errors', () => {
  it("notes a shape the look wasn't made for, never refuses", () => {
    expect(aspectNotice({ name: 'Retro CRT', aspects: ['16:9', '9:16'] }, '4:5')).toBe(
      "Retro CRT wasn't made for 4:5.",
    )
    expect(aspectNotice({ name: 'Clean', aspects: ['16:9', '9:16', '1:1', '4:5'] }, '4:5')).toBeNull()
  })

  it('look_not_allowed is 400, and 409 with the override; the body is the same', () => {
    expect(new ApiError('look_not_allowed', 'x').status).toBe(400)
    expect(new ApiError('look_not_allowed', 'x', undefined, { status: 409 }).status).toBe(409)
    expect(errorBody('look_not_allowed', 'x')).toEqual({ error: { code: 'look_not_allowed', message: 'x' } })
  })
})
