// The Remotion run engine's set-up (render-engines plan §5.1, §8), with no Remotion installed: npm, npx and the skills
// download are stubbed, the template is the real one.
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tarGz, type Entry } from '../../../test/tarball.js'
import { readProject, remotionEngine, SKILLS } from './remotion.js'

const repo = join(import.meta.dirname, '..', '..', '..')
const COMMIT = 'f'.repeat(40)
const ALL_SKILLS = [...SKILLS.names, 'remotion-maps', 'remotion-studio', 'remotion-docs', 'remotion-saas']

/** A root with the real template and a video/ holding a HyperFrames starter. */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'va-remotion-'))
  cpSync(join(repo, 'engines', 'remotion', 'template'), join(root, 'engines', 'remotion', 'template'), {
    recursive: true,
    filter: (src) => !src.includes('node_modules'),
  })
  const video = join(root, 'video')
  mkdirSync(join(video, 'vendor'), { recursive: true })
  for (const f of [
    'index.html',
    'hyperframes.json',
    'meta.json',
    'package.json',
    'summary.json',
    'AGENTS.md',
    'vendor/gsap.min.js',
  ])
    writeFileSync(join(video, f), 'hyperframes')
  return { root, video }
}

function skillsTarball(extra: Entry[] = []) {
  const gz = tarGz([
    ...ALL_SKILLS.flatMap((name) => [
      { name: `skills-${COMMIT}/skills/${name}/SKILL.md`, body: `# ${name}` },
      { name: `skills-${COMMIT}/skills/${name}/rules/a.md`, body: 'rule' },
    ]),
    { name: `skills-${COMMIT}/README.md`, body: 'readme' },
    ...extra,
  ])
  return { gz, pin: { commit: COMMIT, sha256: createHash('sha256').update(gz).digest('hex') } }
}

function engine(root: string, opts: Partial<Parameters<typeof remotionEngine>[0]> = {}) {
  const calls: string[] = []
  const logs: { step: string; fields: Record<string, unknown> }[] = []
  const { gz, pin } = skillsTarball()
  const e = remotionEngine({
    root,
    run: (cmd, args) => {
      calls.push([cmd, ...args].join(' '))
      return Promise.resolve('')
    },
    fetch: () => Promise.resolve(gz),
    log: (step, fields = {}) => logs.push({ step, fields }),
    skillsPin: pin,
    ...opts,
  })
  return { e, calls, logs }
}

afterEach(() => vi.useRealTimers())

describe('Remotion scaffold', () => {
  it('replaces the HyperFrames starter with exactly the template, then installs', async () => {
    const { root, video } = workspace()
    const { e, calls, logs } = engine(root)
    await e.scaffold?.(video)
    const template = readProject(join(root, 'engines', 'remotion', 'template'))
    expect([...readProject(video).keys()].sort()).toEqual([...template.keys()].sort())
    expect(existsSync(join(video, 'index.html'))).toBe(false)
    expect(calls).toEqual(['npm ci --ignore-scripts --no-audit --no-fund', 'npx remotion browser ensure'])
    expect(
      logs.filter((l) => l.step === 'engine.install.step').map((l) => [l.fields.name, l.fields.ok]),
    ).toEqual([
      ['npm ci', true],
      ['browser ensure', true],
      ['skills', true],
    ])
  })

  it('installs only the four pinned skills, into both agents’ folders', async () => {
    const { root, video } = workspace()
    const { e } = engine(root)
    await e.scaffold?.(video)
    for (const dest of ['.agents/skills', '.claude/skills'])
      expect(readdirSync(join(root, dest)).sort()).toEqual([...SKILLS.names].sort())
    expect(existsSync(join(root, '.claude/skills/remotion-render/rules/a.md'))).toBe(true)
  })

  it('adds remotion-maps when the look asks for it', async () => {
    const { root } = workspace()
    const { e } = engine(root, { extraSkills: [SKILLS.maps] })
    expect((await e.skills()).sort()).toEqual([...SKILLS.names, 'remotion-maps'].sort())
  })
})

describe('Remotion hydrate', () => {
  /** A restored project: what a finished run archived, which is the template plus the agent's own files. */
  function restored() {
    const { root } = workspace()
    const video = join(root, 'restored')
    cpSync(join(root, 'engines', 'remotion', 'template'), video, { recursive: true })
    return { root, video }
  }

  it('installs a project that passes the rules', async () => {
    const { root, video } = restored()
    const { e, calls } = engine(root)
    await e.hydrate?.(video)
    expect(calls).toHaveLength(2)
  })

  it.each([
    ['src/Root.tsx', "src/Root.tsx doesn't match the template; it must not be changed."],
    ['package-lock.json', "package-lock.json doesn't match the template; it must not be changed."],
    ['babel.config.js', "babel.config.js isn't allowed in a Remotion project."],
    ['postcss.config.js', "postcss.config.js isn't allowed in a Remotion project."],
    ['browserslist', "browserslist isn't allowed in a Remotion project."],
    ['src/main.tsx', "src/main.tsx isn't allowed in a Remotion project."],
  ])('refuses a project with %s changed or added, before running anything', async (path, message) => {
    const { root, video } = restored()
    writeFileSync(join(video, path), 'module.exports = {}\n// changed')
    const { e, calls, logs } = engine(root)
    await expect(e.hydrate?.(video)).rejects.toThrow(`engine_tampered: ${message}`)
    expect(calls).toEqual([])
    expect(logs.find((l) => l.step === 'engine.tampered')?.fields.problems).toContain(message)
  })
})

describe('Remotion install failures', () => {
  it('a step that never ends fails with engine_install_failed when its time is up', async () => {
    vi.useFakeTimers()
    const { root, video } = workspace()
    const { e, logs } = engine(root, { run: () => new Promise<string>(() => {}), timeoutMs: 180_000 })
    const done = e.install(video).catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(180_000)
    expect(String(await done)).toContain('engine_install_failed: npm ci timed out after 180 s')
    expect(logs.at(-1)?.fields).toMatchObject({ name: 'npm ci', ok: false, code: 'engine_install_failed' })
  })

  it('a failing npm ci fails with engine_install_failed and its output', async () => {
    const { root, video } = workspace()
    const { e } = engine(root, {
      run: () => Promise.reject(new Error('npm ci failed (exit 1): EINTEGRITY sha512')),
    })
    await expect(e.install(video)).rejects.toThrow(
      /^engine_install_failed: npm ci failed \(exit 1\): EINTEGRITY/,
    )
  })

  it('a skills archive that doesn’t match its pin fails with engine_skills_unavailable', async () => {
    const { root } = workspace()
    const { e } = engine(root, { skillsPin: { commit: COMMIT, sha256: '0'.repeat(64) } })
    await expect(e.skills()).rejects.toThrow(
      "engine_skills_unavailable: the skills archive doesn't match its pinned hash.",
    )
  })

  it('refuses an archive entry that climbs out with ../', async () => {
    const { root } = workspace()
    const { gz, pin } = skillsTarball([{ name: `skills-${COMMIT}/skills/../../evil.sh`, body: 'x' }])
    const { e } = engine(root, { fetch: () => Promise.resolve(gz), skillsPin: pin })
    await expect(e.skills()).rejects.toThrow(/^engine_skills_unavailable: Unsafe path/)
    expect(existsSync(join(root, 'evil.sh'))).toBe(false)
  })

  it('a download that fails is engine_skills_unavailable', async () => {
    const { root } = workspace()
    const { e } = engine(root, { fetch: () => Promise.reject(new Error('HTTP 503')) })
    await expect(e.skills()).rejects.toThrow(
      'engine_skills_unavailable: the skills download failed (HTTP 503).',
    )
  })
})

describe('Remotion engine basics', () => {
  it('needs props.json and has no editing contract yet', () => {
    const { root, video } = workspace()
    const { e } = engine(root)
    expect(e.entryProblems(video)).toEqual(['video/props.json does not exist. Write the props first.'])
    expect(e.contract(video)).toBeNull()
    expect(e.version(video)).toBe('4.0.540')
  })
})
