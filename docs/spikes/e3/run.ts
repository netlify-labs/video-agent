// Spike E3 (render-engines plan §11, bead va-ed2s.1.3): does the props.json-driven contract hold up for every edit op?
// Local evaluation only (owner's go-ahead 2026-11-05): every still is a development render with licenseKey
// "free-license" and isProduction false; nothing is published.
//
//   cd docs/spikes/e3 && npm ci && npx tsx run.ts [--no-render]
//
// For each case (every op alone, then sequences), applies the ops to the HyperFrames fixture with contract.ts and to
// the paired props.json with contract-props.ts, and compares the Composition and captions field by field. Then renders
// a still at each beat's midpoint with renderStill on one browser and compares them with the unedited stills, and
// checks selectComposition's length. A delete is also rendered from a project with the beat's file removed and the
// registry regenerated. One JSON line per case: { case, ops, ms, ok, diff, stills }. Writes results.json and the
// paired fixtures under test/fixtures/engines/.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { bundle } from '@remotion/bundler'
import { openBrowser, renderStill, selectComposition } from '@remotion/renderer'
import { applyEdits, type EditOp, type Summary } from '../../../app/server/lib/contract.js'
import { applyOps, propsFromComposition, readProps, registryFor, syncCaptions } from './contract-props.js'
import type { VaProps } from './project/src/va/schema.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..')
const project = join(here, 'project')
const fixture = join(repo, 'test', 'fixtures', 'contract1-voice')
const render = !process.argv.includes('--no-render')
const LICENSE = { licenseKey: 'free-license', isProduction: false } as const
const log = (step: string, f: Record<string, unknown> = {}) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), step, ...f }))
}

// Stand-in media, made once (ffmpeg): a test-pattern clip, a music bed, two voice clips and two logos.
const assets = join(project, 'assets')
const make: [string, string[]][] = [
  ['media/med_clip.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-t', '4', '-pix_fmt', 'yuv420p']],
  ['media/med_theme01.mp3', ['-f', 'lavfi', '-i', 'sine=frequency=220:duration=9']],
  ['voice/intro.wav', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.2']],
  ['voice/outro.wav', ['-f', 'lavfi', '-i', 'sine=frequency=550:duration=1.5']],
]
for (const [file, args] of make)
  if (!existsSync(join(assets, file))) {
    mkdirSync(dirname(join(assets, file)), { recursive: true })
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args, join(assets, file)])
  }
const svg = (shape: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80">${shape}</svg>`
writeFileSync(join(assets, 'media', 'med_logo.svg'), svg('<rect width="200" height="80" rx="12" fill="#14b8a6"/>'))
writeFileSync(join(assets, 'media', 'med_logo2.svg'), svg('<circle cx="100" cy="40" r="36" fill="#f97316"/>'))

const html = readFileSync(join(fixture, 'index.html'), 'utf8')
const summary = JSON.parse(readFileSync(join(fixture, 'summary.json'), 'utf8')) as Summary
// The voice script's lines (scripts/voice.ts): what each voiced beat says, as the editor shows it.
const narration = { intro: 'Meet org webhooks. One place for every event.', outro: 'Read the docs.' }
const base = applyEdits(html, summary, [], { narration })
const props = propsFromComposition(base.composition, { width: 1920, height: 1080 }, narration)
writeFileSync(join(project, 'props.json'), `${JSON.stringify(props, null, 2)}\n`)
writeFileSync(join(project, 'summary.json'), `${JSON.stringify(base.summary, null, 2)}\n`)
writeFileSync(join(project, 'src', 'registry.ts'), registryFor(props))

/** Paths where two values differ (deep), for the log. */
function diff(a: unknown, b: unknown, path = ''): string[] {
  if (isDeepStrictEqual(a, b)) return []
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    return keys.flatMap((k) => diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}/${k}`))
  }
  return [`${path || '/'}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`]
}

const CASES: { name: string; ops: EditOp[]; changes: string[] }[] = [
  { name: 'none', ops: [], changes: [] },
  { name: 'text', ops: [{ op: 'text', id: 'intro-title', text: 'Org webhooks, everywhere' }], changes: ['intro'] },
  { name: 'retime', ops: [{ op: 'retime', beat: 'intro', duration: 4.5 }], changes: [] },
  // The clip plays on: a longer demo's midpoint is a later clip frame.
  { name: 'retime-off-frame', ops: [{ op: 'retime', beat: 'demo', duration: 3.85 }], changes: ['demo'] },
  { name: 'retime-min', ops: [{ op: 'retime', beat: 'intro', duration: 0.5 }], changes: ['intro'] },
  { name: 'reorder', ops: [{ op: 'reorder', order: ['outro', 'intro', 'demo'] }], changes: [] },
  { name: 'delete', ops: [{ op: 'delete', beat: 'demo' }], changes: [] },
  { name: 'color', ops: [{ op: 'color', role: 'accent', value: '#F97316' }], changes: ['intro'] },
  {
    name: 'media',
    ops: [{ op: 'media', slot: 'logo', src: 'assets/media/med_logo2.svg', kind: 'image', fit: 'cover' }],
    changes: ['outro'],
  },
  { name: 'audio', ops: [{ op: 'audio', id: 'music', volume: 0.5, muted: true }], changes: [] },
  { name: 'voice', ops: [{ op: 'voice', beat: 'intro', text: 'Meet  org webhooks. ' }], changes: [] },
  {
    name: 'text+retime',
    ops: [
      { op: 'text', id: 'demo-sub', text: 'Every project, one subscription' },
      { op: 'retime', beat: 'demo', duration: 5 },
    ],
    changes: ['demo'],
  },
  {
    name: 'retime+reorder',
    ops: [
      { op: 'retime', beat: 'outro', duration: 2 },
      { op: 'reorder', order: ['demo', 'outro', 'intro'] },
    ],
    changes: [],
  },
  {
    name: 'delete+reorder',
    ops: [
      { op: 'delete', beat: 'intro' },
      { op: 'reorder', order: ['outro', 'demo'] },
    ],
    changes: [],
  },
  {
    name: 'color+media',
    ops: [
      { op: 'color', role: 'text', value: '#ffcc00' },
      { op: 'media', slot: 'hero-clip', src: 'assets/media/med_clip.mp4', kind: 'video', fit: 'contain' },
    ],
    // The demo uses the muted colour, and "contain" on a clip the slot's own shape changes nothing.
    changes: ['intro', 'outro'],
  },
  {
    name: 'delete-all-but-one',
    ops: [
      { op: 'delete', beat: 'demo' },
      { op: 'delete', beat: 'outro' },
    ],
    changes: [],
  },
  // Refusals must match too.
  { name: 'refuse-last-beat', ops: [{ op: 'delete', beat: 'intro' }, { op: 'delete', beat: 'demo' }, { op: 'delete', beat: 'outro' }], changes: [] },
  { name: 'refuse-retime', ops: [{ op: 'retime', beat: 'intro', duration: 0.4 }], changes: [] },
  { name: 'refuse-media-kind', ops: [{ op: 'media', slot: 'logo', src: 'assets/media/med_clip.mp4', kind: 'video', fit: 'cover' }], changes: [] },
  { name: 'refuse-voice', ops: [{ op: 'voice', beat: 'demo', text: 'Hello' }], changes: [] },
]

interface Result {
  case: string
  ok: boolean
  model: { ok: boolean; diff: string[]; refused?: string }
  stills?: { beat: string; frame: number; sha256: string; changed: boolean }[]
  stillsOk?: boolean
  durationInFrames?: { got: number; want: number }
  ms: number
}
const results: Result[] = []

// Round trip first: the props derived from the fixture read back as the fixture's own Composition.
{
  const d = [...diff(readProps(props), base.composition), ...diff(syncCaptions(readProps(props), summary), base.summary)]
  log('round_trip', { ok: !d.length, diff: d })
}

const modelOf = (ops: EditOp[]) => {
  let hf: ReturnType<typeof applyEdits> | Error
  let re: ReturnType<typeof applyOps> | Error
  try {
    hf = applyEdits(html, summary, ops, { narration })
  } catch (e) {
    hf = e as Error
  }
  try {
    re = applyOps(props, summary, ops)
  } catch (e) {
    re = e as Error
  }
  return { hf, re }
}

let serveUrl = ''
let browser: Awaited<ReturnType<typeof openBrowser>> | null = null
const stills = new Map<string, string>()
const renders = { stills: 0 }
async function stillsFor(p: VaProps, url: string) {
  const comp = await selectComposition({ serveUrl: url, id: 'main', inputProps: p, puppeteerInstance: browser ?? undefined, ...LICENSE })
  const out: { beat: string; frame: number; sha256: string }[] = []
  const lay = readProps(p)
  for (const b of lay.beats) {
    const frame = Math.round((b.start + b.duration / 2) * 30)
    const file = join(tmpdir(), `e3-${b.id}-${frame}-${process.pid}.png`)
    await renderStill({ composition: comp, serveUrl: url, inputProps: p, frame, output: file, puppeteerInstance: browser ?? undefined, ...LICENSE })
    renders.stills++
    out.push({ beat: b.id, frame, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') })
    rmSync(file, { force: true })
  }
  return { comp, out }
}

if (render) {
  const t = Date.now()
  serveUrl = await bundle({ entryPoint: join(project, 'src', 'index.ts'), publicDir: join(project, 'assets') })
  log('bundle', { ms: Date.now() - t })
  const b = Date.now()
  browser = await openBrowser('chrome', { logLevel: 'error' })
  log('browser', { ms: Date.now() - b })
}

for (const c of CASES) {
  const t = Date.now()
  const { hf, re } = modelOf(c.ops)
  let model: Result['model']
  if (hf instanceof Error || re instanceof Error) {
    const same = hf instanceof Error && re instanceof Error && hf.message === re.message
    model = { ok: same, diff: same ? [] : [`hf: ${hf instanceof Error ? hf.message : 'ok'} · props: ${re instanceof Error ? re.message : 'ok'}`], refused: hf instanceof Error ? hf.message : undefined }
  } else {
    const d = [...diff(re.composition, hf.composition, '/composition'), ...diff(re.summary.captions, hf.summary.captions, '/captions')]
    model = { ok: !d.length, diff: d }
  }
  const r: Result = { case: c.name, ok: model.ok, model, ms: 0 }
  if (render && !(re instanceof Error) && !(hf instanceof Error)) {
    const { comp, out } = await stillsFor(re.props, serveUrl)
    if (c.name === 'none') for (const s of out) stills.set(s.beat, s.sha256)
    r.stills = out.map((s) => ({ ...s, changed: stills.get(s.beat) !== s.sha256 }))
    r.stillsOk = r.stills.every((s) => s.changed === c.changes.includes(s.beat))
    r.durationInFrames = { got: comp.durationInFrames, want: Math.round(hf.composition.duration * 30) }
    r.ok = r.ok && r.stillsOk && comp.durationInFrames === r.durationInFrames.want
  }
  r.ms = Date.now() - t
  results.push(r)
  log('case', { case: c.name, ops: c.ops.map((o) => o.op), ms: r.ms, ok: r.ok, diff: model.diff, refused: model.refused ?? null, stills: r.stills?.map((s) => `${s.beat}@${s.frame}${s.changed ? '*' : ''}`) ?? null, durationInFrames: r.durationInFrames ?? null })
}

// A delete as a run would see it: the beat's file gone and the registry regenerated, bundled from props.json itself.
if (render) {
  const del = applyOps(props, summary, [{ op: 'delete', beat: 'demo' }])
  // Next to project/, so webpack resolves the spike's node_modules as a run resolves video/node_modules.
  const dir = mkdtempSync(join(here, '.tmp-delete-'))
  cpSync(project, dir, { recursive: true })
  for (const f of del.removed) rmSync(join(dir, f), { recursive: true, force: true })
  writeFileSync(join(dir, 'props.json'), JSON.stringify(del.props, null, 2))
  writeFileSync(join(dir, 'src', 'registry.ts'), registryFor(del.props))
  const t = Date.now()
  const url = await bundle({ entryPoint: join(dir, 'src', 'index.ts'), publicDir: join(dir, 'assets') })
  const { comp, out } = await stillsFor(del.props, url)
  const ok = out.every((s) => stills.get(s.beat) === s.sha256) && comp.durationInFrames === 180
  results.push({ case: 'delete-from-files', ok, model: { ok: true, diff: [] }, ms: Date.now() - t })
  log('case', { case: 'delete-from-files', ok, ms: Date.now() - t, removed: del.removed, durationInFrames: comp.durationInFrames, stills: out.map((s) => s.beat) })
  rmSync(dir, { recursive: true, force: true })
  await browser?.close({ silent: true })
}

// The paired fixtures for the conformance suite (3.3): the HyperFrames pair, and the Remotion project as one file.
const fx = join(repo, 'test', 'fixtures', 'engines')
mkdirSync(join(fx, 'contract1-voice'), { recursive: true })
writeFileSync(join(fx, 'contract1-voice', 'index.html'), html)
writeFileSync(join(fx, 'contract1-voice', 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
writeFileSync(join(fx, 'contract1-voice', 'narration.json'), `${JSON.stringify(narration, null, 2)}\n`)
const files: Record<string, string> = {}
const add = (p: string) => {
  files[relative(project, p)] = readFileSync(p, 'utf8')
}
for (const p of ['props.json', 'summary.json']) add(join(project, p))
for (const d of ['src', 'src/va', 'src/beats', 'src/layers'])
  for (const f of (await import('node:fs')).readdirSync(join(project, d), { withFileTypes: true }))
    if (f.isFile()) add(join(project, d, f.name))
writeFileSync(join(fx, 'contract1-voice.remotion.json'), `${JSON.stringify(files, null, 2)}\n`)

const failed = results.filter((r) => !r.ok).map((r) => r.case)
writeFileSync(join(here, 'results.json'), `${JSON.stringify({ renders, results }, null, 2)}\n`)
log(failed.length ? 'E3_FAIL' : 'E3_OK', { cases: results.length, failed, renders })
process.exit(failed.length ? 1 : 0)
