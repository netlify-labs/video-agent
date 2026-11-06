// Spike E4, step 1: builds the preview bundle (esbuild of player-entry.tsx into preview/player.js, the page, the
// assets) and renders the same props to an MP4 with renderMedia, with one reference frame per beat midpoint, for the
// seek-accuracy check. Local evaluation only (owner's go-ahead 2026-11-05): development renders, free-license.
//   cd docs/spikes/e4 && npx tsx build.ts && cd ../../.. && npx playwright test -c docs/spikes/e4
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const e3 = join(here, '..', 'e3', 'project')
const work = join(here, '.work')
const preview = join(work, 'preview')
rmSync(work, { recursive: true, force: true })
mkdirSync(preview, { recursive: true })

// E3 makes the stand-in media; run it first if they're missing.
cpSync(join(e3, 'assets'), join(preview, 'assets'), { recursive: true })

const t = Date.now()
execFileSync(join(here, 'node_modules', 'esbuild', 'bin', 'esbuild'), [
  join(here, 'player-entry.tsx'),
  '--bundle',
  '--minify',
  '--format=iife',
  '--target=es2022',
  '--jsx=automatic',
  '--loader:.json=json',
  "--define:process.env.NODE_ENV='production'",
  `--outfile=${join(preview, 'player.js')}`,
  '--log-level=warning',
])
const esbuildMs = Date.now() - t
// The page sets staticFile()'s base to its own capability path, so assets resolve inside the bundle (the CSP's only
// allowed source). An inline script, as 'unsafe-inline' already allows for the HyperFrames runtime.
writeFileSync(
  join(preview, 'index.html'),
  `<!doctype html><html><head><meta charset="utf-8"><style>html,body,#root{margin:0;height:100%;background:#000}</style>
<script>window.remotion_staticBase = location.pathname.replace(/\\/[^/]*$/, '') + '/assets'</script></head>
<body><div id="root"></div><script src="player.js"></script></body></html>\n`,
)
const js = readFileSync(join(preview, 'player.js'))
const sizes = { bytes: statSync(join(preview, 'player.js')).size, gzip: gzipSync(js).byteLength, esbuildMs }

// The reference: the same props rendered by Remotion's renderer, then a frame at each beat's midpoint.
const { bundle } = await import('@remotion/bundler')
const { renderMedia, selectComposition } = await import('@remotion/renderer')
const props = JSON.parse(readFileSync(join(e3, 'props.json'), 'utf8')) as {
  beats: { id: string; duration: number }[]
}
const serveUrl = await bundle({ entryPoint: join(e3, 'src', 'index.ts'), publicDir: join(e3, 'assets') })
const LICENSE = { licenseKey: 'free-license', isProduction: false } as const
const composition = await selectComposition({ serveUrl, id: 'main', ...LICENSE })
const mp4 = join(work, 'reference.mp4')
await renderMedia({ composition, serveUrl, codec: 'h264', outputLocation: mp4, muted: true, ...LICENSE })
let start = 0
const seeks: { beat: string; time: number; frame: string }[] = []
for (const b of props.beats) {
  // The frame the player shows at a seek: whole frames from 0, like the renderer.
  const frame = Math.round((start + b.duration / 2) * 30)
  const file = join(work, `ref-${b.id}.png`)
  execFileSync('ffmpeg', [
    '-loglevel',
    'error',
    '-y',
    '-i',
    mp4,
    '-vf',
    `select=eq(n\\,${frame}),scale=960:540`,
    '-vframes',
    '1',
    file,
  ])
  seeks.push({ beat: b.id, time: frame / 30, frame: file })
  start += b.duration
}
writeFileSync(join(work, 'build.json'), JSON.stringify({ sizes, seeks }, null, 2))
console.log(JSON.stringify({ step: 'built', ...sizes, seeks: seeks.map((s) => `${s.beat}@${s.time}`) }))
