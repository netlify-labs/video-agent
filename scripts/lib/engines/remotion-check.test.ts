// The Remotion engine's check and snapshot (render-engines plan §5.2, §5.4), with a stub renderer (no Remotion in CI)
// and the root's own TypeScript for the scan.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { generateRegistry } from '../../../app/server/lib/remotion-project.js'
import { checkProject, scanSources, snapshotProject, type RemotionApi } from './remotion-check.js'
import { readProject } from './remotion.js'

const repo = join(import.meta.dirname, '..', '..', '..')

/** A project: the template with two beats, a layer and their components, at the root's video/. */
function project() {
  const root = mkdtempSync(join(tmpdir(), 'va-rcheck-'))
  const video = join(root, 'video')
  cpSync(join(repo, 'app', 'engines', 'remotion'), video, {
    recursive: true,
    filter: (src) => !src.includes('node_modules'),
  })
  const props = JSON.parse(readFileSync(join(video, 'props.json'), 'utf8')) as {
    beats: { id: string; duration: number; texts: Record<string, unknown>; media: Record<string, unknown> }[]
    layers: { id: string; label: string | null }[]
  }
  props.beats.push({
    ...props.beats[0],
    id: 'demo',
    duration: 2,
    authoredDuration: 2,
    texts: { 'demo-sub': { text: 'One place', label: null } },
    media: { logo: { kind: 'image', src: 'assets/media/logo.svg', fit: 'contain', label: null } },
  } as never)
  props.layers.push({ id: 'glow', label: null })
  writeFileSync(join(video, 'props.json'), JSON.stringify(props, null, 2))
  writeFileSync(
    join(video, 'src', 'beats', 'demo.tsx'),
    `import { VaImage } from '../va/Media'\nimport { VaText } from '../va/Text'\nexport default function Demo() {\n  return <div><VaImage slot="logo" /><VaText id="demo-sub" /></div>\n}\n`,
  )
  writeFileSync(
    join(video, 'src', 'layers', 'glow.tsx'),
    'export default function Glow() {\n  return <div />\n}\n',
  )
  writeFileSync(join(video, 'src', 'registry.ts'), generateRegistry(props))
  return { root, video, props }
}

/** A renderer that records what it's asked and writes the files a real one would. */
function stubRemotion(over: Partial<{ fps: number }> = {}) {
  const calls = { bundle: 0, stills: [] as Record<string, unknown>[], browsers: 0 }
  const browser = { close: () => Promise.resolve() }
  let total = 0
  const api: RemotionApi = {
    bundle: (o) => {
      calls.bundle++
      mkdirSync(o.outDir, { recursive: true })
      writeFileSync(join(o.outDir, 'index.html'), '<html></html>')
      return Promise.resolve(o.outDir)
    },
    openBrowser: () => {
      calls.browsers++
      return Promise.resolve(browser)
    },
    selectComposition: () =>
      Promise.resolve({ width: 1920, height: 1080, fps: over.fps ?? 30, durationInFrames: total }),
    renderStill: (o) => {
      calls.stills.push(o)
      writeFileSync(o.output as string, 'PNG')
      return Promise.resolve()
    },
    renderMedia: () => Promise.resolve(),
  }
  return {
    api,
    calls,
    browser,
    setTotal: (n: number) => {
      total = n
    },
  }
}

function deps(root: string, remotion: RemotionApi, extra: Partial<Parameters<typeof checkProject>[0]> = {}) {
  const logs: Record<string, unknown>[] = []
  return {
    logs,
    d: {
      root,
      remotion: () => remotion,
      ts: () => ts,
      run: () => Promise.resolve(''),
      log: (step: string, f: Record<string, unknown> = {}) => logs.push({ step, ...f }),
      readProject,
      ...extra,
    },
  }
}

describe('Remotion check', () => {
  it('passes a valid project, rendering the smoke stills on one browser with the license key', async () => {
    const { root, video } = project()
    const r = stubRemotion()
    r.setTotal(150)
    const { d, logs } = deps(root, r.api)
    expect(await checkProject(d, video)).toEqual({ errors: [], warnings: [] })
    // The first frame, both beat midpoints, the last frame.
    expect(r.calls.stills.map((s) => s.frame)).toEqual([0, 45, 120, 149])
    expect(r.calls.browsers).toBe(1)
    expect(new Set(r.calls.stills.map((s) => s.puppeteerInstance))).toEqual(new Set([r.browser]))
    expect(new Set(r.calls.stills.map((s) => s.serveUrl)).size).toBe(1)
    expect(r.calls.stills.every((s) => s.licenseKey === 'free-license' && !('isProduction' in s))).toBe(true)
    expect(JSON.parse(readFileSync(join(video, '.render', 'renders.json'), 'utf8'))).toEqual({
      video: 0,
      stills: 4,
      audio: 0,
    })
    expect(logs.filter((l) => l.step === 'engine.check.rule').map((l) => [l.rule, l.ok])).toEqual([
      ['props', true],
      ['registry', true],
      ['scan', true],
      ['files', true],
      ['tsc', true],
      ['composition', true],
    ])
  })

  it('rewrites a stale registry, and the check then passes', async () => {
    const { root, video } = project()
    writeFileSync(join(video, 'src', 'registry.ts'), '// stale')
    const r = stubRemotion()
    r.setTotal(150)
    expect((await checkProject(deps(root, r.api).d, video)).errors).toEqual([])
    expect(readFileSync(join(video, 'src', 'registry.ts'), 'utf8')).toContain("'demo': BeatDemo")
  })

  it('a composition that disagrees with props.json is an error', async () => {
    const { root, video } = project()
    const r = stubRemotion({ fps: 25 })
    r.setTotal(150)
    const { errors } = await checkProject(deps(root, r.api).d, video)
    expect(errors).toEqual([
      'The composition is {"width":1920,"height":1080,"fps":25,"durationInFrames":150}, but props.json says {"width":1920,"height":1080,"fps":30,"durationInFrames":150}.',
    ])
  })

  it('a tsc failure is an error, and nothing renders', async () => {
    const { root, video } = project()
    const r = stubRemotion()
    const { errors } = await checkProject(
      deps(root, r.api, {
        run: () => Promise.reject(new Error("src/beats/demo.tsx(3,9): error TS2304: Cannot find name 'x'.")),
      }).d,
      video,
    )
    expect(errors[0]).toMatch(/^tsc: .*TS2304/)
    expect(r.calls.stills).toEqual([])
  })

  it('bundles once per source: a second check and a snapshot reuse it', async () => {
    const { root, video } = project()
    const r = stubRemotion()
    r.setTotal(150)
    const { d } = deps(root, r.api)
    await checkProject(d, video)
    await checkProject(d, video)
    const shots = await snapshotProject(d, video, [0.5, 2, 4.25])
    expect(r.calls.bundle).toBe(1)
    expect(shots.map((s) => s.split('/').pop())).toEqual(['0.5.png', '2.png', '4.25.png'])
    expect(shots.every((s) => existsSync(s))).toBe(true)
    expect(r.calls.stills.slice(-3).map((s) => s.frame)).toEqual([15, 60, 128])
    expect(JSON.parse(readFileSync(join(video, '.render', 'renders.json'), 'utf8')).stills).toBe(11)
  })
})

describe('the static scan', () => {
  const scan = (demo: string, extra: Record<string, string> = {}) => {
    const { video, props } = project()
    writeFileSync(join(video, 'src', 'beats', 'demo.tsx'), demo)
    for (const [p, body] of Object.entries(extra)) writeFileSync(join(video, p), body)
    return scanSources(ts, readProject(video), props as never)
  }
  const ok = `import { VaImage } from '../va/Media'\nimport { VaText } from '../va/Text'\nexport default () => <div><VaImage slot="logo" /><VaText id="demo-sub" /></div>\n`

  it('passes the valid beat', () => {
    expect(scan(ok)).toEqual([])
  })

  it.each([
    [
      'a non-literal id',
      `const x = 'demo-sub'\nexport default () => <div><VaImage slot="logo" /><VaText id={x} /></div>\n`,
      [
        'src/beats/demo.tsx:2: <VaText id> must be a plain string, like id="intro-title".',
        'props.json: the text "demo-sub" of beat "demo" isn\'t shown; use it once in src/beats/demo.tsx.',
      ],
    ],
    [
      'an id not in props',
      `export default () => <div><VaImage slot="logo" /><VaText id="demo-sub" /><VaText id="nope" /></div>\n`,
      [`src/beats/demo.tsx:1: there's no text "nope" in beat "demo"'s props.`],
    ],
    [
      'a text used twice',
      `export default () => <div><VaImage slot="logo" /><VaText id="demo-sub" /><VaText id={'demo-sub'} /></div>\n`,
      ['props.json: the text "demo-sub" of beat "demo" is shown 2 times; show it once.'],
    ],
    [
      'a clip tag on an image slot',
      `export default () => <div><VaClip slot="logo" /><VaText id="demo-sub" /></div>\n`,
      ['src/beats/demo.tsx:1: slot "logo" holds image media; use <VaImage>.'],
    ],
    [
      'a Google Fonts import',
      `import { loadFont } from '@remotion/google-fonts/Inter'\n${ok}`,
      [
        'src/beats/demo.tsx:1: Google Fonts load from the web; use a font file in assets/fonts with loadFont.',
      ],
    ],
    [
      'an https URL',
      `const bg = 'https://example.com/bg.png'\n${ok}`,
      ['src/beats/demo.tsx:1: the video can\'t load anything from a URL ("https://example.com/bg.png").'],
    ],
    [
      'process.env',
      `const k = process.env.SECRET\n${ok}`,
      ["src/beats/demo.tsx:1: compositions can't read process.env."],
    ],
  ])('refuses %s', (_name, demo, want) => {
    expect(scan(demo)).toEqual(want)
  })

  it('scans layers for the forbidden patterns too, and keeps va texts out of them', () => {
    expect(
      scan(ok, {
        'src/layers/glow.tsx': `import { VaText } from '../va/Text'\nexport default () => <div style={{ background: 'url(http://x)' }}><VaText id="demo-sub" /></div>\n`,
      }),
    ).toEqual([
      'src/layers/glow.tsx:2: the video can\'t load anything from a URL ("url(http://x)").',
      'src/layers/glow.tsx:2: <VaText> is only for beats (src/beats/<id>.tsx with an entry in props.json).',
    ])
  })
})
