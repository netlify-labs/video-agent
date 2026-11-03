// Checks video/ against the editing contract v1 (plan v2 §8): the same validator the editor and render-job use.
//   npx tsx scripts/check-contract.ts [--duck]
// Prints each violation and exits 1, or prints "Contract v1: OK". With a recorded narration bus in video/ (mixed in this
// run, or a narrated parent's), the composition must also last as long as the bus (in a fit: the frozen target).
// --duck first rewrites the music's ducking lane (data-va-duck) under the voices and the narration's speech, which a
// run with locked narration can't edit by hand (plan 2026-11-02 §6.4).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyDucking, load, NARRATION_SRC, save, validate, type Summary } from '../src/lib/contract.js'
import { readPcm16 } from '../src/lib/narration-cleanup.js'
import { repoRoot } from './lib/run-tools.js'

const dir = join(repoRoot, 'video')
const indexPath = join(dir, 'index.html')
let html = readFileSync(indexPath, 'utf8')
if (process.argv.includes('--duck')) {
  const d = load(html)
  applyDucking(d)
  const ducked = save(d)
  if (ducked !== html) {
    writeFileSync(indexPath, ducked)
    html = ducked
    console.log("Rewrote the music's ducking lane.")
  }
}
const summaryPath = join(dir, 'summary.json')
let summary: Summary | undefined
if (existsSync(summaryPath)) {
  try {
    summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as Summary
  } catch {
    console.log('video/summary.json is not valid JSON.')
    process.exit(1)
  }
}
const bus = join(dir, NARRATION_SRC)
let busSamples: number | null = null
try {
  busSamples = existsSync(bus) ? readPcm16(readFileSync(bus)).samples.length : null
} catch {
  console.log(`video/${NARRATION_SRC} isn't a 24 kHz PCM16 WAV.`)
  process.exit(1)
}
const violations = validate(html, summary, busSamples === null ? {} : { narration: { busSamples } })
if (violations.length) {
  for (const v of violations) console.log(`- ${v}`)
  process.exit(1)
}
console.log('Contract v1: OK')
