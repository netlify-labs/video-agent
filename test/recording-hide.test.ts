// How a hidden area looks (screen-recording plan §5.3, the owner's 2026-11-06 change): blurred by default, solid when
// an entry says so. The style rides in the trace, the person's setup boxes and redact.js; anything else is refused.
// Style is how a box looks, not whether it hides: the locked-entry check ignores it (recording-check.test.ts).
import { describe, expect, it } from 'vitest'
import { parseRedactScript, redactScript } from '../src/lib/recording.js'
import { parseTrace } from '../src/lib/recording-trace.js'

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
})
