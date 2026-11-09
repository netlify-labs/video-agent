// The Remotion template (render-engines plan §5.1) as the service sees it, with no Remotion installed: the generated
// lock of template-owned files is current, the root never depends on Remotion, the package set is pinned, and the
// starter project passes the project rules.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LOCKED_FILES,
  projectFileProblems,
  propsProblems,
  registryProblems,
} from '../server/lib/remotion-project.js'
import { template, templateFiles } from './remotion-files.js'

const root = join(import.meta.dirname, '..', '..')

describe('the Remotion template', () => {
  it('app/server/lib/remotion-locked.json, the props schema and the starter registry are current', () => {
    expect(() =>
      execFileSync('npx', ['tsx', 'scripts/gen-remotion-locked.ts', '--check'], { cwd: root, stdio: 'pipe' }),
    ).not.toThrow()
  })

  it('locks the wiring, the package set, the va/ runtime and AGENTS.md', () => {
    expect(Object.keys(LOCKED_FILES)).toEqual(
      expect.arrayContaining([
        'AGENTS.md',
        'package.json',
        'package-lock.json',
        'remotion.config.ts',
        'tsconfig.json',
        'src/index.ts',
        'src/Root.tsx',
        'src/va/schema.ts',
        'src/va/Video.tsx',
      ]),
    )
    expect(Object.keys(LOCKED_FILES)).not.toContain('props.json')
  })

  it('the root never depends on Remotion', () => {
    for (const f of ['package.json', 'package-lock.json']) {
      const text = readFileSync(join(root, f), 'utf8')
      expect(text, f).not.toMatch(/"(node_modules\/)?(remotion|@remotion\/[a-z0-9-]+)"\s*:/)
    }
  })

  it('pins every package exactly, the Linux compositor included', () => {
    const pkg = JSON.parse(readFileSync(join(template, 'package.json'), 'utf8')) as Record<
      string,
      Record<string, string>
    >
    const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies }
    for (const [name, v] of Object.entries(all)) expect(v, name).toMatch(/^\d+\.\d+\.\d+$/)
    expect(all['@remotion/compositor-linux-x64-gnu']).toBe(all.remotion)
    // Remotion 4.0.540's CLI requires zod 4.6.7 (spikes E5).
    expect(all.zod).toBe('4.6.7')
    expect(Object.keys(pkg.scripts ?? {})).toEqual([])
  })

  it('the starter project passes the project rules', () => {
    const files = templateFiles()
    const props = JSON.parse(new TextDecoder().decode(files.get('props.json'))) as Parameters<
      typeof registryProblems
    >[1]
    expect(projectFileProblems(files)).toEqual([])
    expect(propsProblems(files.get('props.json'))).toEqual([])
    expect(registryProblems(files, props)).toEqual([])
  })

  it('lint and format skip the template (its own tsc checks it)', () => {
    expect(readFileSync(join(root, '.config', 'eslint.config.js'), 'utf8')).toContain("'app/engines/remotion'")
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: { format: string } }
    expect(pkg.scripts.format).toContain("'!app/engines/remotion'")
  })
})
