// The HyperFrames pin (plan 2026-11-04-looks §4.5, task 1.1): the registry every run uses is the tag of the pinned CLI,
// not main, so "use grain-overlay" resolves to the same source every day. The CLI version lives in four places; they
// move together.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const json = (p: string) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'))

interface Pins {
  pkg: {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    netlifyAgent: { hyperframes: { version: string } }
  }
  videoPkg: { scripts: Record<string, string> }
  hyperframes: { registry: string }
}

/** Every way the four pins disagree, in words that say what to do. */
function pinProblems({ pkg, videoPkg, hyperframes }: Pins): string[] {
  const v = pkg.netlifyAgent.hyperframes.version
  const bump = `bump package.json netlifyAgent.hyperframes.version, the hyperframes dependency, video/package.json's npx pins and video/hyperframes.json's registry tag together`
  const out: string[] = []
  const dep = pkg.devDependencies?.hyperframes ?? pkg.dependencies?.hyperframes
  if (dep !== v) out.push(`package.json hyperframes dependency is ${dep}, not ${v}: ${bump}`)
  const tagUrl = `https://raw.githubusercontent.com/heygen-com/hyperframes/v${v}/registry`
  if (hyperframes.registry !== tagUrl)
    out.push(`video/hyperframes.json registry is ${hyperframes.registry}, not ${tagUrl}: ${bump}`)
  for (const [name, script] of Object.entries(videoPkg.scripts))
    for (const m of script.matchAll(/hyperframes@(\S+)/g))
      if (m[1] !== v)
        out.push(`video/package.json script ${name} runs hyperframes@${m[1]}, not ${v}: ${bump}`)
  return out
}

const actual = (): Pins => ({
  pkg: json('package.json'),
  videoPkg: json('video/package.json'),
  hyperframes: json('video/hyperframes.json'),
})

describe('HyperFrames pin', () => {
  it('pins the registry to the CLI tag, and every pin agrees', () => {
    expect(actual().hyperframes.registry).toMatch(/\/v\d+\.\d+\.\d+\/registry$/)
    expect(pinProblems(actual())).toEqual([])
  })

  it('fails when any one pin moves alone', () => {
    const a = actual()
    const v = a.pkg.netlifyAgent.hyperframes.version
    const moved = (f: (p: Pins) => void) => {
      const copy = structuredClone(a)
      f(copy)
      return pinProblems(copy)
    }
    expect(moved((p) => (p.pkg.netlifyAgent.hyperframes.version = '9.9.9')).length).toBeGreaterThan(0)
    expect(moved((p) => (p.pkg.devDependencies!.hyperframes = '9.9.9'))).toHaveLength(1)
    expect(
      moved((p) => (p.hyperframes.registry = p.hyperframes.registry.replace(`v${v}`, 'main'))),
    ).toHaveLength(1)
    expect(moved((p) => (p.videoPkg.scripts.check = 'npx --yes hyperframes@9.9.9 check'))).toHaveLength(1)
  })
})
