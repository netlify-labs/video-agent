// Spike B1 (redo a scene, docs/plans/2026-11-04-regenerate-beat.md §4.6): does the renderer's Chrome apply a
// prelude-less @scope in a <style> inside a beat to that beat only? The fixture (test/fixtures/scope/at-scope) has the
// same .card in three scenes and in a root layer: scene 2 styles it red with `@scope { … }`, scene 3 blue with the
// fallback `@scope ([data-va-beat="three"]) { … }`. HyperFrames' own snapshot (as scripts/lib/hold-still.ts uses it)
// captures each scene; one pixel of each card is sampled. No credits.
//   npx tsx docs/spikes/b1/b1.ts
// Logs one JSON line per sample { beat, at, where, colour, expected, ok } and exits 1 when any is wrong.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attr, load, validate, walk } from '../../../app/server/lib/contract.js'
import { scopedStyleProblems } from '../../../app/server/lib/scope-style.js'

const fixture = 'test/fixtures/scope/at-scope/index.html'
const html = readFileSync(fixture, 'utf8')
const problems = validate(html)
if (problems.length) throw new Error(`The fixture isn't contract v1: ${problems.join(' ')}`)
const beat = (id: string) => [...walk(load(html).root)].find((e) => attr(e, 'data-va-beat') === id)!
// The prelude-less form is what the style check accepts; the prelude form only with allowPrelude.
console.log(
  JSON.stringify({
    step: 'style-check',
    two: scopedStyleProblems(beat('two'), 'two'),
    three: scopedStyleProblems(beat('three'), 'three', { allowPrelude: true }),
  }),
)

const dir = mkdtempSync(join(tmpdir(), 'va-b1-'))
mkdirSync(join(dir, 'vendor'))
for (const f of ['gsap.min.js', 'va-contract.js'])
  copyFileSync(join('video/vendor', f), join(dir, 'vendor', f))
for (const f of ['hyperframes.json', 'package.json', 'meta.json'])
  copyFileSync(join('video', f), join(dir, f))
copyFileSync(fixture, join(dir, 'index.html'))
const out = join(dir, 'snaps')
const times = { one: 0.5, two: 1.5, three: 2.5 }
execFileSync(
  'npx',
  [
    '-y',
    'hyperframes',
    'snapshot',
    '--at',
    Object.values(times).join(','),
    '--no-end',
    '--keep',
    '--output',
    out,
    dir,
  ],
  {
    stdio: ['ignore', 'ignore', 'inherit'],
  },
)

/** The RGB of one pixel of a PNG, via ffmpeg. */
function pixel(file: string, x: number, y: number): [number, number, number] {
  const b = execFileSync('ffmpeg', [
    '-loglevel',
    'error',
    '-i',
    file,
    '-vf',
    `format=rgb24,scale=640:360,crop=1:1:${x}:${y}`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-',
  ])
  return [b[0] ?? 0, b[1] ?? 0, b[2] ?? 0]
}
const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - (b[i] ?? 0)) < 40)
const WHITE = [255, 255, 255]
const want: Record<string, number[]> = { one: WHITE, two: [255, 0, 0], three: [0, 0, 255] }
let failed = 0
for (const [id, at] of Object.entries(times)) {
  const file = join(out, `at-${at}s.png`)
  for (const [where, x, y, expected] of [
    ['scene card', 320, 180, want[id]!],
    ['root layer card', 320, 20, WHITE],
  ] as const) {
    const colour = pixel(file, x, y)
    const ok = near(colour, expected)
    if (!ok) failed++
    console.log(JSON.stringify({ beat: id, at, where, colour, expected, ok }))
  }
}
console.log(JSON.stringify({ step: 'done', failed }))
process.exit(failed ? 1 : 0)
