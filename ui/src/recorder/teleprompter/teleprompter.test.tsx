// The teleprompter (plan 2026-11-02 §2.1 step 3, §5.3): line timing from beats with and without a script, the time
// from picture anchors, the T toggle's key rules, and the panel and its narrow layout rendered to static markup (the
// UI tests run without a DOM). On the contract-1 voice fixture: intro 0-3 s (voiced), demo 3-6 s, outro 6-9 s
// (voiced).
import { MantineProvider } from '@mantine/core'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { applyHoldFrame, load, read, save } from '../../../../src/lib/contract'
import type { Anchor } from '../clock/picture'
import { NEXT_LEAD_SEC, linesAt, pictureTime, prompterLines } from './lines'
import { PrompterLayout, Teleprompter, isPrompterToggle, isTextField, prompterLayout } from './Teleprompter'

const HTML = readFileSync(
  new URL('../../../../test/fixtures/contract1-voice/index.html', import.meta.url),
  'utf8',
)
const COMP = read(load(HTML))

describe('lines', () => {
  it("uses each beat's on-screen texts without a script, timed by the beats", () => {
    const lines = prompterLines(COMP)
    expect(lines.map(({ beat, start, end, source }) => [beat, start, end, source])).toEqual([
      ['intro', 0, 3, 'beat-text'],
      ['demo', 3, 6, 'beat-text'],
      ['outro', 6, 9, 'beat-text'],
    ])
    expect(lines[0]?.text).toBe('Netlify · Org webhooks')
    expect(lines[1]?.text).toContain('One subscription for every project')
    expect(lines[2]?.text).toBe('Read the docs')
    // The html reads the same.
    expect(prompterLines(HTML).map((l) => l.beat)).toEqual(['intro', 'demo', 'outro'])
    expect(prompterLines('<p>no composition</p>')).toEqual([])
  })

  it('uses the voice-over script by beat in order, falling back to beat texts where it has none', () => {
    const all = prompterLines(COMP, ['Hello there.', 'One for all.', 'Go read.'])
    expect(all.map((l) => [l.beat, l.text, l.source])).toEqual([
      ['intro', 'Hello there.', 'script'],
      ['demo', 'One for all.', 'script'],
      ['outro', 'Go read.', 'script'],
    ])
    // Two lines for two voiced beats: they go to the voiced beats; the unvoiced one shows its text.
    const voiced = prompterLines(COMP, ['Hello there.', 'Go read.'])
    expect(voiced.map((l) => [l.beat, l.source])).toEqual([
      ['intro', 'script'],
      ['demo', 'beat-text'],
      ['outro', 'script'],
    ])
    expect(voiced[2]?.text).toBe('Go read.')
    // Lines by beat id (script.json), and an empty line falls back too.
    const byId = prompterLines(COMP, { outro: '  Bye  now ', intro: '' })
    expect(byId.map((l) => [l.beat, l.source])).toEqual([
      ['intro', 'beat-text'],
      ['demo', 'beat-text'],
      ['outro', 'script'],
    ])
    expect(byId[2]?.text).toBe('Bye now')
  })

  it('leaves the held final frame out', () => {
    const d = load(HTML)
    applyHoldFrame(d, 4)
    expect(prompterLines(save(d)).map((l) => l.beat)).toEqual(['intro', 'demo', 'outro'])
  })

  it('highlights the line on screen and shows the next one dimmed half a second before its beat', () => {
    const lines = prompterLines(COMP)
    expect(linesAt(lines, 0)).toEqual({ current: 0, next: null })
    expect(linesAt(lines, 2.4)).toEqual({ current: 0, next: null })
    expect(linesAt(lines, 3 - NEXT_LEAD_SEC)).toEqual({ current: 0, next: 1 })
    expect(linesAt(lines, 3)).toEqual({ current: 1, next: null })
    expect(linesAt(lines, 8.99)).toEqual({ current: 2, next: null })
    expect(linesAt(lines, 9)).toEqual({ current: null, next: null })
    // A gap without a line (demo has no text here): nothing current, the next one still leads in.
    const gap = lines.filter((l) => l.beat !== 'demo')
    expect(linesAt(gap, 4)).toEqual({ current: null, next: null })
    expect(linesAt(gap, 5.6)).toEqual({ current: null, next: 1 })
  })

  it('reads the picture time from the anchors, holding the last frame once they stop', () => {
    const frames: Anchor[] = Array.from({ length: 12 }, (_, k) => {
      const e = 1000 + (k * 1000) / 30
      return { mediaTime: 2 + k / 30, expectedDisplayTime: e, now: e, presentedFrames: k }
    })
    expect(pictureTime([], 0)).toBeNull()
    // Perf 1400 is 0.4 s after composition 2 was on screen.
    expect(pictureTime(frames, 1400)).toBeCloseTo(2.4, 9)
    expect(pictureTime(frames.slice(0, 2), 1040)).toBeCloseTo(2.04, 9)
    expect(pictureTime(frames, 5000)).toBeCloseTo(2 + 11 / 30, 9)
  })
})

describe('T toggle', () => {
  const input = { tagName: 'INPUT' } as unknown as EventTarget
  it('toggles on a plain T outside text fields', () => {
    expect(isPrompterToggle({ key: 't' })).toBe(true)
    expect(isPrompterToggle({ key: 'T', target: { tagName: 'DIV' } as unknown as EventTarget })).toBe(true)
    expect(isPrompterToggle({ key: 't', target: input })).toBe(false)
    expect(isPrompterToggle({ key: 't', target: { tagName: 'textarea' } as unknown as EventTarget })).toBe(
      false,
    )
    expect(
      isPrompterToggle({
        key: 't',
        target: { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget,
      }),
    ).toBe(false)
    expect(isPrompterToggle({ key: 't', metaKey: true })).toBe(false)
    expect(isPrompterToggle({ key: 't', ctrlKey: true })).toBe(false)
    expect(isPrompterToggle({ key: 't', repeat: true })).toBe(false)
    expect(isPrompterToggle({ key: 'r' })).toBe(false)
    expect(isTextField(null)).toBe(false)
  })
})

describe('panel', () => {
  const html = (node: React.ReactNode) => renderToStaticMarkup(<MantineProvider>{node}</MantineProvider>)

  it('shows the current line highlighted and the next dimmed, as a visual aid with no live region', () => {
    const out = html(<Teleprompter composition={COMP} time={2.6} fontSize={40} />)
    expect(out).toContain('aria-label="Teleprompter"')
    expect(out).not.toContain('aria-live')
    expect(out).toMatch(/data-state="current" data-beat="intro">Netlify · Org webhooks</)
    expect(out).toMatch(/data-state="next" data-beat="demo">/)
    expect(out).toContain('font-size:40px')
    expect(out).toContain('On-screen text')
    expect(html(<Teleprompter composition={COMP} script={['a', 'b', 'c']} time={0} />)).toContain('Script')
  })

  it('renders hidden when toggled off, and says when there is nothing to read', () => {
    const hidden = html(<Teleprompter composition={COMP} time={1} visible={false} />)
    expect(hidden).toContain('data-visible="false"')
    expect(hidden).toContain('Press T to show it')
    expect(hidden).not.toContain('Org webhooks')
    const empty = html(<Teleprompter composition="<p>none</p>" time={1} />)
    expect(empty).toContain('no script or on-screen text')
  })

  it('sits beside the picture on wide windows and below it on narrow ones', () => {
    expect(prompterLayout(1440)).toBe('beside')
    expect(prompterLayout(900)).toBe('stacked')
    expect(prompterLayout(390)).toBe('stacked')
    const stacked = html(<PrompterLayout layout="stacked" picture={<video />} prompter={<p>lines</p>} />)
    expect(stacked).toContain('data-layout="stacked"')
    // Without a window the layout starts beside (matchMedia corrects it on mount).
    expect(html(<PrompterLayout picture={<video />} prompter={<p>lines</p>} />)).toContain(
      'data-layout="beside"',
    )
    const css = readFileSync(new URL('./teleprompter.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\[data-layout='stacked'\] \{\s+grid-template-columns: minmax\(0, 1fr\)/)
  })
})
