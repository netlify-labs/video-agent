// The UI's copies of the server's redo-a-scene strings (app/web/src/lib/scenes.ts) must not drift from app/server/lib/scope.ts:
// the refusal fallback on the video page and the chip rules depend on them.
import { describe, expect, it } from 'vitest'
import { HOLD_BEAT as SERVER_HOLD } from '../server/lib/contract.js'
import * as server from '../server/lib/scope.js'
import {
  HELD_REASON,
  HOLD_BEAT,
  isScopeRefusal,
  MAX_PICKS,
  SCOPE_REFUSED_PREFIX,
  SCOPE_VIOLATED,
} from '../web/src/lib/scenes.js'

const held = [
  { id: 'hook', label: 'Hook' },
  { id: 'end', label: null },
  { id: 'va-hold', label: null },
]

describe('app/web/src/lib/scenes.ts against the server', () => {
  it('recognizes both refusals, like the server', () => {
    for (const m of [
      'scope_violated: the intro changed',
      `${SCOPE_REFUSED_PREFIX}: intro-title`,
      'The run ended without a video.',
      null,
    ])
      expect(isScopeRefusal(m)).toBe(server.isScopeRefusal(m))
  })

  it('keeps its copies of the server constants in step with app/server/lib/scope.ts', () => {
    expect(SCOPE_VIOLATED).toBe(server.SCOPE_VIOLATED)
    expect(SCOPE_REFUSED_PREFIX).toBe(server.SCOPE_REFUSED_PREFIX)
    expect(MAX_PICKS).toBe(server.MAX_SCOPED_BEATS)
    expect(HOLD_BEAT).toBe(SERVER_HOLD)
    const refusal = server.scopeRules(held, ['end'])
    expect('refusal' in refusal ? refusal.refusal : '').toBe(HELD_REASON)
  })
})
