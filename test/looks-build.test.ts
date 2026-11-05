// The looks build step (plan 2026-11-04-looks §4.8): checks every look, packs looks-build/<id>.tar.gz, writes the
// catalog module and copies content-hashed previews; a broken look fails the build. The committed catalog matches
// looks/ (CI typechecks and tests without a build).
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildLooks,
  copyLookPreviews,
  LookBuildError,
  looksModule,
  writeLooksModule,
} from '../scripts/lib/looks.js'

const repo = new URL('..', import.meta.url).pathname
const VERSION = '0.8.222'
const webp = () =>
  Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(20)])

/** A repo root with looks/_template plus complete looks made from it. */
function root(ids: string[]) {
  const r = mkdtempSync(join(tmpdir(), 'looks-root-'))
  cpSync(join(repo, 'looks', '_template'), join(r, 'looks', '_template'), { recursive: true })
  for (const id of ids) {
    const dir = join(r, 'looks', id)
    cpSync(join(repo, 'looks', '_template'), dir, { recursive: true })
    const look = JSON.parse(readFileSync(join(dir, 'look.json'), 'utf8'))
    writeFileSync(join(dir, 'look.json'), JSON.stringify({ ...look, id, name: id }))
    writeFileSync(join(dir, 'preview.mp4'), readFileSync(join(repo, 'test', 'fixtures', 'a169.mp4')))
    writeFileSync(join(dir, 'poster.webp'), webp())
  }
  return r
}

describe('looks build', () => {
  it('catalogues every look but the template, clean first, and packs stable archives', () => {
    const r = root(['kinetic', 'clean', 'terminal'])
    const entries = buildLooks({ repoRoot: r, hyperframesVersion: VERSION, writeArchives: true })
    expect(entries.map((e) => e.id)).toEqual(['clean', 'kinetic', 'terminal'])
    expect(readdirSync(join(r, 'looks-build')).sort()).toEqual([
      'clean.tar.gz',
      'kinetic.tar.gz',
      'terminal.tar.gz',
    ])
    const first = readFileSync(join(r, 'looks-build', 'clean.tar.gz'))
    const again = buildLooks({ repoRoot: r, hyperframesVersion: VERSION, writeArchives: true })
    expect(readFileSync(join(r, 'looks-build', 'clean.tar.gz')).equals(first)).toBe(true)
    expect(again).toEqual(entries)
    expect(entries[0]).toMatchObject({
      name: 'clean',
      engines: ['hyperframes'],
      recording: null,
      musicMood: 'calm electronic, 100 bpm',
      source: 'builtin',
      bytes: first.byteLength,
      preview: {
        mp4: expect.stringMatching(/^\/assets\/looks\/clean\.[0-9a-f]{12}\.mp4$/),
        poster: expect.stringMatching(/^\/assets\/looks\/clean\.[0-9a-f]{12}\.webp$/),
      },
    })
  })

  it('writes no archives for looks:gen', () => {
    const r = root(['clean'])
    buildLooks({ repoRoot: r, hyperframesVersion: VERSION, writeArchives: false })
    expect(existsSync(join(r, 'looks-build'))).toBe(false)
  })

  it('fails on a broken look with every look:check line', () => {
    const r = root(['clean', 'kinetic'])
    writeFileSync(join(r, 'looks', 'kinetic', 'LOOK.md'), '# nothing here')
    let err: unknown
    try {
      buildLooks({ repoRoot: r, hyperframesVersion: VERSION, writeArchives: true })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(LookBuildError)
    expect((err as LookBuildError).problems).toContain('look:kinetic: LOOK.md has no "Layout" section')
    expect(existsSync(join(r, 'looks-build'))).toBe(false)
  })

  it('copies previews to their content-hashed paths', () => {
    const r = root(['clean'])
    const entries = buildLooks({ repoRoot: r, hyperframesVersion: VERSION, writeArchives: false })
    const dist = join(r, 'ui', 'dist')
    mkdirSync(dist, { recursive: true })
    expect(copyLookPreviews(r, entries, dist)).toBe(2)
    const mp4 = entries[0]?.preview.mp4 ?? ''
    expect(readFileSync(join(dist, mp4)).equals(readFileSync(join(r, 'looks', 'clean', 'preview.mp4')))).toBe(
      true,
    )
  })

  it('notices a stale catalog module until it is regenerated', () => {
    const r = root(['clean'])
    const gen = () =>
      looksModule(buildLooks({ repoRoot: r, hyperframesVersion: VERSION, writeArchives: false }))
    writeLooksModule(r, buildLooks({ repoRoot: r, hyperframesVersion: VERSION, writeArchives: false }))
    const committed = () => readFileSync(join(r, 'src', 'generated', 'looks.ts'), 'utf8')
    expect(committed()).toBe(gen())
    writeFileSync(
      join(r, 'looks', 'clean', 'LOOK.md'),
      readFileSync(join(r, 'looks', 'clean', 'LOOK.md'), 'utf8') + ' ',
    )
    expect(committed()).not.toBe(gen())
  })
})

describe('the committed catalog', () => {
  // An archive's gzip bytes, so its sha256 and size, differ between CPU architectures (a catalog made on a laptop
  // differs in CI); the deploy's build rewrites the catalog from its own archives anyway. Everything else, the look
  // hash included, must match.
  const portable = (module: string) => module.replace(/^\s*"(sha256|bytes)": .*\n/gm, '')

  it('matches looks/ (run npm run looks:gen after changing a look)', () => {
    const fresh = looksModule(
      buildLooks({ repoRoot: repo, hyperframesVersion: VERSION, writeArchives: false }),
    )
    const committed = readFileSync(join(repo, 'src', 'generated', 'looks.ts'), 'utf8')
    expect(portable(committed), 'run npm run looks:gen').toBe(portable(fresh))
  })
})
