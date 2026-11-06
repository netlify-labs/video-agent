// One license notice everywhere (render-engines plan §7): the Admin dialog and GET /api/v1/engines use the same text,
// the README quotes it, and the Deploy button never asks for the Remotion settings.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REMOTION_LICENSE_NOTICE } from '../src/lib/remotion-notice.js'
import { harness } from './helpers.js'

const root = join(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

describe('the Remotion license notice', () => {
  it('the Admin dialog and the engines list use the one notice', async () => {
    expect(read('ui/src/pages/Admin.tsx')).toMatch(
      /import \{[^}]*REMOTION_LICENSE_NOTICE[^}]*\} from '..\/..\/..\/src\/lib\/remotion-notice'/,
    )
    const h = harness({ ENGINES: 'remotion' })
    const list = (await h.json(await h.call('GET', '/api/v1/engines', { as: h.member }))).items as {
      notice: string | null
    }[]
    expect(list.at(-1)?.notice).toBe(REMOTION_LICENSE_NOTICE)
  })

  it('the README quotes it', () => {
    const first = REMOTION_LICENSE_NOTICE.split('. ')[0] ?? ''
    expect(read('README.md').replace(/\n> /g, ' ')).toContain(first)
  })

  it("the Deploy button's environment doesn't ask for any engine setting", () => {
    const toml = read('netlify.toml')
    const section = /\[template\.environment\]\n([\s\S]*?)(?:\n\s*\n|\n\[)/.exec(toml)?.[1] ?? ''
    const keys = section
      .split('\n')
      .map((l) => /^\s*([A-Z_]+)\s*=/.exec(l)?.[1])
      .filter(Boolean)
    expect(keys).toEqual(['RUNNER_API_TOKEN', 'ALLOWED_EMAIL_DOMAINS', 'ADMIN_EMAILS'])
  })
})
