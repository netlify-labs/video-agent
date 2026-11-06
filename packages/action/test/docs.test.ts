// The action's docs (bead va-mg4i.5.1): the example workflows parse, pin a full commit SHA with the tag in a comment,
// and use only inputs the action has; action.yml's status description lists exactly OUTPUT_STATUSES; and no doc in
// the repo tells anyone to run `npx video-agent` (a stranger's package).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { EXAMPLES, PIN } from '../src/examples.js'
import { COMMANDS, INPUTS, OUTPUT_STATUSES, OUTPUTS } from '../src/spec.js'

const root = new URL('../../../', import.meta.url)
const INPUT_NAMES = new Set<string>(INPUTS.map((i) => i.name))

interface Step {
  uses?: string
  with?: Record<string, unknown>
}
interface Workflow {
  on: unknown
  permissions?: Record<string, string>
  jobs: Record<string, { 'runs-on': string; steps: Step[] }>
}

describe('example workflows', () => {
  it('PIN is a full commit SHA and an action-v tag', () => {
    expect(PIN.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(PIN.tag).toMatch(/^action-v\d+\.\d+\.\d+$/)
  })

  for (const e of EXAMPLES) {
    it(`${e.id}: parses, pins the SHA with the tag, sets permissions, and uses known inputs`, () => {
      const wf = parse(e.yaml) as Workflow
      expect(wf.on, e.id).toBeTruthy()
      expect(Object.keys(wf.permissions ?? {}), e.id).not.toHaveLength(0)
      // Least privilege: never issues: write (spike A3), contents: write only where a release is edited.
      expect(wf.permissions?.issues, e.id).toBeUndefined()
      if (wf.permissions?.contents === 'write') expect(e.yaml, e.id).toMatch(/release/)
      const ours = Object.values(wf.jobs)
        .flatMap((j) => j.steps)
        .filter((s) => s.uses?.startsWith('netlify-labs/video-agent/packages/action@'))
      expect(ours, e.id).toHaveLength(1)
      const line =
        e.yaml.split('\n').find((l) => l.includes('netlify-labs/video-agent/packages/action@')) ?? ''
      expect(line, e.id).toMatch(/packages\/action@[0-9a-f]{40} # action-v\d+\.\d+\.\d+$/)
      for (const name of Object.keys(ours[0]?.with ?? {}))
        expect(INPUT_NAMES, `${e.id}: ${name}`).toContain(name)
      // url is a variable, never a secret; the key is a secret.
      expect(ours[0]?.with?.url, e.id).toBe('${{ vars.VIDEO_AGENT_URL }}')
      expect(ours[0]?.with?.['api-key'], e.id).toBe('${{ secrets.VIDEO_AGENT_KEY }}')
    })
  }
})

describe('outputs', () => {
  it('the status description lists exactly the values the action sets', () => {
    const status = OUTPUTS.find((o) => o.name === 'status')?.description ?? ''
    const listed = status.replace(/\.$/, '').split(/, | or /)
    expect(listed.sort()).toEqual([...OUTPUT_STATUSES].sort())
    const yml = readFileSync(new URL('packages/action/action.yml', root), 'utf8')
    expect(yml).toContain(status)
  })
})

describe('README', () => {
  const readme = () => readFileSync(new URL('packages/action/README.md', root), 'utf8')
  /** A table cell back to plain text: GitHub needs \| and &lt; &gt; inside cells. */
  const plain = (s: string) => s.replace(/\\\|/g, '|').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  const cells = (line: string) =>
    line
      .split(/(?<!\\)\|/)
      .slice(1, -1)
      .map((c) => plain(c.trim()))
  /** The rows of the table whose header cells are `header` (Prettier pads tables, so cells are compared trimmed). */
  const rows = (md: string, header: string[]) => {
    const lines = md.split('\n')
    const start = lines.findIndex((l) => l.startsWith('|') && cells(l).join('|') === header.join('|'))
    expect(start, header.join(' | ')).toBeGreaterThan(-1)
    const out = new Map<string, string[]>()
    for (const line of lines.slice(start + 2)) {
      if (!line.startsWith('| `')) break
      const [name, ...rest] = cells(line)
      out.set(name?.replace(/`/g, '') ?? '', rest)
    }
    return out
  }

  it('carries every example workflow as it is', () => {
    for (const e of EXAMPLES) expect(readme(), e.id).toContain('```yaml\n' + e.yaml + '```')
  })

  it('every action line pins the full SHA with the tag', () => {
    const lines = readme()
      .split('\n')
      .filter((l) => l.includes('netlify-labs/video-agent/packages/action@'))
    expect(lines.length).toBeGreaterThan(EXAMPLES.length)
    for (const l of lines) expect(l).toMatch(/packages\/action@[0-9a-f]{40} # action-v\d+\.\d+\.\d+$/)
  })

  it('its input and output tables match spec.ts', () => {
    const md = readme()
    const inputs = rows(md, ['Input', 'What it does', 'Default'])
    expect([...inputs.keys()]).toEqual(INPUTS.map((i) => i.name))
    for (const i of INPUTS as readonly { name: string; description: string; default?: string }[]) {
      const [description, def] = inputs.get(i.name) ?? []
      expect(description, i.name).toBe(i.description)
      expect(def, i.name).toBe(i.default ? `\`${i.default}\`` : '')
    }
    const outputs = rows(md, ['Output', 'What it is'])
    expect([...outputs.keys()]).toEqual(OUTPUTS.map((o) => o.name))
    for (const o of OUTPUTS) expect(outputs.get(o.name)?.[0], o.name).toBe(o.description)
  })

  it('lists every status value and every command', () => {
    const md = readme()
    for (const s of OUTPUT_STATUSES) expect(md, s).toContain(`\`${s}\``)
    for (const c of COMMANDS) expect(md, c).toContain(`\`${c}\``)
  })
})

describe('package names', () => {
  it('no doc says npx video-agent', () => {
    // Docs people read: READMEs, the app's pages, the skills and the action. Plans and beads discuss the name itself.
    const files = execFileSync(
      'git',
      ['ls-files', '*.md', '*.tsx', '*.ts', '*.yml', ':!docs/plans/**', ':!.beads/**', ':!**/*.test.ts'],
      { cwd: root, encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean)
    const hits = files.filter((f) => /npx (-y )?video-agent\b/.test(readFileSync(new URL(f, root), 'utf8')))
    expect(hits).toEqual([])
  })
})
