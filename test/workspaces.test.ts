// The packages/ workspaces stay cheap for runners, which npm install at the root (cli-and-sdk plan §3, gotcha 18):
// no package has devDependencies (everything is hoisted to the root), and the SDK and player have no dependencies.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../scripts/lib/run-tools.js'

type Pkg = {
  name: string
  private?: boolean
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  engines?: Record<string, string>
  workspaces?: string[]
}
const read = (p: string) => JSON.parse(readFileSync(join(repoRoot, p), 'utf8')) as Pkg
const pkgs = Object.fromEntries(
  readdirSync(join(repoRoot, 'packages')).map((d) => [d, read(`packages/${d}/package.json`)]),
)

describe('workspaces', () => {
  it('the root is the private app with packages/* as workspaces', () => {
    const root = read('package.json')
    expect(root.private).toBe(true)
    expect(root.workspaces).toEqual(['packages/*'])
  })

  it('has the unscoped public packages and the private action', () => {
    expect(
      Object.fromEntries(Object.entries(pkgs).map(([d, p]) => [d, [p.name, p.private ?? false]])),
    ).toEqual({
      action: ['video-agent-action', true],
      cli: ['netlify-video-agent', false],
      player: ['netlify-video-agent-player', false],
      sdk: ['netlify-video-agent-sdk', false],
    })
  })

  it('no package has devDependencies; the SDK and player have no dependencies', () => {
    for (const [d, p] of Object.entries(pkgs)) expect(p.devDependencies, d).toBeUndefined()
    expect(pkgs.sdk?.dependencies).toBeUndefined()
    expect(pkgs.player?.dependencies).toBeUndefined()
  })

  it('the SDK and CLI support Node 22 and up', () => {
    expect(pkgs.sdk?.engines?.node).toBe('>=22')
    expect(pkgs.cli?.engines?.node).toBe('>=22')
  })
})
