// Remotion as a run engine (render-engines plan §5.1, §8), Phase 2: setting video/ up. Loads nothing from Remotion at
// import time, and every command and download goes through injectable deps, so its tests need no Remotion install.
//   scaffold (author runs): clear video/, copy app/engines/remotion/ in, install.
//   hydrate (every other kind): check the restored files against the template's rules FIRST (engine_tampered), then
//     install. Nothing from a restored package.json or lockfile runs before that check passes.
//   install: npm ci --ignore-scripts, Chrome Headless Shell, and the four pinned agent skills.
// Every StepError starts with its code and a colon, so the agent's result carries it and finalize can map it.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, relative } from 'node:path'
import { REMOTION_VERSION, remotionProjectProblems } from '../../../app/server/lib/remotion-project.js'
import { readTarGz, TarError } from '../../../app/server/lib/tar.js'
import { log as runLog, repoRoot as defaultRoot, runStreaming, StepError } from '../run-tools.js'
import {
  bundleFor,
  checkProject,
  countRenders,
  licenseFor,
  loadRemotion,
  loadTypeScript,
  snapshotProject,
  type RemotionApi,
} from './remotion-check.js'
import type { RunEngine } from './types.js'

/** Each install step's limit: 3x E1's median once it's measured; a placeholder until then. */
export const INSTALL_TIMEOUT_MS = 180_000
/**
 * The agent skills, pinned (remotion-dev/skills at the commit whose skills are versioned 4.0.540). Only these are
 * installed: studio, interactivity, docs (it fetches the web), upgrade, saas and license are left out.
 */
export const SKILLS = {
  commit: 'c7cb2fdcacd134fb2ccb9b7a44f9ffa44e467271',
  sha256: 'a626ec482b4f686cda123b04b34e34fb4e08f28471ac3d98f7d2b07bcb3666cc',
  names: ['remotion-best-practices', 'remotion-markup', 'remotion-render', 'remotion-captions'],
  /** Added when the run's look asks for maps. */
  maps: 'remotion-maps',
}
/** render-job's quality names → h264 CRF. Placeholders until E2 calibrates them (5.0's bt709 default will move them). */
export const QUALITY_CRF: Record<string, number> = { looks: 23, standard: 20, delivery: 17 }

/** Chrome Headless Shell's sha256 per Remotion version, from E1. Until it's measured the hash is logged, not checked. */
export const BROWSER_SHA256: Record<string, string> = {}

export interface RemotionRunDeps {
  root: string
  run: (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<string>
  fetch: (url: string, timeoutMs: number) => Promise<Uint8Array>
  log: (step: string, fields?: Record<string, unknown>) => void
  timeoutMs: number
  /** Extra skills for the run's look (remotion-maps). */
  extraSkills: string[]
  /** The skills archive's commit and sha256 (tests pin their own). */
  skillsPin: { commit: string; sha256: string }
  /** Remotion and TypeScript, loaded from video/node_modules at call time (tests pass stubs). */
  remotion: (videoDir: string) => RemotionApi
  ts: typeof loadTypeScript
}

const fetchBytes = async (url: string, timeoutMs: number) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

/** Every file under a directory as path → bytes, leaving out installed packages and the run's own output. */
export function readProject(dir: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>()
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (n === 'node_modules' || n === '.render') continue
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else out.set(relative(dir, p), new Uint8Array(readFileSync(p)))
    }
  }
  walk(dir)
  return out
}

/** The rules a restored project must pass before anything in it runs; [] when it does. */
export const restoredProblems = remotionProjectProblems

export function remotionEngine(overrides: Partial<RemotionRunDeps> = {}): RunEngine & {
  install(videoDir: string): Promise<void>
  skills(): Promise<string[]>
} {
  const d: RemotionRunDeps = {
    root: defaultRoot,
    run: (cmd, args, opts) => runStreaming(cmd, args, opts),
    fetch: fetchBytes,
    log: runLog,
    timeoutMs: INSTALL_TIMEOUT_MS,
    extraSkills: [],
    skillsPin: { commit: SKILLS.commit, sha256: SKILLS.sha256 },
    remotion: loadRemotion,
    ts: loadTypeScript,
    ...overrides,
  }
  const checkDeps = () => ({
    root: d.root,
    remotion: d.remotion,
    ts: d.ts,
    run: d.run,
    log: d.log,
    readProject,
  })
  const template = join(d.root, 'app', 'engines', 'remotion')

  /** One install step, logged; a timeout or a failure becomes engine_install_failed with the step's name. */
  async function step(name: string, cmd: string, args: string[], cwd: string) {
    const t = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        d.run(cmd, args, { cwd, timeoutMs: d.timeoutMs }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new StepError(`${name} timed out after ${Math.round(d.timeoutMs / 1000)} s`)),
            d.timeoutMs,
          )
        }),
      ])
      d.log('engine.install.step', { name, ms: Date.now() - t, ok: true })
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      d.log('engine.install.step', { name, ms: Date.now() - t, ok: false, code: 'engine_install_failed' })
      throw new StepError(`engine_install_failed: ${why.slice(0, 1500)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  /** The pinned skills tarball, hash-checked, extracted safely, only the named skills, into both agents' folders. */
  async function skills(): Promise<string[]> {
    const t = Date.now()
    const names = [...SKILLS.names, ...d.extraSkills]
    const fail = (why: string): never => {
      d.log('engine.install.step', {
        name: 'skills',
        ms: Date.now() - t,
        ok: false,
        code: 'engine_skills_unavailable',
      })
      throw new StepError(`engine_skills_unavailable: ${why}`)
    }
    let gz: Uint8Array
    try {
      gz = await d.fetch(
        `https://codeload.github.com/remotion-dev/skills/tar.gz/${d.skillsPin.commit}`,
        d.timeoutMs,
      )
    } catch (e) {
      return fail(`the skills download failed (${e instanceof Error ? e.message : String(e)}).`)
    }
    if (createHash('sha256').update(gz).digest('hex') !== d.skillsPin.sha256)
      return fail("the skills archive doesn't match its pinned hash.")
    let files: Map<string, Uint8Array>
    try {
      files = readTarGz(
        gz,
        { maxEntries: 2000, maxTotalBytes: 30 * 1024 * 1024, maxFileBytes: 5 * 1024 * 1024 },
        { root: `skills-${d.skillsPin.commit}` },
      )
    } catch (e) {
      return fail(e instanceof TarError ? e.message : String(e))
    }
    for (const name of names) {
      const prefix = `skills/${name}/`
      const own = [...files].filter(([p]) => p.startsWith(prefix))
      if (!own.some(([p]) => p === `${prefix}SKILL.md`)) fail(`the archive has no ${name} skill.`)
      for (const dest of ['.agents/skills', '.claude/skills'])
        for (const [p, bytes] of own) {
          const to = join(d.root, dest, name, p.slice(prefix.length))
          mkdirSync(dirname(to), { recursive: true })
          writeFileSync(to, bytes)
        }
    }
    d.log('engine.install.step', { name: 'skills', ms: Date.now() - t, ok: true, skills: names })
    return names
  }

  async function install(videoDir: string) {
    await step('npm ci', 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], videoDir)
    // From video/, so the browser lands in video/node_modules/.remotion (Remotion caches it under the nearest
    // package.json to the working directory; spikes POC).
    await step('browser ensure', 'npx', ['remotion', 'browser', 'ensure'], videoDir)
    const cache = join(videoDir, 'node_modules', '.remotion')
    const shell = existsSync(cache) ? findFile(cache, /chrome-headless-shell$/) : null
    const sha256 = shell ? createHash('sha256').update(readFileSync(shell)).digest('hex') : null
    const want = BROWSER_SHA256[REMOTION_VERSION]
    if (want && sha256 !== want)
      throw new StepError(
        `engine_install_failed: Chrome Headless Shell doesn't match its pinned hash (got ${sha256}).`,
      )
    d.log('engine.browser_hash', { sha256, checked: !!want })
    await skills()
  }

  return {
    id: 'remotion',
    async scaffold(videoDir) {
      // Everything the HyperFrames template put there goes; library media is downloaded after this step.
      rmSync(videoDir, { recursive: true, force: true })
      cpSync(template, videoDir, {
        recursive: true,
        filter: (src) => !src.includes(`${template}/node_modules`),
      })
      d.log('engine.scaffold', { files: readProject(videoDir).size })
      await install(videoDir)
    },
    async hydrate(videoDir) {
      const problems = restoredProblems(readProject(videoDir))
      if (problems.length) {
        d.log('engine.tampered', { problems })
        throw new StepError(`engine_tampered: ${problems[0]}`)
      }
      await install(videoDir)
    },
    install,
    skills,
    check: (videoDir) => checkProject(checkDeps(), videoDir),
    snapshot: (videoDir, atSec) => snapshotProject(checkDeps(), videoDir, atSec),
    entryProblems: (videoDir) =>
      existsSync(join(videoDir, 'props.json'))
        ? []
        : ['video/props.json does not exist. Write the props first.'],
    // Editing Remotion videos arrives in Phase 3: no contract yet, so a version is never editable.
    contract: () => null,
    async render(videoDir, out, quality, onProgress) {
      const deps = checkDeps()
      const { serveUrl } = await bundleFor(deps, videoDir)
      const api = d.remotion(videoDir)
      const license = licenseFor(d.root, process.env, d.log)
      const composition = await api.selectComposition({ serveUrl, id: 'main', inputProps: {}, ...license })
      const crf = QUALITY_CRF[quality] ?? QUALITY_CRF.standard
      const t = Date.now()
      // No envVariables: nothing from the deployment's environment reaches composition code (spikes E5).
      await api.renderMedia({
        composition,
        serveUrl,
        codec: 'h264',
        crf,
        inputProps: {},
        outputLocation: out,
        onProgress: ({ progress }: { progress: number }) => {
          onProgress(Math.floor(progress * 100))
        },
        ...license,
      })
      const renders = countRenders(videoDir, { video: 1 })
      d.log('engine.render', { ms: Date.now() - t, quality, crf, renders })
      return { renders }
    },
    version: () => REMOTION_VERSION,
  }
}

function findFile(dir: string, name: RegExp): string | null {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) {
      const hit = findFile(p, name)
      if (hit) return hit
    } else if (name.test(p)) return p
  }
  return null
}
