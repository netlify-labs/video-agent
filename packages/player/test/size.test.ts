// The player's size budget (cli-and-sdk plan §7): under 6 kB gzipped, minified, with no dependencies.
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { buildSync } from 'esbuild'
import { expect, it } from 'vitest'

it('is under 6 kB gzipped, with no dependencies', () => {
  const out = buildSync({
    entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
    bundle: true,
    minify: true,
    format: 'esm',
    write: false,
  }).outputFiles[0]
  const gz = gzipSync(out?.contents ?? new Uint8Array()).byteLength
  expect(gz).toBeGreaterThan(500)
  expect(gz).toBeLessThan(6 * 1024)
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    dependencies?: unknown
  }
  expect(pkg.dependencies).toBeUndefined()
})
