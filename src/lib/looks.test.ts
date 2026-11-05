// The look format (plan 2026-11-04-looks §4.1–§4.3): look.json's schema and bounds, the file list a run gets, the
// look hash and the deterministic look/ archive, and writeTarGz's prefix option leaving remix archives unchanged.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  buildLookArchive,
  LookJsonSchema,
  lookFiles,
  lookHash,
  lookJsonProblems,
  lookRunFiles,
  readLookRunFiles,
  REQUIRED_LOOK_SECTIONS,
} from './looks.js'
import { readTarGz, TarError, writeTarGz } from './tar.js'

const enc = (s: string) => new TextEncoder().encode(s)
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

const valid = () => ({
  id: 'kinetic',
  name: 'Kinetic type',
  description: 'Big words that move with the beat. Type is the picture.',
  tags: ['type', 'social', 'energetic'],
  bestFor: ['social', 'launch'],
  aspects: ['16:9', '9:16', '1:1', '4:5'],
  engines: ['hyperframes'],
  colors: { roles: ['bg', 'text', 'accent'], derived: ['glow'] },
  sound: { musicMood: 'punchy electronic, 120 bpm' },
  recording: {
    frame: 'wallpaper',
    padding: 0.06,
    radius: 14,
    shadow: 'lg',
    wallpaper: 'gradient',
    cursor: { shape: 'arrow', scale: 1.3, color: 'text' },
    ripple: 'ring',
    callout: 'pill',
    zoomMax: 2.2,
  },
  registry: ['bottom-up-letters', 'beat-freeze-cut'],
  authors: ['Video Agent maintainers'],
  license: 'MIT',
  since: '2026-11-04',
})

const ok = (v: unknown) => LookJsonSchema.safeParse(v).success

describe('look.json schema', () => {
  it('accepts the plan example, recording: false and no recording', () => {
    expect(lookJsonProblems(valid(), 'kinetic')).toEqual([])
    expect(ok({ ...valid(), recording: false })).toBe(true)
    const bare: Record<string, unknown> = valid()
    delete bare.recording
    delete bare.sound
    expect(ok(bare)).toBe(true)
  })

  it('refuses unknown keys, including the fields draft 3 dropped', () => {
    expect(ok({ ...valid(), pace: 'fast' })).toBe(false)
    expect(ok({ ...valid(), fonts: [] })).toBe(false)
    expect(ok({ ...valid(), sound: { musicMood: 'x', sfx: 'whoosh' } })).toBe(false)
    expect(ok({ ...valid(), recording: { ...valid().recording, extra: 1 } })).toBe(false)
    expect(ok({ ...valid(), colors: { roles: ['bg'], derived: [], hex: '#fff' } })).toBe(false)
  })

  it('bounds the id', () => {
    expect(ok({ ...valid(), id: 'a'.repeat(40) })).toBe(true)
    expect(ok({ ...valid(), id: 'a'.repeat(41) })).toBe(false)
    for (const id of ['', '-a', 'Kinetic', 'a_b', 'a/b', '..']) expect(ok({ ...valid(), id })).toBe(false)
  })

  it('bounds the strings', () => {
    expect(ok({ ...valid(), name: 'n'.repeat(40) })).toBe(true)
    expect(ok({ ...valid(), name: 'n'.repeat(41) })).toBe(false)
    expect(ok({ ...valid(), name: '' })).toBe(false)
    expect(ok({ ...valid(), description: 'd'.repeat(160) })).toBe(true)
    expect(ok({ ...valid(), description: 'd'.repeat(161) })).toBe(false)
    expect(ok({ ...valid(), sound: { musicMood: 'm'.repeat(120) } })).toBe(true)
    expect(ok({ ...valid(), sound: { musicMood: 'm'.repeat(121) } })).toBe(false)
    expect(ok({ ...valid(), since: '4 Nov 2026' })).toBe(false)
    expect(ok({ ...valid(), license: '' })).toBe(false)
    expect(ok({ ...valid(), authors: [] })).toBe(false)
  })

  it('bounds the tags', () => {
    expect(ok({ ...valid(), tags: Array.from({ length: 8 }, (_, i) => `t${i}`) })).toBe(true)
    expect(ok({ ...valid(), tags: Array.from({ length: 9 }, (_, i) => `t${i}`) })).toBe(false)
    expect(ok({ ...valid(), tags: ['t'.repeat(20)] })).toBe(true)
    expect(ok({ ...valid(), tags: ['t'.repeat(21)] })).toBe(false)
    expect(ok({ ...valid(), tags: ['Type'] })).toBe(false)
  })

  it('takes bestFor, aspects and engines from their lists', () => {
    expect(ok({ ...valid(), bestFor: [] })).toBe(true)
    expect(ok({ ...valid(), bestFor: ['webinar'] })).toBe(false)
    expect(ok({ ...valid(), aspects: ['16:9'] })).toBe(true)
    expect(ok({ ...valid(), aspects: [] })).toBe(false)
    expect(ok({ ...valid(), aspects: ['21:9'] })).toBe(false)
    expect(ok({ ...valid(), engines: [] })).toBe(false)
    expect(ok({ ...valid(), engines: ['remotion', 'hyperframes'] })).toBe(true)
    expect(ok({ ...valid(), engines: ['blender'] })).toBe(false)
  })

  it('takes colour role names, not values', () => {
    expect(ok({ ...valid(), colors: { roles: [], derived: [] } })).toBe(false)
    expect(ok({ ...valid(), colors: { roles: ['#ff0000'], derived: [] } })).toBe(false)
    expect(ok({ ...valid(), colors: { roles: ['bg'], derived: ['Glow'] } })).toBe(false)
  })

  it('bounds the recording block', () => {
    const rec = (r: object) => ok({ ...valid(), recording: { ...valid().recording, ...r } })
    expect(rec({ frame: 'device' })).toBe(true)
    expect(rec({ frame: 'phone' })).toBe(false)
    expect(rec({ padding: 0.31 })).toBe(false)
    expect(rec({ zoomMax: 0.5 })).toBe(false)
    expect(rec({ zoomMax: 5 })).toBe(false)
    expect(rec({ shadow: 'huge' })).toBe(false)
    expect(rec({ cursor: { color: '#fff' } })).toBe(false)
    expect(ok({ ...valid(), recording: true })).toBe(false)
    expect(ok({ ...valid(), recording: { padding: 0.1 } })).toBe(false)
  })

  it('reports the folder mismatch and duplicates', () => {
    expect(lookJsonProblems(valid(), 'terminal')).toEqual([
      'look.json id "kinetic" doesn\'t match the folder "terminal"',
    ])
    expect(lookJsonProblems({ ...valid(), aspects: ['16:9', '16:9'] }, 'kinetic')).toEqual([
      'look.json aspects: "16:9" is listed twice',
    ])
    expect(lookJsonProblems({ ...valid(), name: '' }, 'kinetic')[0]).toMatch(/^look\.json name: /)
  })

  it('lists the twelve required LOOK.md sections', () => {
    expect(REQUIRED_LOOK_SECTIONS).toHaveLength(12)
  })
})

function lookDir(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'look-'))
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true })
    writeFileSync(join(dir, p), body)
  }
  return dir
}

const sample = {
  'look.json': '{}',
  'LOOK.md': '# Kinetic',
  'example/index.html': '<html></html>',
  'example/summary.json': '{}',
  'registry/bottom-up-letters/bottom-up-letters.html': '<div></div>',
  'assets/credits.json': '[]',
  'preview.mp4': 'mp4',
  'poster.webp': 'webp',
}

describe('look files', () => {
  it('lists every file sorted, and run files without the preview and poster', () => {
    const dir = lookDir(sample)
    expect(lookFiles(dir)).toEqual(Object.keys(sample).sort())
    expect(lookRunFiles(dir)).toEqual(
      Object.keys(sample)
        .filter((p) => !p.startsWith('preview') && !p.startsWith('poster'))
        .sort(),
    )
  })

  it('keeps preview-named files inside folders', () => {
    const dir = lookDir({ ...sample, 'example/assets/preview.png': 'png' })
    expect(lookRunFiles(dir)).toContain('example/assets/preview.png')
  })

  it('refuses dotfiles and symlinks', () => {
    expect(() => lookFiles(lookDir({ ...sample, 'example/.DS_Store': 'x' }))).toThrow(/dotfiles/)
    const dir = lookDir(sample)
    symlinkSync('/etc/hosts', join(dir, 'assets', 'hosts.md'))
    expect(() => lookFiles(dir)).toThrow(/symlinks/)
  })
})

describe('look hash and archive', () => {
  const files = () => readLookRunFiles(lookDir(sample))

  it('hashes the same files in another order the same, and changes with one byte', () => {
    const a = files()
    const reversed = new Map([...a].reverse())
    expect(lookHash(reversed)).toBe(lookHash(a))
    const changed = new Map(a)
    changed.set('LOOK.md', enc('# Kinetid'))
    expect(lookHash(changed)).not.toBe(lookHash(a))
    const renamed = new Map(a)
    renamed.delete('LOOK.md')
    renamed.set('LOOK2.md', a.get('LOOK.md')!)
    expect(lookHash(renamed)).not.toBe(lookHash(a))
  })

  it('builds byte-identical archives with every entry under look/', () => {
    const one = buildLookArchive(files())
    const two = buildLookArchive(new Map([...files()].reverse()))
    expect(Buffer.from(one.bytes).equals(Buffer.from(two.bytes))).toBe(true)
    expect(one.sha256).toBe(sha(one.bytes))
    expect(one.bytesLength).toBe(one.bytes.byteLength)
    const tar = Buffer.from(gunzipSync(one.bytes))
    const names: string[] = []
    for (let off = 0; off + 512 <= tar.length;) {
      const h = tar.subarray(off, off + 512)
      if (h.every((x) => x === 0)) break
      names.push(h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, ''))
      const size = parseInt(h.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim(), 8)
      off += 512 + Math.ceil(size / 512) * 512
    }
    expect(names.length).toBeGreaterThan(0)
    for (const n of names) expect(n.startsWith('look/')).toBe(true)
  })

  it('restores to files that hash the same as the folder (the prepare-run check)', () => {
    const a = buildLookArchive(files())
    const restored = readTarGz(a.bytes, undefined, { root: 'look' })
    expect([...restored.keys()].sort()).toEqual([...files().keys()].sort())
    expect(lookHash(restored)).toBe(a.hash)
    expect(() => readTarGz(a.bytes)).toThrow(TarError)
  })
})

describe('writeTarGz prefix', () => {
  const files = new Map<string, Uint8Array>([
    ['index.html', enc('<html></html>')],
    ['summary.json', enc('{}')],
    ['assets/' + 'x'.repeat(120) + '.png', new Uint8Array([1, 2, 3])],
  ])

  it('without a prefix, writes the same tar as before the option existed (remix copies unchanged)', () => {
    // sha256 of the uncompressed tar from writeTarGz before `prefix` was added (gzip bytes vary with zlib).
    expect(sha(gunzipSync(writeTarGz(files)))).toBe(
      '2968a9d85bc837d9cb920d22831e391343766b7b4ce524f7cddea575f21ce710',
    )
    expect(sha(gunzipSync(writeTarGz(files, { prefix: 'video/' })))).toBe(sha(gunzipSync(writeTarGz(files))))
  })

  it('names entries, long ones included, under the prefix', () => {
    const restored = readTarGz(writeTarGz(files, { prefix: 'look/' }), undefined, { root: 'look' })
    expect([...restored.keys()].sort()).toEqual([...files.keys()].sort())
    expect(() => readTarGz(writeTarGz(files, { prefix: 'look/' }))).toThrow(/outside video\//)
  })
})
