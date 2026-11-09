// The Remotion project rules (render-engines plan §5.1, §5.2; app/server/lib/remotion-project.ts), on the template's starter
// and one changed copy per rule, each with the message hydrate, check and finalize report.
import { describe, expect, it } from 'vitest'
import {
  generateRegistry,
  projectFileProblems,
  propsProblems,
  registryProblems,
} from '../server/lib/remotion-project.js'
import { templateFiles } from './remotion-files.js'

const enc = (s: string) => new TextEncoder().encode(s)
const starter = () => templateFiles()
const propsOf = (files: Map<string, Uint8Array>) =>
  JSON.parse(new TextDecoder().decode(files.get('props.json'))) as {
    beats: { id: string; [k: string]: unknown }[]
    layers: { id: string; label: string | null }[]
    [k: string]: unknown
  }
const withProps = (files: Map<string, Uint8Array>, props: object) => {
  files.set('props.json', enc(JSON.stringify(props)))
  return files
}

describe('Remotion project files', () => {
  it.each([
    ['package-lock.json'],
    ['remotion.config.ts'],
    ['src/Root.tsx'],
    ['src/index.ts'],
    ['src/va/Video.tsx'],
    ['AGENTS.md'],
  ])('refuses a changed %s', (path) => {
    const files = starter()
    files.set(path, enc(`${new TextDecoder().decode(files.get(path))}\n// changed`))
    expect(projectFileProblems(files)).toEqual([
      `${path} doesn't match the template; it must not be changed.`,
    ])
  })

  it('refuses a missing locked file', () => {
    const files = starter()
    files.delete('src/va/schema.ts')
    expect(projectFileProblems(files)).toEqual(['src/va/schema.ts is missing; it comes from the template.'])
  })

  it.each([
    ['babel.config.js'],
    ['postcss.config.js'],
    ['browserslist'],
    ['.browserslistrc'],
    ['webpack.config.js'],
    ['src/main.tsx'],
    ['src/va/extra.ts'],
    ['src/beats/nested/x.tsx'],
  ])('refuses %s, which the project may not have', (path) => {
    const files = starter()
    files.set(path, enc('x'))
    const problems = projectFileProblems(files)
    // A new src/va/ file is outside the allowed paths; it isn't a locked file, so it's reported once.
    expect(problems).toEqual([`${path} isn't allowed in a Remotion project.`])
  })

  it('refuses a HyperFrames entry point', () => {
    const files = starter()
    files.set('index.html', enc('<!doctype html>'))
    expect(projectFileProblems(files)).toEqual(['A Remotion project has no index.html.'])
  })

  it('allows the agent its data, components and assets', () => {
    const files = starter()
    files.set('src/beats/demo.tsx', enc('export default () => null'))
    files.set('src/layers/glow.tsx', enc('export default () => null'))
    files.set('assets/media/logo.svg', enc('<svg/>'))
    files.set('assets/fonts/inter.woff2', enc('wOF2'))
    expect(projectFileProblems(files)).toEqual([])
  })
})

describe('Remotion registry', () => {
  it('is deterministic and independent of props order', () => {
    const a = { beats: [{ id: 'intro' }, { id: 'demo-two' }], layers: [{ id: 'glow' }] }
    const b = { beats: [{ id: 'demo-two' }, { id: 'intro' }], layers: [{ id: 'glow' }] }
    expect(generateRegistry(a)).toBe(generateRegistry(b))
    expect(generateRegistry(a)).toContain("import BeatDemoTwo from './beats/demo-two'")
    expect(generateRegistry(a)).toContain(
      "export const layers: Record<string, ComponentType> = { 'glow': LayerGlow }",
    )
  })

  it('needs a file for every beat, an entry for every file, good ids and a current registry', () => {
    const files = starter()
    const props = propsOf(files)
    props.beats.push({ ...props.beats[0], id: 'demo' })
    withProps(files, props)
    expect(registryProblems(files, props)).toEqual([
      'src/beats/demo.tsx is missing for the beat "demo" in props.json.',
      "src/registry.ts doesn't match props.json; scripts/engine.ts check regenerates it.",
    ])
    files.set('src/beats/demo.tsx', enc('export default () => null'))
    files.set('src/registry.ts', enc(generateRegistry(props)))
    expect(registryProblems(files, props)).toEqual([])
    files.set('src/beats/orphan.tsx', enc('export default () => null'))
    expect(registryProblems(files, props)).toEqual([
      "src/beats/orphan.tsx has no entry in props.json's beats.",
    ])
    files.delete('src/beats/orphan.tsx')
    const bad = { ...props, beats: [...props.beats, { ...props.beats[0], id: 'Bad_Id' }] }
    expect(registryProblems(files, bad as typeof props)).toContain(
      'props.json: "Bad_Id" isn\'t a valid beat id (a-z, 0-9 and -).',
    )
  })
})

describe('props.json against the contract schema', () => {
  it('accepts the starter and refuses what the contract forbids', () => {
    const files = starter()
    expect(propsProblems(files.get('props.json'))).toEqual([])
    const props = propsOf(files)
    expect(propsProblems(JSON.stringify({ ...props, fps: 25 }))).toEqual(['props.json.fps must be 30.'])
    expect(propsProblems(JSON.stringify({ ...props, beats: undefined }))).toEqual([
      'props.json.beats is missing.',
    ])
    expect(propsProblems(JSON.stringify({ ...props, beats: [] }))).toEqual([
      'props.json.beats needs at least 1 item(s).',
    ])
    expect(propsProblems(JSON.stringify({ ...props, extra: 1 }))).toEqual([
      "props.json.extra isn't a known field.",
    ])
    const longBeat = { ...props.beats[0], duration: 121 }
    expect(propsProblems(JSON.stringify({ ...props, beats: [longBeat] }))).toEqual([
      'props.json.beats[0].duration must be at most 120.',
    ])
    const remote = {
      ...props.beats[0],
      media: { logo: { kind: 'image', src: 'https://example.com/x.png', fit: null, label: null } },
    }
    expect(propsProblems(JSON.stringify({ ...props, beats: [remote] }))).toEqual([
      "props.json.beats[0].media.logo.src isn't in the expected form.",
    ])
    expect(propsProblems('{ nope')).toEqual(['props.json is not valid JSON.'])
    expect(propsProblems(undefined)).toEqual(['props.json is missing.'])
  })
})
