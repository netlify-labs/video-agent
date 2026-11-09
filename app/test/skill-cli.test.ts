// The skill's CLI reference (bead va-p1th.7.5) is generated from the CLI catalog: it must match it exactly, list every
// ready command and only those, and every exit code.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { COMMANDS } from '../../packages/cli/src/catalog.js'
import { EXIT } from '../../packages/cli/src/exit.js'
import { CLI_MD, renderCliMd } from '../../scripts/gen-skill-cli.js'

describe('app/skills/netlify-video/references/cli.md', () => {
  it('matches the catalog (run npx tsx scripts/gen-skill-cli.ts after changing a command)', async () => {
    expect(readFileSync(CLI_MD, 'utf8')).toBe(await renderCliMd())
  })

  it('lists the ready commands and no others, and every exit code', async () => {
    const md = await renderCliMd()
    const listed = [...md.matchAll(/^### (.+)$/gm)].map((m) => m[1])
    const ready = COMMANDS.filter((c) => c.ready && !['help', 'version'].includes(c.name)).map((c) => c.name)
    expect(listed).toEqual(ready)
    for (const code of Object.values(EXIT)) expect(md).toMatch(new RegExp(`^\\| ${code} +\\|`, 'm'))
    if (!ready.includes('local')) expect(md).not.toContain('video-agent local')
  })
})
