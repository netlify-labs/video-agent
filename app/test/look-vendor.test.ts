// look:vendor (plan 2026-11-04-looks §4.5): vendors a look's registry items from a stubbed `hyperframes add`, writes a
// lock look:check accepts, refuses items with no known licence, and a second run changes nothing.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runLookCheck } from '../../scripts/look-check.js'
import { LookVendorError, vendorLook, type AddResult } from '../../scripts/look-vendor.js'

const repoRoot = new URL('../..', import.meta.url).pathname
const VERSION = '0.8.222'
const GRAIN = '<div class="grain-overlay"></div>\n'

/** A fake `hyperframes add`: writes what the real one writes for a component and a block in its own folder. */
function fakeAdd(files: Record<string, Record<string, string>>) {
  const calls: string[] = []
  const add = (name: string, dir: string): AddResult => {
    calls.push(name)
    const block = name === 'code-slice-hero'
    const written = Object.entries(files[name] ?? {}).map(([rel, body]) => {
      const p = join(dir, 'compositions', ...(block ? [name, rel] : ['components', rel]))
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, body)
      return p
    })
    return {
      ok: true,
      name,
      type: block ? 'hyperframes:block' : 'hyperframes:component',
      typeDir: block ? 'blocks' : 'components',
      written,
    }
  }
  return { add, calls }
}

function lookWith(registry: string[]) {
  const looksDir = mkdtempSync(join(tmpdir(), 'looks-'))
  const dir = join(looksDir, 'demo')
  cpSync(join(repoRoot, 'app', 'looks', '_template'), dir, { recursive: true })
  const look = JSON.parse(readFileSync(join(dir, 'look.json'), 'utf8'))
  writeFileSync(join(dir, 'look.json'), JSON.stringify({ ...look, id: 'demo', registry }))
  return { looksDir, dir }
}

describe('look:vendor', () => {
  it('vendors a component into a lock look:check accepts, and a second run changes nothing', () => {
    const { looksDir, dir } = lookWith(['grain-overlay'])
    const { add } = fakeAdd({ 'grain-overlay': { 'grain-overlay.html': GRAIN } })
    const opts = { repoRoot, hyperframesVersion: VERSION, add }
    expect(vendorLook(dir, opts)).toEqual([
      '+ registry/grain-overlay/grain-overlay.html',
      '~ registry/registry.lock.json',
    ])
    expect(readFileSync(join(dir, 'registry', 'grain-overlay', 'grain-overlay.html'), 'utf8')).toBe(GRAIN)
    const lock = JSON.parse(readFileSync(join(dir, 'registry', 'registry.lock.json'), 'utf8'))
    expect(lock).toMatchObject({
      tag: 'v0.8.222',
      items: [
        {
          name: 'grain-overlay',
          type: 'component',
          upstream: 'registry/components/grain-overlay',
          license: 'Apache-2.0',
          files: [{ path: 'grain-overlay.html' }],
        },
      ],
    })
    const problems = runLookCheck(looksDir, ['demo'], VERSION).problems.filter(
      (p) => !/preview|poster/.test(p),
    )
    expect(problems).toEqual([])
    expect(vendorLook(dir, opts)).toEqual([])
  })

  it("leaves out a block's bundled third-party files and strips its folder", () => {
    const { dir } = lookWith(['code-slice-hero'])
    const { add } = fakeAdd({
      'code-slice-hero': {
        'code-slice-hero.html': '<div></div>',
        'surface.js': '1',
        'assets/gsap-3.14.2.min.js': 'gsap',
        'assets/Geist-Bold.ttf': 'font',
      },
    })
    vendorLook(dir, { repoRoot, hyperframesVersion: VERSION, add })
    const lock = JSON.parse(readFileSync(join(dir, 'registry', 'registry.lock.json'), 'utf8'))
    expect(lock.items[0].upstream).toBe('registry/blocks/code-slice-hero')
    expect(lock.items[0].files.map((f: { path: string }) => f.path)).toEqual([
      'code-slice-hero.html',
      'surface.js',
    ])
  })

  it('refuses an item with no known licence before installing anything', () => {
    const { dir } = lookWith(['canopy-part-title', 'grain-overlay'])
    const { add, calls } = fakeAdd({})
    expect(() => vendorLook(dir, { repoRoot, hyperframesVersion: VERSION, add })).toThrow(LookVendorError)
    expect(() => vendorLook(dir, { repoRoot, hyperframesVersion: VERSION, add })).toThrow(/canopy-part-title/)
    expect(calls).toEqual([])
  })

  it('removes items no longer listed', () => {
    const { dir } = lookWith(['grain-overlay'])
    const { add } = fakeAdd({ 'grain-overlay': { 'grain-overlay.html': GRAIN } })
    vendorLook(dir, { repoRoot, hyperframesVersion: VERSION, add })
    const look = JSON.parse(readFileSync(join(dir, 'look.json'), 'utf8'))
    writeFileSync(join(dir, 'look.json'), JSON.stringify({ ...look, registry: [] }))
    expect(vendorLook(dir, { repoRoot, hyperframesVersion: VERSION, add })).toEqual([
      '~ registry/registry.lock.json',
      '- registry/grain-overlay/grain-overlay.html',
    ])
  })
})
