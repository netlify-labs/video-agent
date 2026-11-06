// The Remotion engine's check and snapshot (render-engines plan §5.2 checks, §5.4). Remotion and TypeScript are loaded
// at call time from video/node_modules, so the root never depends on them; tests pass their own.
//   check: props, the registry (rewritten first), the static scan, the project files, selectComposition against props,
//     tsc --noEmit, and a render smoke (stills at the first frame, up to 4 beat midpoints and the last frame).
//   snapshot: stills at the seconds asked, into .render/snapshots/.
// Every still is a render and is counted (.render/renders.json), with the license key the run manifest's tier picks.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type * as TS from 'typescript'
import {
  generateRegistry,
  projectFileProblems,
  propsProblems,
  registryProblems,
} from '../../../src/lib/remotion-project.js'
import { StepError } from '../run-tools.js'

/** The few Remotion calls the engine makes: its own declarations, so the root typecheck needs no Remotion. */
export interface RemotionApi {
  bundle(o: { entryPoint: string; publicDir: string; outDir: string }): Promise<string>
  openBrowser(
    browser: 'chrome',
    o: { logLevel: 'error' },
  ): Promise<{ close(o: { silent: boolean }): Promise<void> }>
  selectComposition(
    o: Record<string, unknown>,
  ): Promise<{ width: number; height: number; fps: number; durationInFrames: number }>
  renderStill(o: Record<string, unknown>): Promise<unknown>
  renderMedia(o: Record<string, unknown>): Promise<unknown>
}

/** Remotion from the project's own node_modules (installed by hydrate/scaffold). */
export function loadRemotion(videoDir: string): RemotionApi {
  const req = createRequire(join(videoDir, 'package.json'))
  return { ...(req('@remotion/bundler') as object), ...(req('@remotion/renderer') as object) } as RemotionApi
}
export function loadTypeScript(videoDir: string): typeof TS {
  return createRequire(join(videoDir, 'package.json'))('typescript') as typeof TS
}

/**
 * Whether remotion.pro takes isProduction with the "free-license" value. Remotion's docs say isProduction needs a license
 * key; the Node API forwards it either way (spikes E5), but what the service does with it is E6's open question.
 */
export const FREE_LICENSE_ACCEPTS_IS_PRODUCTION: boolean = false

/**
 * The key renders report with (§5.5): the tier the admin recorded, from the run manifest. Read in this process only,
 * never put on a command line or in a log. isProduction: false marks a development deployment's renders, passed only
 * where it's known to be accepted; otherwise it's left out and the render counts as production.
 */
export function licenseFor(
  root: string,
  env: Record<string, string | undefined> = process.env,
  log: (step: string, fields?: Record<string, unknown>) => void = () => {},
): { licenseKey: string; isProduction?: false } {
  const path = join(root, '.render', 'run-manifest.json')
  const engine = existsSync(path)
    ? ((JSON.parse(readFileSync(path, 'utf8')) as { engine?: { tier?: string; development?: boolean } })
        .engine ?? {})
    : {}
  let licenseKey = 'free-license'
  if (engine.tier === 'company') {
    const key = env.VIDEO_AGENT_REMOTION_KEY
    if (!key)
      throw new StepError(
        "engine_license_key_missing: the admin recorded a Company License but VIDEO_AGENT_REMOTION_KEY isn't set on this project.",
      )
    licenseKey = key
  }
  if (!engine.development) return { licenseKey }
  if (engine.tier === 'company' || FREE_LICENSE_ACCEPTS_IS_PRODUCTION)
    return { licenseKey, isProduction: false }
  log('engine.is_production_omitted', { reason: 'not yet known to be accepted with "free-license"' })
  return { licenseKey }
}

/** How many renders the run made (the license counts every still and video), kept across commands. */
export function countRenders(videoDir: string, add: Partial<Record<'video' | 'stills' | 'audio', number>>) {
  const file = join(videoDir, '.render', 'renders.json')
  const now = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as Record<'video' | 'stills' | 'audio', number>)
    : { video: 0, stills: 0, audio: 0 }
  for (const [k, n] of Object.entries(add)) now[k as keyof typeof now] += n
  mkdirSync(join(videoDir, '.render'), { recursive: true })
  writeFileSync(file, JSON.stringify(now))
  return now
}

interface Props {
  width: number
  height: number
  fps: number
  beats: {
    id: string
    duration: number
    texts: Record<string, unknown>
    media: Record<string, { kind: string }>
  }[]
  layers: { id: string }[]
}

/**
 * The static scan (§5.2 check 3) over the project's TypeScript sources, with the TypeScript compiler API: every
 * <VaText id>, <VaImage slot>, <VaClip slot> in a beat is a string literal in THAT beat's props and each is used exactly
 * once; nothing in src/ imports Google Fonts, names a URL or reads process.env. The template's own va/ is locked, so
 * it's left out.
 */
export function scanSources(ts: typeof TS, files: Map<string, Uint8Array>, props: Props): string[] {
  const problems: string[] = []
  const used = new Map<string, number>()
  for (const [path, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^src\/.*\.tsx?$/.test(path) || path.startsWith('src/va/') || path === 'src/registry.ts') continue
    const sf = ts.createSourceFile(
      path,
      new TextDecoder().decode(bytes),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    )
    const beatId = /^src\/beats\/([a-z0-9-]+)\.tsx$/.exec(path)?.[1]
    const beat = beatId ? props.beats.find((b) => b.id === beatId) : undefined
    const at = (n: TS.Node) => `${path}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`
    const visit = (n: TS.Node) => {
      if (
        ts.isImportDeclaration(n) &&
        ts.isStringLiteral(n.moduleSpecifier) &&
        n.moduleSpecifier.text.startsWith('@remotion/google-fonts')
      )
        problems.push(
          `${at(n)}: Google Fonts load from the web; use a font file in assets/fonts with loadFont.`,
        )
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && /https?:\/\//.test(n.text))
        problems.push(`${at(n)}: the video can't load anything from a URL ("${n.text.slice(0, 60)}").`)
      if (ts.isPropertyAccessExpression(n) && n.expression.getText(sf) === 'process' && n.name.text === 'env')
        problems.push(`${at(n)}: compositions can't read process.env.`)
      if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) {
        const tag = n.tagName.getText(sf)
        const attr = tag === 'VaText' ? 'id' : tag === 'VaImage' || tag === 'VaClip' ? 'slot' : null
        if (attr) {
          const a = n.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === attr)
          const init = a && ts.isJsxAttribute(a) ? a.initializer : undefined
          const literal =
            init && ts.isStringLiteral(init)
              ? init.text
              : init && ts.isJsxExpression(init) && init.expression && ts.isStringLiteral(init.expression)
                ? init.expression.text
                : null
          if (literal === null)
            problems.push(`${at(n)}: <${tag} ${attr}> must be a plain string, like ${attr}="intro-title".`)
          else if (!beat)
            problems.push(
              `${at(n)}: <${tag}> is only for beats (src/beats/<id>.tsx with an entry in props.json).`,
            )
          else {
            const pool = tag === 'VaText' ? beat.texts : beat.media
            const kind = tag === 'VaText' ? 'text' : tag === 'VaImage' ? 'image' : 'video'
            if (!(literal in pool))
              problems.push(
                `${at(n)}: there's no ${kind === 'text' ? 'text' : 'media slot'} "${literal}" in beat "${beat.id}"'s props.`,
              )
            else if (kind !== 'text' && beat.media[literal]?.kind !== kind)
              problems.push(
                `${at(n)}: slot "${literal}" holds ${beat.media[literal]?.kind ?? 'other'} media; use <${kind === 'image' ? 'VaClip' : 'VaImage'}>.`,
              )
            const key = `${beat.id}\u0000${literal}`
            used.set(key, (used.get(key) ?? 0) + 1)
          }
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  for (const b of props.beats)
    for (const [kind, ids] of [
      ['text', Object.keys(b.texts)],
      ['media slot', Object.keys(b.media)],
    ] as const)
      for (const id of ids) {
        const n = used.get(`${b.id}\u0000${id}`) ?? 0
        if (n === 0)
          problems.push(
            `props.json: the ${kind} "${id}" of beat "${b.id}" isn't shown; use it once in src/beats/${b.id}.tsx.`,
          )
        if (n > 1)
          problems.push(
            `props.json: the ${kind} "${id}" of beat "${b.id}" is shown ${n} times; show it once.`,
          )
      }
  return problems
}

export interface CheckDeps {
  /** The repo root (for the run manifest's license tier). */
  root: string
  remotion: (videoDir: string) => RemotionApi
  ts: (videoDir: string) => typeof TS
  run: (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<string>
  log: (step: string, fields?: Record<string, unknown>) => void
  readProject: (dir: string) => Map<string, Uint8Array>
}

/** The bundle for this exact source: .render/bundle-<hash of every source file>, made once and reused. */
export async function bundleFor(d: CheckDeps, videoDir: string, files = d.readProject(videoDir)) {
  const h = createHash('sha256')
  for (const [p, b] of [...files].sort(([a], [x]) => a.localeCompare(x)))
    h.update(`${p}\0${createHash('sha256').update(b).digest('hex')}\n`)
  const dir = join(videoDir, '.render', `bundle-${h.digest('hex').slice(0, 24)}`)
  if (existsSync(join(dir, 'index.html'))) return { serveUrl: dir, cached: true }
  const tmp = `${dir}.tmp`
  rmSync(tmp, { recursive: true, force: true })
  await d.remotion(videoDir).bundle({
    entryPoint: join(videoDir, 'src', 'index.ts'),
    publicDir: join(videoDir, 'assets'),
    outDir: tmp,
  })
  renameSync(tmp, dir)
  return { serveUrl: dir, cached: false }
}

/** Stills at these frames on ONE browser and the cached bundle, each counted and reported with the license key. */
async function stills(
  d: CheckDeps,
  videoDir: string,
  serveUrl: string,
  frames: { frame: number; out: string }[],
) {
  const api = d.remotion(videoDir)
  const license = licenseFor(d.root, process.env, d.log)
  const browser = await api.openBrowser('chrome', { logLevel: 'error' })
  try {
    const composition = await api.selectComposition({
      serveUrl,
      id: 'main',
      inputProps: {},
      puppeteerInstance: browser,
      ...license,
    })
    for (const f of frames) {
      mkdirSync(join(f.out, '..'), { recursive: true })
      await api.renderStill({
        composition,
        serveUrl,
        frame: f.frame,
        output: f.out,
        puppeteerInstance: browser,
        ...license,
      })
      countRenders(videoDir, { stills: 1 })
    }
    return composition
  } finally {
    await browser.close({ silent: true })
  }
}

export async function checkProject(
  d: CheckDeps,
  videoDir: string,
): Promise<{ errors: string[]; warnings: string[] }> {
  const errors: string[] = []
  const rule = async (name: string, fn: () => Promise<string[]> | string[]) => {
    const t = Date.now()
    const found = await fn()
    d.log('engine.check.rule', {
      rule: name,
      ok: !found.length,
      ms: Date.now() - t,
      detail: found.slice(0, 5),
    })
    errors.push(...found)
    return found
  }
  let files = d.readProject(videoDir)
  if ((await rule('props', () => propsProblems(files.get('props.json')))).length)
    return { errors, warnings: [] }
  const props = JSON.parse(new TextDecoder().decode(files.get('props.json'))) as Props
  // The registry is generated, so it's rewritten before it's checked: only a missing or extra component remains.
  writeFileSync(join(videoDir, 'src', 'registry.ts'), generateRegistry(props))
  files = d.readProject(videoDir)
  await rule('registry', () => registryProblems(files, props))
  await rule('scan', () => scanSources(d.ts(videoDir), files, props))
  await rule('files', () => projectFileProblems(files))
  if (errors.length) return { errors, warnings: [] }
  await rule('tsc', async () => {
    try {
      await d.run('npx', ['tsc', '--noEmit', '-p', 'tsconfig.json'], { cwd: videoDir, timeoutMs: 180_000 })
      return []
    } catch (e) {
      return [`tsc: ${(e instanceof Error ? e.message : String(e)).slice(-1500)}`]
    }
  })
  if (errors.length) return { errors, warnings: [] }
  const { serveUrl } = await bundleFor(d, videoDir, files)
  // Render smoke: the first frame, each beat's midpoint (up to 4) and the last frame.
  let start = 0
  const mids = props.beats.slice(0, 4).map((b) => {
    const at = Math.round((start + b.duration / 2) * 30)
    start += b.duration
    return at
  })
  const total = Math.round(props.beats.reduce((s, b) => s + b.duration, 0) * 30)
  const frames = [...new Set([0, ...mids, Math.max(0, total - 1)])]
  await rule('composition', async () => {
    try {
      const c = await stills(
        d,
        videoDir,
        serveUrl,
        frames.map((frame) => ({ frame, out: join(videoDir, '.render', 'smoke', `${frame}.png`) })),
      )
      const want = { width: props.width, height: props.height, fps: props.fps, durationInFrames: total }
      const got = { width: c.width, height: c.height, fps: c.fps, durationInFrames: c.durationInFrames }
      return JSON.stringify(got) === JSON.stringify(want)
        ? []
        : [`The composition is ${JSON.stringify(got)}, but props.json says ${JSON.stringify(want)}.`]
    } catch (e) {
      return [`The render smoke failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 1500)}`]
    }
  })
  return { errors, warnings: [] }
}

/** Stills at these seconds into .render/snapshots/<seconds>.png, on one browser. Returns their paths. */
export async function snapshotProject(d: CheckDeps, videoDir: string, atSec: number[]): Promise<string[]> {
  const { serveUrl } = await bundleFor(d, videoDir)
  const out = atSec.map((s) => ({
    frame: Math.max(0, Math.round(s * 30)),
    out: join(videoDir, '.render', 'snapshots', `${s}.png`),
  }))
  await stills(d, videoDir, serveUrl, out)
  d.log('engine.snapshot', { at: atSec, files: out.length })
  return out.map((o) => o.out)
}
