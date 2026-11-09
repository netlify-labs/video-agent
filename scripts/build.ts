// Build: generate the context module, then build the web app. Agent-run preview builds skip the UI
// (the run never uses its preview; outputs go to Blobs and callbacks go to production).
// With BRAND_ZIP_URL set, the web app's name, accent and logo come from that zip's brand.json, the same
// zip netlify-agent-kit unpacks into context/brand/ for agent runs.
import { execFileSync } from 'node:child_process'
import { build as esbuild } from 'esbuild'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isPreviewBuild, videoRunOf, writeVideoRunPreview } from './lib/agent-preview.js'
import { pinnedHyperframesVersion, repoRoot } from './lib/run-tools.js'
import { unpackZip, ZipError } from './lib/brand-zip.js'
import { buildLooks, copyLookPreviews, LookBuildError, writeLooksModule } from './lib/looks.js'
import { buildMcpApp } from './lib/mcp-app.js'
import { buildSkills } from './lib/skills.js'
import { playerBuildOptions } from './lib/player-build.js'
import { buildInfoModule, buildInfoOf, releaseTag } from './lib/build-info.js'
import {
  buildContextDigest,
  PLANNING_CONTEXT_FILES,
  type ContextSource,
} from '../app/server/domain/planning-context.js'

const log = (step: string, f: Record<string, unknown> = {}) => console.log(JSON.stringify({ step, ...f }))

type Brand = {
  name?: string
  appName?: string
  primaryColor?: string
  logo?: string | null
  logoLight?: string | null
  /** Optional brand music: a file in the kit (MP3, M4A, WAV or Ogg) and its feel, for videos with sound. */
  music?: { file?: string; genre?: string; tempo?: string | number } | null
  default?: boolean
}
const svgData = (svg: Buffer) => `data:image/svg+xml;base64,${svg.toString('base64')}`

// Reads brand.json and its logos from the brand zip, within limits (scripts/lib/brand-zip.ts: a timeout, the size,
// the entries, safe paths). Any failure falls back to context/, so a bad URL never breaks the deploy; the URL itself
// is never logged, only a reason code.
async function zipBrand(url: string): Promise<{ brand: Brand; file: (rel: string) => Buffer } | null> {
  const dir = mkdtempSync(join(tmpdir(), 'brand-'))
  try {
    const file = await unpackZip(url, dir)
    const brand = JSON.parse(file('brand.json').toString('utf8')) as Brand
    log('brand-zip', { ok: true })
    return { brand, file }
  } catch (e) {
    log('brand-zip', {
      ok: false,
      reason: e instanceof ZipError ? e.reason : 'bad_brand',
      error: e instanceof ZipError ? e.message : e instanceof Error ? e.name : 'error',
    })
    rmSync(dir, { recursive: true, force: true })
    return null
  }
}

const fromZip = process.env.BRAND_ZIP_URL ? await zipBrand(process.env.BRAND_ZIP_URL) : null
const localFile = (rel: string) => readFileSync(join(repoRoot, 'context', rel))
const brand: Brand = fromZip?.brand ?? (JSON.parse(localFile('brand.json').toString('utf8')) as Brand)
const file = fromZip?.file ?? localFile
const isDefault =
  !fromZip &&
  (brand.default === true || localFile('BRAND.md').toString('utf8').includes('video-agent:default'))
const logo = brand.logo ? svgData(file(brand.logo)) : null
const logoLight = brand.logoLight ? svgData(file(brand.logoLight)) : null
// Brand music is named by its path in the run's checkout (the zip unpacks into context/brand/); a missing file is
// dropped, so a run is never told to use music that isn't there.
const musicFile = brand.music?.file?.replace(/^\/+/, '')
let music: { file: string; genre: string | null; tempo: string | null } | null = null
if (musicFile && !musicFile.split('/').includes('..')) {
  try {
    file(musicFile)
    music = {
      file: `${fromZip ? 'context/brand' : 'context'}/${musicFile}`,
      genre: brand.music?.genre ? brand.music.genre.slice(0, 200) : null,
      tempo: brand.music?.tempo ? String(brand.music.tempo).slice(0, 40) : null,
    }
  } catch {
    log('brand-music', { ok: false, error: `${musicFile} is not in the brand kit` })
  }
}
const meta = {
  isDefault,
  name: brand.name ?? 'Video Agent',
  // What the app calls itself in the nav and on the sign-in screen, next to the logo.
  appName: brand.appName ?? brand.name ?? 'Video Agent',
  primaryColor: brand.primaryColor ?? '#14b8a6',
  logo,
  logoLight,
  music,
}
// Planning context digest (plan v2 §4): brand kit files first, then context/, allowlisted and size-bounded.
const read = (f: (rel: string) => Buffer, name: string) => {
  try {
    return f(name).toString('utf8')
  } catch {
    return ''
  }
}
const sources: ContextSource[] = [
  ...(fromZip
    ? PLANNING_CONTEXT_FILES.map((name) => ({
        origin: 'brand kit' as const,
        name,
        text: read(fromZip.file, name),
      }))
    : []),
  ...PLANNING_CONTEXT_FILES.map((name) => ({
    origin: 'context/' as const,
    name,
    text: read(localFile, name),
  })),
]
const planning = buildContextDigest(sources)
mkdirSync(join(repoRoot, 'app/server/generated'), { recursive: true })
writeFileSync(
  join(repoRoot, 'app/server/generated/context.ts'),
  `// Generated by scripts/build.ts from context/brand.json. Do not edit.\nexport const contextMeta = ${JSON.stringify(meta, null, 2)} as {\n  isDefault: boolean\n  name: string\n  appName: string\n  primaryColor: string\n  logo: string | null\n  logoLight: string | null\n  music: { file: string; genre: string | null; tempo: string | null } | null\n}\n`,
)
writeFileSync(
  join(repoRoot, 'app/server/generated/planning-context.ts'),
  `// Generated by scripts/build.ts: the planner's context digest. Do not edit.\nexport const planningContext: { text: string; hash: string; sources: string[] } = ${JSON.stringify(planning, null, 2)}\n`,
)
const build = buildInfoOf(process.env, releaseTag(repoRoot))
writeFileSync(join(repoRoot, 'app/server/generated/build-info.ts'), buildInfoModule(build))
log('build-info', { ...build })
log('context', {
  isDefault,
  name: meta.name,
  planningSources: planning.sources,
  planningHash: planning.hash,
  source: fromZip ? 'BRAND_ZIP_URL' : 'context/',
})
log('mcp-app', await buildMcpApp(repoRoot))

// Looks (plan 2026-11-04-looks §4.8), for every build: the API function carries looks-build/*.tar.gz (netlify.toml
// included_files), video-run previews included. A look that fails look:check --static fails the deploy.
let looks
try {
  looks = buildLooks({ repoRoot, hyperframesVersion: pinnedHyperframesVersion(), writeArchives: true })
} catch (e) {
  if (e instanceof LookBuildError) log('looks', { ok: false, problems: e.problems })
  throw e
}
writeLooksModule(repoRoot, looks)
log('looks', {
  count: looks.length,
  ids: looks.map((l) => l.id),
  bytes: looks.reduce((n, l) => n + l.bytes, 0),
})

const agentRun = Object.keys(process.env).some((k) => k.startsWith('NETLIFY_AGENT_RUNNER_'))
log('build-env', {
  context: process.env.CONTEXT ?? null,
  agentRun,
  agentVars: Object.keys(process.env)
    .filter((k) => /AGENT/.test(k))
    .sort(),
})
// A video run's preview shows the video it rendered instead of the app; any other agent run (someone changing the app)
// builds the app as usual. FORCE_UI_BUILD=true builds the app for a video run too.
const videoRun = agentRun ? videoRunOf(repoRoot) : null
if (videoRun && process.env.FORCE_UI_BUILD !== 'true') {
  const { embedded } = writeVideoRunPreview({
    root: repoRoot,
    outDir: join(repoRoot, 'app/web/dist'),
    run: videoRun,
    siteUrl: process.env.URL ?? null,
  })
  log('ui', { skipped: true, videoPreview: { jobId: videoRun.jobId, embedded } })
} else {
  // A preview can't run the app (no API or data, and sign-in can't return here): it opens the project page instead.
  const preview = isPreviewBuild(process.env)
  execFileSync('npx', ['vite', 'build', 'app/web'], {
    stdio: 'inherit',
    cwd: repoRoot,
    env: { ...process.env, VITE_PREVIEW_DEPLOY: preview ? '1' : '', VITE_APP_URL: process.env.URL ?? '' },
  })
  log('ui', { skipped: false, preview })
  // The preview's runtime comes from the pinned hyperframes package, never a CDN (plan v2 §7). The /preview edge
  // function serves these under each bundle's capability path.
  mkdirSync(join(repoRoot, 'app/web/dist/_preview'), { recursive: true })
  copyFileSync(
    join(repoRoot, 'node_modules/hyperframes/dist/hyperframe.runtime.iife.js'),
    join(repoRoot, 'app/web/dist/_preview/runtime.js'),
  )
  copyFileSync(join(repoRoot, 'app/server/preview/bridge.js'), join(repoRoot, 'app/web/dist/_preview/bridge.js'))
  // For compositions made before GSAP was vendored (the preview rewrites their CDN tag to this).
  copyFileSync(join(repoRoot, 'video/vendor/gsap.min.js'), join(repoRoot, 'app/web/dist/_preview/gsap.js'))
  // Static pages outside the app (app/web/static/<path>/index.html), public and without the app's JavaScript.
  cpSync(join(repoRoot, 'app/web/static'), join(repoRoot, 'app/web/dist'), { recursive: true })
  log('preview', { runtime: 'hyperframes/dist/hyperframe.runtime.iife.js' })
  // Installable agent skills at /skills/<name>.zip and /skills/index.json, pointing at this deployment's URL (the
  // same URL the API uses for links), so a fork serves skills for itself.
  const skills = buildSkills(
    join(repoRoot, 'skills'),
    join(repoRoot, 'app/web/dist/skills'),
    process.env.URL ?? 'http://localhost:8888',
  )
  log('skills', { skills: skills.map((s) => ({ name: s.name, bytes: s.bytes, sha256: s.sha256 })) })
  // <video-agent-player> at /player.js, the same bytes as the npm package's dist (cli-and-sdk plan §7).
  await esbuild(playerBuildOptions(repoRoot, join(repoRoot, 'app/web/dist/player.js')))
  log('player', { file: 'app/web/dist/player.js' })
  // The picker's clips and posters, content-hashed under /assets/ (immutable cache); after vite empties app/web/dist.
  log('looks-previews', { copied: copyLookPreviews(repoRoot, looks, join(repoRoot, 'app/web/dist')) })
}
