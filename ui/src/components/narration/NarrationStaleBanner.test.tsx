// The stale-base banner (plan 2026-11-02 §2.7): its text and buttons, the relative time and the render dialog's
// Keep mine warning. Rendered to static markup (the UI tests run without a DOM).
import { MantineProvider } from '@mantine/core'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ago, keepMineWarning, NarrationStaleBanner, type NarrationChanged } from './NarrationStaleBanner'

const NOW = Date.parse('2026-11-03T14:12:00Z')
const changed: NarrationChanged = {
  inVersion: 7,
  by: { userId: 'u_sam', name: 'Sam' },
  at: '2026-11-03T14:02:00Z',
  yoursReplaces: true,
}
const html = (c: NarrationChanged | null) =>
  renderToStaticMarkup(
    <MantineProvider>
      <NarrationStaleBanner changed={c} now={NOW} onRebase={() => undefined} onKeepMine={() => undefined} />
    </MantineProvider>,
  )
const text = (s: string) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

describe('NarrationStaleBanner', () => {
  it('says where and by whom the narration changed, with Rebase and Keep mine', () => {
    const t = text(html(changed))
    expect(t).toContain('Narration changed in v7 (Sam, 10 min ago)')
    expect(t).toContain('Rebase onto v7')
    expect(t).toContain('Keep mine')
  })

  it('is only a note for a draft without its own narration, and nothing when unchanged', () => {
    const t = text(html({ ...changed, yoursReplaces: false }))
    expect(t).toContain('Narration changed in v7')
    expect(t).not.toContain('Rebase')
    expect(html(null)).not.toContain('narration-stale-banner')
  })

  it('warns the render dialog only when rendering replaces their narration', () => {
    expect(keepMineWarning(changed)).toBe('Rendering this draft replaces the narration Sam put in v7.')
    expect(keepMineWarning({ ...changed, yoursReplaces: false })).toBeNull()
    expect(keepMineWarning(null)).toBeNull()
  })

  it('reads times as people say them', () => {
    expect(ago('2026-11-03T14:11:50Z', NOW)).toBe('just now')
    expect(ago('2026-11-03T11:12:00Z', NOW)).toBe('3 h ago')
    expect(ago('2026-11-02T14:12:00Z', NOW)).toBe('1 day ago')
    expect(ago('2026-10-30T14:12:00Z', NOW)).toBe('4 days ago')
  })
})
