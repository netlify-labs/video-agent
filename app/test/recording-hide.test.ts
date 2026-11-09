// How a hidden area looks (screen-recording plan §5.3, the owner's 2026-11-06 change): blurred by default, solid when
// an entry says so. The style rides in the trace, the person's setup boxes and redact.js; anything else is refused.
// Style is how a box looks, not whether it hides: the locked-entry check ignores it (recording-check.test.ts).
import { describe, expect, it } from 'vitest'
import { hiddenWhy, inheritRecording, manifestRecording } from '../server/domain/demo-recording.js'
import { parseRedactScript, redactScript } from '../server/lib/recording.js'
import { parseTrace } from '../server/lib/recording-trace.js'

const trace = (redact: unknown[]) =>
  JSON.stringify({
    v: 1,
    source: { kind: 'cli', tool: 't', startedAt: '2026-11-06T00:00:00.000Z' },
    frame: { width: 1280, height: 720, fps: 30, duration: 10 },
    viewport: { width: 1280, height: 720, dpr: 1 },
    moves: [],
    events: [],
    redact,
  })
const entry = { start: 0, end: 5, reason: 'email', boxes: [[0, 0.1, 0.1, 0.2, 0.05]] }

describe('hidden area style', () => {
  it('a trace entry may say blur or solid, nothing else', () => {
    expect(parseTrace(trace([{ ...entry, style: 'solid' }])).redact[0]?.style).toBe('solid')
    expect(parseTrace(trace([entry])).redact[0]?.style).toBeUndefined()
    expect(() => parseTrace(trace([{ ...entry, style: 'pixelate' }]))).toThrow()
  })

  it('redact.js carries the style and refuses an unknown one', () => {
    const text = redactScript([{ ...entry, id: 's1', origin: 'setup', style: 'solid' }] as never)
    const parsed = parseRedactScript(text)
    console.log(JSON.stringify({ test: 'recording-hide', case: 'redact.js', ok: parsed.ok }))
    expect(parsed.ok && parsed.entries[0]?.style).toBe('solid')
    const bad = parseRedactScript(text.replace('"solid"', '"pixelate"'))
    expect(bad.ok).toBe(false)
  })

  it('the Hidden list says why each area is hidden', () => {
    const cases: [Parameters<typeof hiddenWhy>[0], string][] = [
      [{ source: 'setup', reason: 'Hidden by you' }, 'You drew it'],
      [{ source: 'editor', reason: '' }, 'You drew it in the editor'],
      [{ source: 'trace', reason: 'password field' }, 'Password field'],
      [{ source: 'trace', reason: 'hidden field' }, 'Marked hidden when recorded'],
      [{ source: 'trace', reason: 'hidden text' }, 'Text you asked to hide'],
      [{ source: 'trace', reason: 'Privacy mode: email' }, 'Privacy mode: email'],
      [{ source: 'agent', reason: 'Privacy mode: email' }, 'Privacy mode: email'],
      [{ source: 'agent', reason: 'card number' }, 'Added by the agent: card number'],
    ]
    for (const [h, want] of cases) expect(hiddenWhy(h), h.reason).toBe(want)
  })

  it('privacy mode rides into the run manifest and to the next version; off is absent', () => {
    const rec = {
      mediaId: 'med_a',
      trace: null,
      trim: null,
      boxes: [],
      compose: false,
      summary: null,
      hidden: [],
    }
    const media = [
      { kind: 'video', key: 'med_a/original.mp4', sha256: 'a'.repeat(64), filename: 'med_a.mp4' },
    ] as never
    expect(manifestRecording({ ...rec, privacy: true }, media)?.privacy).toBe(true)
    expect(manifestRecording(rec, media)).not.toHaveProperty('privacy')
    expect(inheritRecording({ ...rec, privacy: true })?.privacy).toBe(true)
    expect(inheritRecording(rec)).not.toHaveProperty('privacy')
  })
})
