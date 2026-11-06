// Spike S8: run the patcher on the contract-1 fixture and write the result for hyperframes check + render.
//   npx tsx docs/spikes/s8/patch.ts
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyEdits, type Summary } from '../../../src/lib/contract.js'

const here = new URL('.', import.meta.url).pathname
const out = join(here, 'variants', 'patched')
rmSync(out, { recursive: true, force: true })
cpSync(join(here, 'fixture'), out, { recursive: true, filter: (p) => !p.includes('.hyperframes') })
cpSync(join(here, 'fixture/assets/media/med_logo.svg'), join(out, 'assets/media/med_logo2.svg'))
const r = applyEdits(
  readFileSync(join(here, 'fixture/index.html'), 'utf8'),
  JSON.parse(readFileSync(join(here, 'fixture/summary.json'), 'utf8')) as Summary,
  [
    { op: 'retime', beat: 'intro', duration: 4.5 },
    { op: 'reorder', order: ['intro', 'outro', 'demo'] },
    { op: 'text', id: 'outro-cta', text: 'Start free today' },
    { op: 'color', role: 'accent', value: '#ff5a1f' },
    { op: 'media', slot: 'logo', src: 'assets/media/med_logo2.svg', kind: 'image', fit: 'contain' },
  ],
)
writeFileSync(join(out, 'index.html'), r.html)
writeFileSync(join(out, 'summary.json'), JSON.stringify(r.summary, null, 2))
console.log(JSON.stringify({ beats: r.composition.beats.map((b) => [b.id, b.start, b.duration]), captions: r.summary.captions }))
