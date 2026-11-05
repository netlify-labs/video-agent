// HyperFrames' scope check as the run engine calls it (redo a scene, va-8cy4.2.7): over .render/frozen and video/,
// with the bundle's exclusions, and the frozen copy's scope.json not counted as a parent file.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hyperframesEngine } from '../scripts/lib/engines/hyperframes.js'
import { engineInfo, registerScopeCheck, resetScopeChecks, scopeCheckFor } from '../src/domain/engines.js'
import { attr, editText, load, save, walk } from '../src/lib/contract.js'
import { hyperframesScopeCheck, SCOPE_LAYOUT_FILE, spliceBytes, spliceScoped } from '../src/lib/scope.js'

const music = readFileSync(new URL('./fixtures/contract1-music/index.html', import.meta.url), 'utf8')
const summary = { title: 'Org webhooks', captions: [] }

function dir(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'va-scope-'))
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true })
    writeFileSync(join(root, p), body)
  }
  return root
}
const redone = (() => {
  const d = load(music)
  editText(
    [...walk(d.root)].find((e) => attr(e, 'data-va-text') === 'demo-sub')!,
    'Ship on Friday',
  )
  return save(d)
})()

afterEach(() => resetScopeChecks())

describe('the HyperFrames run engine scopeCheck', () => {
  const engine = hyperframesEngine()
  const frozen = () =>
    dir({
      'index.html': music,
      'summary.json': JSON.stringify(summary),
      'assets/logo.svg': '<svg/>',
      [SCOPE_LAYOUT_FILE]: JSON.stringify({ beats: ['demo'], layout: [] }),
    })

  it('splices video/ against the frozen parent, ignoring run inputs and caches', () => {
    const video = dir({
      'index.html': redone,
      'summary.json': JSON.stringify(summary),
      'assets/logo.svg': '<svg/>',
      'assets/beats/demo/badge.svg': '<svg/>',
      'feedback/scope/demo-before.jpg': 'jpeg',
      '.hyperframes/cache/x': 'cache',
    })
    const r = engine.scopeCheck!(frozen(), video, ['demo'])
    expect(r.problems).toEqual([])
    const want = spliceBytes(
      spliceScoped({
        parent: { html: music, summary },
        agent: { html: redone, summary },
        beats: ['demo'],
        lockedLength: false,
      }),
    )
    expect(new TextDecoder().decode(r.files?.get('index.html'))).toBe(want['index.html'])
  })

  it('reports a file the other scenes use that went missing', () => {
    const video = dir({ 'index.html': redone, 'summary.json': JSON.stringify(summary) })
    expect(engine.scopeCheck!(frozen(), video, ['demo']).problems).toEqual([
      'assets/logo.svg was deleted; files the other scenes use must stay.',
    ])
  })

  it('registered, it turns HyperFrames’ scopedRevision on (prodDeps registers it at startup)', () => {
    expect(engineInfo('hyperframes').capabilities.scopedRevision).toBe(false)
    registerScopeCheck('hyperframes', hyperframesScopeCheck)
    expect(scopeCheckFor('hyperframes')).toBe(hyperframesScopeCheck)
    expect(engineInfo('hyperframes').capabilities.scopedRevision).toBe(true)
    expect(engineInfo('remotion').capabilities.scopedRevision).toBe(false)
  })
})
