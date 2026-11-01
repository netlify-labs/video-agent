// Packages skills/<name>/ as installable Agent Skills: one zip per skill with a single top-level <name>/ folder, plus
// an index.json. {{SITE_URL}} in the sources becomes this deployment's URL, so every fork serves skills that point
// at itself. The zips are deterministic (see zip.ts): the same sources and URL give the same sha256.
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { zip, type ZipEntry } from './zip.js'

export const SITE_URL_TOKEN = '{{SITE_URL}}'

export interface SkillIndexEntry {
  name: string
  description: string
  file: string
  url: string
  bytes: number
  sha256: string
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.name.startsWith('.') ? [] : d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)],
  )
}

/** The name and description from SKILL.md's YAML frontmatter (single-line values only). */
export function frontmatter(text: string): { name: string; description: string } {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!m?.[1]) throw new Error('SKILL.md has no frontmatter')
  const field = (key: string) => {
    const v = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(m[1] ?? '')?.[1]?.trim()
    if (!v) throw new Error(`SKILL.md frontmatter has no ${key}`)
    return v.replace(/^(["'])(.*)\1$/, '$2')
  }
  return { name: field('name'), description: field('description') }
}

/** One skill's zip, with the site URL filled in. */
export function packageSkill(skillsDir: string, name: string, siteUrl: string) {
  const dir = join(skillsDir, name)
  const site = siteUrl.replace(/\/$/, '')
  const entries: ZipEntry[] = walk(dir).map((file) => {
    const raw = readFileSync(file)
    const data = file.endsWith('.md')
      ? Buffer.from(raw.toString('utf8').replaceAll(SITE_URL_TOKEN, site))
      : raw
    return { path: `${name}/${relative(dir, file).split('\\').join('/')}`, data }
  })
  const skill = entries.find((e) => e.path === `${name}/SKILL.md`)
  if (!skill) throw new Error(`skills/${name} has no SKILL.md`)
  const meta = frontmatter(skill.data.toString('utf8'))
  if (meta.name !== name) throw new Error(`skills/${name}/SKILL.md is named "${meta.name}"`)
  return { ...meta, zip: zip(entries) }
}

/** Writes <outDir>/<name>.zip for every skill and <outDir>/index.json; returns the index. */
export function buildSkills(skillsDir: string, outDir: string, siteUrl: string): SkillIndexEntry[] {
  const site = siteUrl.replace(/\/$/, '')
  const names = readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort()
  mkdirSync(outDir, { recursive: true })
  const skills = names.map((name) => {
    const { description, zip: bytes } = packageSkill(skillsDir, name, site)
    const file = `${name}.zip`
    writeFileSync(join(outDir, file), bytes)
    return {
      name,
      description,
      file,
      url: `${site}/skills/${file}`,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  })
  writeFileSync(join(outDir, 'index.json'), `${JSON.stringify({ skills }, null, 2)}\n`)
  return skills
}
