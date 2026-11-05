// render-job's scope guard (redo a scene, plan §4.9): a scoped run renders only the splice; anything outside the scope
// stops it with scope_violated; a scoped revision of a narrated parent still gets the narration lock.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { hyperframesEngine } from '../scripts/lib/engines/hyperframes.js'
import { scopeGuard } from '../scripts/lib/scope-guard.js'
import {
  applyNarration,
  attr,
  editText,
  load,
  NARRATION_SRC,
  save,
  validate,
  walk,
  type Doc,
  type Summary,
} from '../src/lib/contract.js'
import { checkNarrationKept } from '../src/lib/narration-modified.js'
import type { RunManifest } from '../src/lib/run-manifest.js'
import { spliceBytes, spliceScoped } from '../src/lib/scope.js'
import { IDENTITY_FIT, SAMPLE_RATE as S, type NarrationOp, type Span } from '../src/lib/timeline.js'
import { wav } from '../src/lib/voice.js'

const music = save(
  load(readFileSync(new URL('./fixtures/contract1-music/index.html', import.meta.url), 'utf8')),
)
const summary: Summary = { title: 'Org webhooks', captions: [] }
const engine = hyperframesEngine()
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

function write(root: string, files: Record<string, string | Uint8Array>) {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true })
    writeFileSync(join(root, p), body)
  }
}
const manifest = (extra: Partial<RunManifest> = {}): RunManifest => ({
  v: 1,
  jobId: 'vid_1',
  attemptId: 'att_1',
  versionN: 2,
  kind: 'revision',
  source: { key: 'vid_1/v1/source.tar.gz', sha256: 'a'.repeat(64), parentN: 1 },
  bundle: null,
  media: null,
  feedback: null,
  scope: { beats: ['demo'], stills: [] },
  ...extra,
})
function workspace(
  parentHtml: string,
  agentHtml: string,
  m: RunManifest = manifest(),
  extra: Record<string, string | Uint8Array> = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'va-render-scope-'))
  const parent = {
    'index.html': parentHtml,
    'summary.json': JSON.stringify(summary),
    'assets/logo.svg': '<svg/>',
  }
  write(root, {
    '.render/run-manifest.json': JSON.stringify(m),
    ...Object.fromEntries(Object.entries(parent).map(([p, b]) => [`.render/frozen/${p}`, b])),
    ...Object.fromEntries(
      Object.entries({ ...parent, 'index.html': agentHtml, ...extra }).map(([p, b]) => [`video/${p}`, b]),
    ),
  })
  return root
}
const edit = (html: string, f: (d: Doc) => void) => {
  const d = load(html)
  f(d)
  return save(d)
}
const text = (d: Doc, id: string, value: string) =>
  editText(
    [...walk(d.root)].find((e) => attr(e, 'data-va-text') === id)!,
    value,
  )
const redo = (d: Doc) => text(d, 'demo-sub', 'Ship on Friday')
const read = (root: string, p: string) => readFileSync(join(root, 'video', p), 'utf8')

describe('render-job scope guard', () => {
  it('refuses a change outside the scope with scope_violated and the full list, writing nothing', () => {
    const agent = edit(music, (d) => {
      redo(d)
      text(d, 'intro-title', 'Org hooks')
    })
    const root = workspace(music, agent)
    expect(() => scopeGuard(root, 'att_1', engine)).toThrow(
      /^scope_violated: Scene "Opening" changed \(its headline text\)\.\n[\s\S]*Run npx tsx scripts\/check-contract\.ts --fix/,
    )
    expect(read(root, 'index.html')).toBe(agent)
  })

  it('writes the splice over stale derived values, which then validates', () => {
    const agent = edit(music, (d) => {
      redo(d)
      const demo = [...walk(d.root)].find((e) => attr(e, 'data-va-beat') === 'demo')!
      demo.attrs.find((a) => a.name === 'data-duration')!.value = '5'
    })
    const root = workspace(music, agent)
    expect(validate(agent).join(' ')).toMatch(/should start at/)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let verified
    let logs: { step: string; lengthDelta?: number; newFiles?: string[] }[]
    try {
      verified = scopeGuard(root, 'att_1', engine)
      logs = spy.mock.calls.map((c) => JSON.parse(String(c[0])) as (typeof logs)[number])
    } finally {
      spy.mockRestore()
    }
    expect(verified).toEqual({ beats: ['demo'], lengthDelta: 2, newFiles: [] })
    expect(logs.find((l) => l.step === 'scope.verified')).toMatchObject({ lengthDelta: 2, newFiles: [] })
    const want = spliceBytes(
      spliceScoped({
        parent: { html: music, summary },
        agent: { html: agent, summary },
        beats: ['demo'],
        lockedLength: false,
      }),
    )
    expect(read(root, 'index.html')).toBe(want['index.html'])
    expect(read(root, 'summary.json')).toBe(want['summary.json'])
    expect(validate(read(root, 'index.html'), JSON.parse(read(root, 'summary.json')) as Summary)).toEqual([])
  })

  it('lists new files and ignores runs without a scope or for another attempt', () => {
    const root = workspace(music, edit(music, redo), manifest(), { 'assets/beats/demo/badge.svg': '<svg/>' })
    expect(scopeGuard(root, 'att_1', engine)?.newFiles).toEqual(['assets/beats/demo/badge.svg'])
    expect(scopeGuard(root, 'att_other', engine)).toBeNull()
    expect(scopeGuard(workspace(music, music, manifest({ scope: undefined })), 'att_1', engine)).toBeNull()
  })

  it('stops when the frozen copy or the engine hook is missing', () => {
    const root = workspace(music, music)
    expect(() => scopeGuard(root, 'att_1', { id: 'remotion' })).toThrow(
      /^scope_violated: this video's engine \(remotion\)/,
    )
    const bare = mkdtempSync(join(tmpdir(), 'va-render-scope-'))
    write(bare, { '.render/run-manifest.json': JSON.stringify(manifest()), 'video/index.html': music })
    expect(() => scopeGuard(bare, 'att_1', engine)).toThrow(/frozen copy of the parent is missing/)
  })

  it('a scoped revision of a narrated parent gets the scope check and the narration lock', () => {
    const op: NarrationOp = {
      op: 'narration',
      schema: 1,
      sampleRate: S,
      clips: [
        {
          id: 'a',
          mediaId: 't1',
          srcStart: 0,
          srcEnd: 9 * S,
          fit: IDENTITY_FIT,
          offsetSamples: 0,
          start: 0,
          gainDb: 0,
          fadeInSamples: 0,
          fadeOutSamples: 0,
        },
      ],
      tracks: {
        narration: { volumeDb: 0, muted: false, solo: false },
        aiVoice: { mode: 'replace', volumeDb: 0 },
        music: { duck: true, duckDb: -12 },
        original: { muteAll: false },
      },
      cleanup: 'off',
    }
    const narrated = applyNarration(music, summary, op, new Map<string, Span[]>([['t1', [[S, 2 * S]]]])).html
    const bus = wav(new Uint8Array(9 * S * 2))
    const m = manifest({
      source: {
        key: 'vid_1/v1/source.tar.gz',
        sha256: 'a'.repeat(64),
        parentN: 1,
        references: [
          { path: NARRATION_SRC, key: 'vid_1/v1/narration-bus.wav', sha256: sha(bus), bytes: bus.length },
        ],
      },
    })
    const withBus = (root: string, b: Uint8Array) => write(root, { [`video/${NARRATION_SRC}`]: b })
    // Scope clean, bus swapped: the scope check passes (the bus belongs to the narration lock), the lock refuses.
    const swapped = workspace(narrated, edit(narrated, redo), m)
    withBus(swapped, wav(new Uint8Array(9 * S * 2).fill(1)))
    expect(scopeGuard(swapped, 'att_1', engine)?.beats).toEqual(['demo'])
    expect(checkNarrationKept(join(swapped, '.render/frozen'), join(swapped, 'video'), m).join(' ')).toMatch(
      /isn't the parent's narration bus/,
    )
    // Bus intact, a frozen scene changed: the scope check refuses.
    const outside = workspace(
      narrated,
      edit(narrated, (d) => text(d, 'intro-title', 'Org hooks')),
      m,
    )
    withBus(outside, bus)
    expect(() => scopeGuard(outside, 'att_1', engine)).toThrow(/^scope_violated: Scene "Opening" changed/)
    // Both clean: both pass.
    const clean = workspace(narrated, edit(narrated, redo), m)
    withBus(clean, bus)
    expect(scopeGuard(clean, 'att_1', engine)).not.toBeNull()
    expect(checkNarrationKept(join(clean, '.render/frozen'), join(clean, 'video'), m)).toEqual([])
  })
})
