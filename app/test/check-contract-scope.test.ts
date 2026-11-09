// check-contract --fix (redo a scene, plan §4.9): with a scope in the run manifest it writes the splice, says what it
// put back and exits 1 until clean; without one it does what --duck always did.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { checkContract, fixFlag } from '../../scripts/lib/check-contract.js'
import { applyDucking, attr, editText, load, save, walk, type Doc } from '../server/lib/contract.js'
import { spliceBytes, spliceScoped } from '../server/lib/scope.js'

const music = save(
  load(readFileSync(new URL('./fixtures/contract1-music/index.html', import.meta.url), 'utf8')),
)
const summary = { title: 'Org webhooks', summary: 'The parent.', captions: [] }

function write(root: string, files: Record<string, string>) {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true })
    writeFileSync(join(root, p), body)
  }
}
/** A run workspace: the manifest with a scope on "demo", the frozen parent, and video/ as the agent left it. */
function workspace(agentHtml: string, { scope = true, frozen = true, extra = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'va-check-'))
  const parent = { 'index.html': music, 'summary.json': JSON.stringify(summary), 'assets/logo.svg': '<svg/>' }
  write(root, {
    '.render/run-manifest.json': JSON.stringify(
      scope ? { v: 1, scope: { beats: ['demo'], stills: [] } } : { v: 1 },
    ),
    ...(frozen ? Object.fromEntries(Object.entries(parent).map(([p, b]) => [`.render/frozen/${p}`, b])) : {}),
    ...Object.fromEntries(
      Object.entries({ ...parent, 'index.html': agentHtml, ...extra }).map(([p, b]) => [`video/${p}`, b]),
    ),
  })
  return root
}
const edit = (f: (d: Doc) => void) => {
  const d = load(music)
  f(d)
  return save(d)
}
const beat = (d: Doc, id: string) => [...walk(d.root)].find((e) => attr(e, 'data-va-beat') === id)!
const setAttr = (d: Doc, id: string, name: string, value: string) => {
  beat(d, id).attrs.find((a) => a.name === name)!.value = value
}
const redo = (d: Doc) =>
  editText(
    [...walk(d.root)].find((e) => attr(e, 'data-va-text') === 'demo-sub')!,
    'Ship on Friday',
  )

describe('check-contract --fix with a scope', () => {
  it('re-lays stale derived values in one run and says OK', () => {
    const agent = edit((d) => {
      redo(d)
      setAttr(d, 'demo', 'data-duration', '5') // later scenes left where they were
    })
    const root = workspace(agent)
    const r = checkContract(root, { fix: true })
    expect(r).toEqual({
      lines: ['Re-laid the scenes and synced the captions and ducking.', 'Contract v1: OK (scope: demo)'],
      code: 0,
    })
    const want = spliceBytes(
      spliceScoped({
        parent: { html: music, summary },
        agent: { html: agent, summary },
        beats: ['demo'],
        lockedLength: false,
      }),
    )
    expect(readFileSync(join(root, 'video/index.html'), 'utf8')).toBe(want['index.html'])
    expect(checkContract(root, { fix: true })).toEqual({ lines: ['Contract v1: OK (scope: demo)'], code: 0 })
  })

  it('puts back a change outside the scope, says so, and is clean on the next run', () => {
    const agent = edit((d) => {
      redo(d)
      editText(
        [...walk(d.root)].find((e) => attr(e, 'data-va-text') === 'intro-title')!,
        'Org hooks',
      )
    })
    const root = workspace(agent)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let first
    let logs: { step: string; what?: string }[]
    try {
      first = checkContract(root, { fix: true })
      logs = spy.mock.calls.map((c) => JSON.parse(String(c[0])) as { step: string; what?: string })
    } finally {
      spy.mockRestore()
    }
    expect(first.code).toBe(1)
    expect(first.lines[0]).toBe('Put back: Scene "Opening" changed (its headline text).')
    expect(logs.find((l) => l.step === 'scope.put_back')?.what).toBe(
      'Scene "Opening" changed (its headline text).',
    )
    expect(readFileSync(join(root, 'video/index.html'), 'utf8')).toContain('Org webhooks')
    expect(checkContract(root, { fix: true }).code).toBe(0)
  })

  it('without --fix reports the same and writes nothing', () => {
    const agent = edit((d) => {
      redo(d)
      editText(
        [...walk(d.root)].find((e) => attr(e, 'data-va-text') === 'intro-title')!,
        'Org hooks',
      )
    })
    const root = workspace(agent)
    expect(checkContract(root, { fix: false })).toEqual({
      lines: [
        '- Scene "Opening" changed (its headline text). (npx tsx scripts/check-contract.ts --fix puts it back)',
      ],
      code: 1,
    })
    expect(readFileSync(join(root, 'video/index.html'), 'utf8')).toBe(agent)
  })

  it("can't fix a changed file the other scenes use, or a selector string in the redone scene", () => {
    const root = workspace(edit(redo), { extra: { 'assets/logo.svg': '<svg id="x"/>' } })
    for (let n = 0; n < 2; n++)
      expect(checkContract(root, { fix: true })).toEqual({
        lines: ['- assets/logo.svg changed; files the other scenes use must stay as they are.'],
        code: 1,
      })
    const gsap = edit((d) => {
      redo(d)
      const script = [...walk(beat(d, 'demo'))].find((e) => e.tagName === 'script')!
      editText(script, "vaBeat('demo', (tl, el) => { tl.from('.sub', { opacity: 0 }) })")
    })
    const r = checkContract(workspace(gsap), { fix: true })
    expect(r.code).toBe(1)
    expect(r.lines.join('\n')).toMatch(/uses a selector string in tl\.from/)
  })

  it('stops when the frozen copy is missing', () => {
    expect(checkContract(workspace(edit(redo), { frozen: false }), { fix: true })).toEqual({
      lines: ['The frozen copy of the parent is missing (prepare-run makes it). Stop and report this.'],
      code: 1,
    })
  })
})

describe('check-contract without a scope', () => {
  it('--fix rewrites the ducking lane as --duck did, then validates', () => {
    const stale = edit((d) => {
      const m = [...walk(d.root)].find((e) => attr(e, 'data-va-layer') === 'music')!
      m.attrs = m.attrs.filter((a) => a.name !== 'data-automation')
    })
    const root = workspace(stale, { scope: false })
    const r = checkContract(root, { fix: true })
    const d = load(stale)
    applyDucking(d)
    const ducked = save(d)
    expect(r.lines).toEqual([
      ...(ducked !== stale ? ["Rewrote the music's ducking lane."] : []),
      'Contract v1: OK',
    ])
    expect(readFileSync(join(root, 'video/index.html'), 'utf8')).toBe(ducked)
  })

  it('takes --fix and its old name --duck', () => {
    expect(fixFlag(['node', 'check-contract.ts', '--fix'])).toBe(true)
    expect(fixFlag(['node', 'check-contract.ts', '--duck'])).toBe(true)
    expect(fixFlag(['node', 'check-contract.ts'])).toBe(false)
  })

  it('the CLI checks the repo template and exits 0, writing nothing', () => {
    const template = () => readFileSync('video/index.html', 'utf8')
    const before = template()
    const r = spawnSync('npx', ['tsx', 'scripts/check-contract.ts'], { encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stdout.trim().split('\n').at(-1)).toBe('Contract v1: OK')
    expect(template()).toBe(before)
  })
})
