// Checks video/ against the editing contract v1 (plan v2 §8): the same validator the editor and render-job use.
//   npx tsx scripts/check-contract.ts
// Prints each violation and exits 1, or prints "Contract v1: OK".
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validate, type Summary } from '../src/lib/contract.js'
import { repoRoot } from './lib/run-tools.js'

const dir = join(repoRoot, 'video')
const html = readFileSync(join(dir, 'index.html'), 'utf8')
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
const violations = validate(html, summary)
if (violations.length) {
  for (const v of violations) console.log(`- ${v}`)
  process.exit(1)
}
console.log('Contract v1: OK')
