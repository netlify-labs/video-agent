// look:check --static and look:new (plan 2026-11-04-looks §8, §9): a good look passes; each rule fails on a copy of
// it broken in exactly one way, with the exact `look:<id>: …` line; look:new makes a look that passes but for previews.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { runLookCheck } from '../scripts/look-check.js'
import { newLook, LookNewError } from '../scripts/look-new.js'

const repo = new URL('..', import.meta.url).pathname
const fixture = (p: string) => readFileSync(join(repo, 'test', 'fixtures', p))
const VERSION = '0.8.222'
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')

/** A 2×2 PNG header: enough for the sniffer, which reads the signature and IHDR. */
const png = () => {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(2, 16)
  b.writeUInt32BE(2, 20)
  return b
}
const webp = () =>
  Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(20)])

/** A WOFF2 header the sniffer accepts: signature, the length field equal to the size, one table. */
const woff2 = (size = 64) => {
  const b = Buffer.alloc(size)
  b.write('wOF2', 0, 'ascii')
  b.writeUInt32BE(size, 8)
  b.writeUInt16BE(1, 12)
  return b
}

/** Adds a hand font to the look: the file, its credits line and look.json's fonts entry. */
function addFont(d: string, bytes: Buffer = woff2(), listed = true) {
  mkdirSync(join(d, 'assets', 'fonts'), { recursive: true })
  writeFileSync(join(d, 'assets', 'fonts', 'marker.woff2'), bytes)
  edit(join(d, 'assets', 'credits.json'), (s) =>
    JSON.stringify([...JSON.parse(s), { file: 'fonts/marker.woff2', license: 'OFL-1.1' }]),
  )
  if (listed)
    edit(join(d, 'look.json'), (s) =>
      JSON.stringify({
        ...JSON.parse(s),
        fonts: [
          {
            role: 'hand',
            file: 'assets/fonts/marker.woff2',
            license: 'OFL-1.1',
            useWhen: 'handwritten notes',
          },
        ],
      }),
    )
}

const COMPONENT = '<div class="bul">letters</div>\n'

/** A copy of looks/_template as a complete look called `good`, with previews, an asset and one vendored item. */
function goodLook(): { looksDir: string; dir: string } {
  const looksDir = mkdtempSync(join(tmpdir(), 'looks-'))
  const dir = join(looksDir, 'good')
  cpSync(join(repo, 'looks', '_template'), dir, { recursive: true })
  const look = JSON.parse(readFileSync(join(dir, 'look.json'), 'utf8'))
  writeFileSync(
    join(dir, 'look.json'),
    JSON.stringify({ ...look, id: 'good', registry: ['bottom-up-letters'] }),
  )
  writeFileSync(join(dir, 'preview.mp4'), fixture('a169.mp4'))
  writeFileSync(join(dir, 'poster.webp'), webp())
  writeFileSync(join(dir, 'assets', 'grain.png'), png())
  writeFileSync(join(dir, 'assets', 'whoosh.mp3'), fixture('audio/tone.mp3'))
  writeFileSync(
    join(dir, 'assets', 'credits.json'),
    JSON.stringify([
      { file: 'grain.png', license: 'own-work' },
      { file: 'whoosh.mp3', license: 'CC-BY-4.0', credit: 'Tone by Example' },
    ]),
  )
  mkdirSync(join(dir, 'registry', 'bottom-up-letters'))
  writeFileSync(join(dir, 'registry', 'bottom-up-letters', 'bottom-up-letters.html'), COMPONENT)
  writeLock(dir, `v${VERSION}`, sha(COMPONENT))
  return { looksDir, dir }
}

function writeLock(dir: string, tag: string, fileSha: string) {
  writeFileSync(
    join(dir, 'registry', 'registry.lock.json'),
    JSON.stringify({
      tag,
      items: [
        {
          name: 'bottom-up-letters',
          type: 'component',
          upstream: 'registry/components/bottom-up-letters',
          license: 'Apache-2.0',
          author: 'HyperFrames contributors (HeyGen)',
          files: [{ path: 'bottom-up-letters.html', sha256: fileSha }],
        },
      ],
    }),
  )
}

const check = (looksDir: string, ids = ['good']) => runLookCheck(looksDir, ids, VERSION).problems
const edit = (path: string, f: (s: string) => string) => writeFileSync(path, f(readFileSync(path, 'utf8')))

/** The one problem a single break produces. */
function broken(breakIt: (dir: string) => void): string[] {
  const { looksDir, dir } = goodLook()
  breakIt(dir)
  return check(looksDir)
}

describe('look:check --static', () => {
  it('passes a good look and the template', () => {
    const { looksDir } = goodLook()
    expect(check(looksDir)).toEqual([])
    expect(runLookCheck(join(repo, 'looks'), ['_template'], VERSION).problems).toEqual([])
  })

  it('reports a missing LOOK.md section', () => {
    expect(broken((d) => edit(join(d, 'LOOK.md'), (s) => s.replace('## Pacing', '## Speed')))).toEqual([
      'look:good: LOOK.md has no "Pacing" section',
    ])
  })

  it('reports an oversized LOOK.md and example', () => {
    expect(broken((d) => edit(join(d, 'LOOK.md'), (s) => s + 'x'.repeat(12 * 1024)))).toEqual([
      'look:good: LOOK.md is 14 KB, over 12 KB',
    ])
    expect(
      broken((d) =>
        edit(join(d, 'example', 'index.html'), (s) =>
          s.replace('</style>', `/*${'x'.repeat(24 * 1024)}*/</style>`),
        ),
      ),
    ).toEqual(['look:good: example/index.html is 28 KB, over 24 KB'])
  })

  it('reports assets/ over 1 MB', () => {
    const problems = broken((d) => {
      for (const n of [1, 2, 3])
        writeFileSync(join(d, 'assets', `big${n}.wav`), fixture('narration/near-clip.wav'))
      edit(join(d, 'assets', 'credits.json'), (s) =>
        JSON.stringify([
          ...JSON.parse(s),
          ...[1, 2, 3].map((n) => ({ file: `big${n}.wav`, license: 'CC0-1.0' })),
        ]),
      )
    })
    expect(problems).toEqual(['look:good: assets/ is 1286 KB, over 1024 KB'])
  })

  it('reports bad and missing credits', () => {
    expect(
      broken((d) =>
        edit(join(d, 'assets', 'credits.json'), (s) => s.replace('"own-work"', '"all rights reserved"')),
      ),
    ).toEqual([expect.stringMatching(/^look:good: assets\/credits\.json 0\.license: /)])
    expect(
      broken((d) =>
        edit(join(d, 'assets', 'credits.json'), (s) => s.replace(',"credit":"Tone by Example"', '')),
      ),
    ).toEqual(['look:good: assets/credits.json 1.credit: CC BY needs a credit'])
    expect(broken((d) => writeFileSync(join(d, 'assets', 'extra.png'), png()))).toEqual([
      "look:good: assets/extra.png isn't listed in assets/credits.json",
    ])
  })

  it("reports files that aren't what their extension says", () => {
    expect(broken((d) => writeFileSync(join(d, 'assets', 'grain.png'), 'not a png'))).toEqual([
      "look:good: assets/grain.png isn't a real PNG file",
    ])
    expect(broken((d) => writeFileSync(join(d, 'assets', 'grain.png'), fixture('poster.jpg')))).toEqual([
      "look:good: assets/grain.png isn't a real PNG file",
    ])
    const wav = broken((d) => {
      writeFileSync(join(d, 'assets', 'whoosh.wav'), fixture('audio/tone.mp3'))
      edit(join(d, 'assets', 'credits.json'), (s) =>
        JSON.stringify([...JSON.parse(s), { file: 'whoosh.wav', license: 'CC0-1.0' }]),
      )
    })
    expect(wav).toEqual(["look:good: assets/whoosh.wav isn't a real WAV file"])
    expect(broken((d) => writeFileSync(join(d, 'preview.mp4'), webp()))).toEqual([
      "look:good: preview.mp4 isn't a real MP4 file",
    ])
    expect(broken((d) => writeFileSync(join(d, 'assets', 'notes.txt'), 'x'))).toEqual([
      "look:good: assets/notes.txt: .txt isn't allowed in a look",
      "look:good: assets/notes.txt isn't listed in assets/credits.json",
    ])
  })

  it('accepts a real WOFF2 font look.json lists, and refuses fake, unlisted, missing and oversized ones', () => {
    expect(broken((d) => addFont(d))).toEqual([])
    expect(broken((d) => addFont(d, Buffer.from('not a font')))).toEqual([
      "look:good: assets/fonts/marker.woff2 isn't a real WOFF2 file",
    ])
    const truncated = woff2()
    truncated.writeUInt32BE(999, 8)
    expect(broken((d) => addFont(d, truncated))).toEqual([
      "look:good: assets/fonts/marker.woff2 isn't a real WOFF2 file",
    ])
    expect(broken((d) => addFont(d, woff2(), false))).toEqual([
      'look:good: assets/fonts/marker.woff2: a font must be listed in look.json fonts (with its role and licence)',
    ])
    expect(
      broken((d) =>
        edit(join(d, 'look.json'), (s) =>
          JSON.stringify({
            ...JSON.parse(s),
            fonts: [{ role: 'hand', file: 'assets/fonts/gone.woff2', license: 'OFL-1.1', useWhen: 'notes' }],
          }),
        ),
      ),
    ).toEqual(["look:good: look.json fonts lists assets/fonts/gone.woff2, which doesn't exist"])
    const big = broken((d) => addFont(d, woff2(1024 * 1024 + 1)))
    expect(
      big.some((x) => x.startsWith('look:good: assets/fonts/marker.woff2 is') && x.endsWith('for one file')),
    ).toBe(true)
    expect(big.some((x) => x.includes('assets/ is'))).toBe(true)
    expect(
      broken((d) =>
        edit(join(d, 'look.json'), (s) =>
          JSON.stringify({
            ...JSON.parse(s),
            fonts: [{ role: 'hand', file: 'fonts/marker.ttf', license: 'proprietary', useWhen: 'notes' }],
          }),
        ),
      ),
    ).toEqual([
      'look:good: look.json fonts.0.file: assets/fonts/<name>.woff2',
      expect.stringContaining('look:good: look.json fonts.0.license'),
    ])
  })

  it("refers to the look's own assets as assets/look/, which must exist", () => {
    const font = (url: string) => (d: string) => {
      addFont(d)
      edit(join(d, 'example', 'index.html'), (s) =>
        s.replace('</style>', `@font-face { font-family: Hand; src: url('${url}'); }</style>`),
      )
    }
    expect(broken(font('assets/look/fonts/marker.woff2'))).toEqual([])
    expect(broken(font('assets/look/fonts/gone.woff2'))).toEqual([
      "look:good: example/index.html refers to assets/look/fonts/gone.woff2, which isn't in the look's assets/",
    ])
    expect(broken(font('../assets/fonts/marker.woff2'))).toEqual([
      'look:good: example/index.html refers to a file outside example/ (../)',
    ])
  })

  it('refuses SVGs with scripts or handlers', () => {
    const svg = (body: string) =>
      broken((d) => {
        writeFileSync(
          join(d, 'assets', 'mark.svg'),
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`,
        )
        edit(join(d, 'assets', 'credits.json'), (s) =>
          JSON.stringify([...JSON.parse(s), { file: 'mark.svg', license: 'own-work' }]),
        )
      })
    expect(svg('<circle cx="5" cy="5" r="4" fill="red"/>')).toEqual([])
    const bad =
      'look:good: assets/mark.svg has scripts, event handlers or outside links (the SVG sanitizer would remove them)'
    expect(svg('<script>alert(1)</script>')).toEqual([bad])
    expect(svg('<circle cx="5" cy="5" r="4" onload="alert(1)"/>')).toEqual([bad])
  })

  it("reports a color-mix or var() colour role, and roles look.json doesn't list", () => {
    expect(
      broken((d) =>
        edit(join(d, 'example', 'index.html'), (s) =>
          s.replace(
            '--va-color-accent: #14b8a6;',
            '--va-color-accent: color-mix(in srgb, #14b8a6, white 40%);',
          ),
        ),
      ),
    ).toEqual([
      'look:good: example sets --va-color-accent to color-mix(in srgb, #14b8a6, white 40%); write colour roles as literal colours',
    ])
    expect(
      broken((d) =>
        edit(join(d, 'example', 'index.html'), (s) =>
          s.replace('--va-color-accent: #14b8a6;', '--va-color-accent: #14b8a6; --va-color-glow: #ffb38a;'),
        ),
      ),
    ).toEqual(["look:good: example uses --va-color-glow, which look.json colors doesn't list"])
  })

  it('reports an example that breaks the contract, or has text without data-va-text', () => {
    expect(
      broken((d) => edit(join(d, 'example', 'index.html'), (s) => s.replace(' data-va-contract="1"', ''))),
    ).toContain('look:good: example breaks the editing contract: The root needs data-va-contract="1".')
    expect(
      broken((d) =>
        edit(join(d, 'example', 'index.html'), (s) =>
          s.replace(
            '<div>\n          <div class="kicker" data-va-text="intro-kicker">',
            '<div>Loose words\n          <div class="kicker" data-va-text="intro-kicker">',
          ),
        ),
      ),
    ).toEqual(['look:good: example text "Loose words" has no data-va-text'])
  })

  it('reports outside URLs, Date.now and Math.random in the example', () => {
    expect(
      broken((d) =>
        edit(join(d, 'example', 'index.html'), (s) =>
          s.replace('<script src="vendor/gsap.min.js">', '<script src="https://cdn.example.com/gsap.js">'),
        ),
      ),
    ).toEqual([
      'look:good: example/index.html links outside the look (https://cdn.example.com); use files inside example/',
    ])
    expect(
      broken((d) =>
        edit(join(d, 'example', 'index.html'), (s) =>
          s.replace("ease: 'power2.out' }, 0.3)", "ease: 'power2.out' }, Math.random())"),
        ),
      ),
    ).toEqual(['look:good: example/index.html uses Math.random(); renders must be deterministic'])
    expect(
      broken((d) =>
        edit(join(d, 'example', 'index.html'), (s) =>
          s.replace("ease: 'power2.out' }, 0.3)", "ease: 'power2.out' }, Date.now())"),
        ),
      ),
    ).toEqual(['look:good: example/index.html uses Date.now(); renders must be deterministic'])
  })

  it('checks the registry lock: tag, sha256 and the item list', () => {
    expect(broken((d) => writeLock(d, 'v0.8.200', sha(COMPONENT)))).toEqual([
      'look:good: registry/registry.lock.json tag is v0.8.200, not v0.8.222 (the pinned HyperFrames); run npm run look:vendor',
    ])
    expect(
      broken((d) =>
        writeFileSync(join(d, 'registry', 'bottom-up-letters', 'bottom-up-letters.html'), 'changed'),
      ),
    ).toEqual([
      "look:good: registry/bottom-up-letters/bottom-up-letters.html doesn't match its sha256 in registry/registry.lock.json; run npm run look:vendor",
    ])
    expect(
      broken((d) => edit(join(d, 'look.json'), (s) => s.replace('"bottom-up-letters"', '"blur-in"'))),
    ).toEqual([
      "look:good: look.json registry [blur-in] doesn't match registry/registry.lock.json [bottom-up-letters]",
    ])
  })

  it('reports unknown look.json keys and a folder mismatch', () => {
    expect(broken((d) => edit(join(d, 'look.json'), (s) => s.replace('{', '{"pace":"fast",')))).toEqual([
      expect.stringMatching(/^look:good: look\.json \(root\): .*pace/),
    ])
    expect(
      broken((d) => edit(join(d, 'look.json'), (s) => s.replace('"id":"good"', '"id":"other"'))),
    ).toEqual(['look:good: look.json id "other" doesn\'t match the folder "good"'])
  })

  it('refuses symlinks and dotfiles', () => {
    expect(broken((d) => symlinkSync('/etc/hosts', join(d, 'assets', 'hosts.md')))).toEqual([
      "look:good: assets/hosts.md: symlinks aren't allowed in a look",
    ])
    expect(broken((d) => writeFileSync(join(d, 'example', '.DS_Store'), 'x'))).toEqual([
      "look:good: example/.DS_Store: dotfiles aren't allowed in a look",
    ])
  })

  it('needs previews on a look but not on the template', () => {
    expect(broken((d) => rmSync(join(d, 'poster.webp')))).toEqual([
      'look:good: poster.webp is missing (see looks/README.md for the preview commands)',
    ])
  })

  it('reports a look id with no folder', () => {
    const { looksDir } = goodLook()
    expect(check(looksDir, ['nope'])).toEqual(["look:nope: there's no folder looks/nope"])
  })
})

describe('look:new', () => {
  const looksDir = () => {
    const d = mkdtempSync(join(tmpdir(), 'looks-'))
    cpSync(join(repo, 'looks', '_template'), join(d, '_template'), { recursive: true })
    return d
  }

  it('makes a look that passes the static check but for its previews', () => {
    const d = looksDir()
    const dir = newLook(d, 'retro-crt', '2026-11-05')
    const look = JSON.parse(readFileSync(join(dir, 'look.json'), 'utf8'))
    expect(look).toMatchObject({ id: 'retro-crt', name: 'Retro crt', since: '2026-11-05' })
    expect(check(d, ['retro-crt'])).toEqual([
      'look:retro-crt: preview.mp4 is missing (see looks/README.md for the preview commands)',
      'look:retro-crt: poster.webp is missing (see looks/README.md for the preview commands)',
    ])
  })

  it('refuses bad ids and existing folders', () => {
    const d = looksDir()
    for (const id of ['', 'Retro', '_x', 'a/b', '..'])
      expect(() => newLook(d, id, '2026-11-05')).toThrow(LookNewError)
    newLook(d, 'kinetic', '2026-11-05')
    expect(() => newLook(d, 'kinetic', '2026-11-05')).toThrow('looks/kinetic already exists.')
  })
})
