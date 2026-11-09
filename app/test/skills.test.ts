import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildSkills, frontmatter, packageSkill, SITE_URL_TOKEN } from '../../scripts/lib/skills.js'
import { repoRoot } from '../../scripts/lib/run-tools.js'
import { apiKey, mcpCall, harness } from './helpers.js'

const skillsDir = join(repoRoot, 'skills')
const SITE = 'https://videos.example.com'
const tmp = mkdtempSync(join(tmpdir(), 'skills-test-'))
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

/** Unzips with the system unzip, the way people install it. */
function unzipped(bytes: Buffer, name: string) {
  const file = join(tmp, `${name}-${sha(bytes).slice(0, 8)}.zip`)
  writeFileSync(file, bytes)
  execFileSync('unzip', ['-tq', file])
  const list = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).trim().split('\n')
  const read = (path: string) => execFileSync('unzip', ['-p', file, path], { encoding: 'utf8' })
  return { list, read }
}

/** Every Markdown file of the skill, as written in the repo. */
const sources = () => {
  const out: [string, string][] = []
  const walk = (dir: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory()) walk(join(dir, d.name))
      else if (d.name.endsWith('.md')) out.push([join(dir, d.name), readFileSync(join(dir, d.name), 'utf8')])
    }
  }
  walk(join(skillsDir, 'create-video'))
  return out
}

describe('create-video skill package', () => {
  it('is byte-for-byte the same on every build, and differs only with the site URL', () => {
    const a = packageSkill(skillsDir, 'create-video', SITE).zip
    const b = packageSkill(skillsDir, 'create-video', `${SITE}/`).zip
    expect(sha(a)).toBe(sha(b))
    expect(sha(packageSkill(skillsDir, 'create-video', 'https://fork.example.org').zip)).not.toBe(sha(a))
  })

  it('unzips to one folder with SKILL.md (valid frontmatter) and the site URL filled in', () => {
    const { list, read } = unzipped(packageSkill(skillsDir, 'create-video', SITE).zip, 'pkg')
    expect(list).toEqual([
      'create-video/SKILL.md',
      'create-video/references/connect.md',
      'create-video/references/narration.md',
      'create-video/references/recipes.md',
      'create-video/references/sdk.md',
    ])
    const skill = read('create-video/SKILL.md')
    const meta = frontmatter(skill)
    expect(meta.name).toBe('create-video')
    expect(meta.name).toMatch(/^[a-z0-9-]{1,64}$/)
    expect(meta.description.length).toBeGreaterThan(50)
    expect(meta.description.length).toBeLessThanOrEqual(1024)
    expect(meta.description).toContain(SITE)
    expect(skill).toContain(`claude mcp add --transport http video-agent ${SITE}/mcp`)
    const connect = read('create-video/references/connect.md')
    expect(connect).toContain(`url = "${SITE}/mcp"`)
    expect(skill).toContain(`${SITE}/skills/video-agent-cli.zip`)
    expect(read('create-video/references/sdk.md')).toContain(`url: '${SITE}'`)
    for (const path of list) expect(read(path)).not.toContain(SITE_URL_TOKEN)
  })

  it('writes a zip per skill and an index.json with name, description, url, size and sha256', () => {
    const out = join(tmp, 'dist')
    const skills = buildSkills(skillsDir, out, `${SITE}/`)
    const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'))
    expect(index).toEqual({ skills })
    expect(skills).toEqual(
      ['create-video', 'video-agent-cli'].map((name) => {
        const zipBytes = readFileSync(join(out, `${name}.zip`))
        return {
          name,
          description: frontmatter(unzipped(zipBytes, `idx-${name}`).read(`${name}/SKILL.md`)).description,
          file: `${name}.zip`,
          url: `${SITE}/skills/${name}.zip`,
          bytes: zipBytes.length,
          sha256: sha(zipBytes),
        }
      }),
    )
    // A second build gives the same checksums.
    expect(buildSkills(skillsDir, join(tmp, 'dist2'), SITE).map((s) => s.sha256)).toEqual(
      skills.map((s) => s.sha256),
    )
  })

  it('mentions only tools and arguments the MCP server has', async () => {
    const h = harness()
    const { tools } = (await mcpCall(h, await apiKey(h, h.admin), 'tools/list', {})) as {
      tools: { name: string; inputSchema: unknown }[]
    }
    const toolNames = new Set(tools.map((t) => t.name))
    const args = new Set<string>()
    const collect = (schema: unknown) => {
      if (!schema || typeof schema !== 'object') return
      const s = schema as { properties?: Record<string, unknown>; items?: unknown }
      for (const [k, v] of Object.entries(s.properties ?? {})) {
        args.add(k)
        collect(v)
      }
      collect(s.items)
    }
    for (const t of tools) collect(t.inputSchema)
    // Result fields the skill names (from get_video and list_comments results).
    const resultFields = new Set(['web_url', 'resolved_at', 'addressed_in', 'next_actions', 'redid_scenes'])

    const mentioned = new Set<string>()
    for (const [file, text] of sources()) {
      const prose = text.replace(/```[\s\S]*?```/g, '')
      for (const m of prose.matchAll(/`([^`\n]+)`/g)) {
        const token = m[1] ?? ''
        if (!/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(token)) continue
        mentioned.add(token)
        expect(
          toolNames.has(token) || args.has(token) || resultFields.has(token),
          `${file}: \`${token}\` is not a tool, argument or result field`,
        ).toBe(true)
      }
    }
    // The skill covers every tool.
    for (const name of toolNames) expect(mentioned, `the skill never mentions ${name}`).toContain(name)
  })

  it('the CLI skill unzips with its generated command list and the site URL filled in', () => {
    const { list, read } = unzipped(packageSkill(skillsDir, 'video-agent-cli', SITE).zip, 'cli')
    expect(list).toEqual(['video-agent-cli/SKILL.md', 'video-agent-cli/references/commands.md'])
    const meta = frontmatter(read('video-agent-cli/SKILL.md'))
    expect(meta.name).toBe('video-agent-cli')
    expect(meta.description).toContain(SITE)
    expect(read('video-agent-cli/references/commands.md')).toContain(`video-agent login --url ${SITE}`)
    for (const path of list) expect(read(path)).not.toContain(SITE_URL_TOKEN)
  })

  it('never tells agents to use the PR URL as a long-lived idempotency key', () => {
    // A key is body-bound for 24 hours, so one video per PR comes from a list_videos lookup instead.
    for (const [file, text] of sources()) {
      expect(text.replace(/\s+/g, ' '), file).not.toMatch(/Use the PR URL as the `?idempotency_key/i)
    }
    const recipes = sources().find(([file]) => file.endsWith('recipes.md'))?.[1] ?? ''
    expect(recipes).toContain("Look for the PR's video first")
  })
})
