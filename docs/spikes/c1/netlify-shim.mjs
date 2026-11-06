#!/usr/bin/env node
// Spike C1: stands in for the netlify CLI inside a local workspace. `blobs:get <store> <key> --output <file>` reads
// <ws>/.va-inputs/<store>/<key>; `blobs:set <store> <key> --input <file>` copies into <ws>/.va-uploads/<store>/<key>.
// Prototype of prepare-run --inputs and render-job --upload local (bead va-p1th.5.1 makes them real flags).
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const [cmd, store, key, ...rest] = process.argv.slice(2)
const ws = process.env.VA_REPO_ROOT
const flag = (name) => rest[rest.indexOf(name) + 1]
if (!ws || !store || !key) {
  console.error('netlify-shim: VA_REPO_ROOT, store and key are required')
  process.exit(2)
}
if (cmd === 'blobs:get') {
  const to = flag('--output')
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(join(ws, '.va-inputs', store, key), to)
} else if (cmd === 'blobs:set') {
  const to = join(ws, '.va-uploads', store, key)
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(flag('--input'), to)
} else {
  console.error(`netlify-shim: ${cmd} is not supported`)
  process.exit(2)
}
