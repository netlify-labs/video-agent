// The engines live-test harness, against its local stand-in for the API: no credits, no deployed site.
import { describe, expect, it } from 'vitest'
import { dryPlan, PROJECTED, selftest } from './engines.js'

describe('engines live-test harness', () => {
  it('passes its self-test: runs on y, skips on n, refuses with no answer, stops at the ceiling, cleans up on failure', async () => {
    expect(await selftest()).toEqual([])
  })

  it('--dry prints the phase 1 plan with its credits and makes no request', () => {
    const lines: Record<string, unknown>[] = []
    const code = dryPlan(
      { base: 'https://example.netlify.app', key: 'nva_x', phase: '1', ceiling: 400 },
      (l) => lines.push(JSON.parse(l) as Record<string, unknown>),
    )
    // 2 only when this machine has no ffprobe: the plan is printed either way.
    const env = lines.find((l) => l.step === 'dry_env') as { problems: string[] }
    expect(code).toBe(env.problems.length ? 2 : 0)
    expect(env.problems.filter((p) => !p.includes('ffprobe'))).toEqual([])
    expect(lines.find((l) => l.step === 'dry_credits')).toMatchObject({ projected: 290, ceiling: 400 })
    expect(PROJECTED.create + PROJECTED.editRender).toBe(290)
    expect(lines.find((l) => l.step === 'dry_gate')).toMatchObject({ gate: 1 })
    expect(lines.at(-1)).toMatchObject({ network: 'none' })
  })

  it('says which bead builds the modes that are not here yet', () => {
    const lines: string[] = []
    expect(dryPlan({ base: '', key: '', phase: 'poc', ceiling: 800 }, (l) => lines.push(l))).toBe(2)
    expect(lines.join('\n')).toContain('POC.1')
  })
})
