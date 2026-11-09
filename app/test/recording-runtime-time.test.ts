// vendor/va-recording.js converts source seconds to authored beat time with its own copy of app/server/lib/recording.ts
// authoredTime (it's plain ES5 in the composition). They must agree (va-rsk5.3.8).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { authoredTime } from '../server/lib/recording.js'

it("va-recording.js's time formula equals authoredTime for 100 cases", () => {
  const window: { vaRecordingTime?: (s: number, i: number, o: number, a: number) => number } = {}
  runInNewContext(
    readFileSync(join(import.meta.dirname, '..', '..', 'video', 'vendor', 'va-recording.js'), 'utf8'),
    { window },
  )
  // A fixed LCG, so the cases are the same every run.
  let seed = 42
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32
  for (let i = 0; i < 100; i++) {
    const inS = rnd() * 200
    const outS = inS + 0.1 + rnd() * 100
    const authored = 0.5 + rnd() * 60
    const s = inS + rnd() * (outS - inS)
    const expected = authoredTime(s, inS, outS, authored)
    const actual = window.vaRecordingTime?.(s, inS, outS, authored)
    if (i % 25 === 0) console.log(JSON.stringify({ case: 'time', t: s, expected, actual }))
    expect(actual).toBe(expected)
  }
})
