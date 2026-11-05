// The action's docs (bead va-mg4i.5.1): the example workflows parse, pin a full commit SHA with the tag in a comment,
// and use only inputs the action has; action.yml's status description lists exactly OUTPUT_STATUSES; and no doc in
// the repo tells anyone to run `npx video-agent` (a stranger's package).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { EXAMPLES, PIN } from '../src/examples.js'
import { INPUTS, OUTPUT_STATUSES, OUTPUTS } from '../src/spec.js'

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
