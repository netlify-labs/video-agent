// Phase 1 gate for redo a scene (docs/plans/2026-11-04-regenerate-beat.md §7): the run side end to end on a fixture.
// prepare-run restores the parent with a scoped manifest, the agent edits one scene, check-contract --fix converges, and
// render-job's steps up to the render pass on the splice; tampered runs fail at check-contract and at render-job.
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { checkContract } from '../../scripts/lib/check-contract.js'
import { hyperframesEngine } from '../../scripts/lib/engines/hyperframes.js'
import { scopeGuard } from '../../scripts/lib/scope-guard.js'
import { prepare } from '../../scripts/prepare-run.js'
import {
  applyNarration,
  attr,
  editText,
  load,
  save,
  walk,
  type Doc,
  type Summary,
} from '../server/lib/contract.js'
import { FROZEN_DIR } from '../server/lib/revoice.js'
import { sha256Hex, scopeStillPath, type RunManifest } from '../server/lib/run-manifest.js'
import { SCOPE_LAYOUT_FILE, spliceBytes, spliceScoped } from '../server/lib/scope.js'
import { IDENTITY_FIT, SAMPLE_RATE as S, type NarrationOp, type Span } from '../server/lib/timeline.js'
import { wav, type VoiceFile } from '../server/lib/voice.js'

const fx = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8')
const music = save(load(fx('contract1-music/index.html')))
const summary: Summary = {
  title: 'Org webhooks',
  summary: 'The parent.',
  captions: [
    {
      start: 3.5,
      end: 5.5,
      text: 'One subscription for every project',
      beat: 'demo',
      textId: 'demo-sub',
      beatStart: 0.5,
      beatEnd: 2.5,
    },
    {
      start: 6.2,
      end: 8.5,
      text: 'Read the docs',
      beat: 'outro',
      textId: 'outro-cta',
      beatStart: 0.2,
      beatEnd: 2.5,
    },
  ],
}
const mp4 = join(process.cwd(), 'app/test/fixtures/a169.mp4')
const engine = hyperframesEngine()
const step = (name: string, f: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ step: `gate.${name}`, ...f }))

function write(root: string, files: Record<string, string | Uint8Array>) {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true })
    writeFileSync(join(root, p), body)
  }
}
const edit = (html: string, f: (d: Doc) => void) => {
  const d = load(html)
  f(d)
  return save(d)
}
const beat = (d: Doc, id: string) => [...walk(d.root)].find((e) => attr(e, 'data-va-beat') === id)!
const text = (d: Doc, id: string, value: string) =>
  editText(
    [...walk(d.root)].find((e) => attr(e, 'data-va-text') === id)!,
    value,
  )
/** What an agent writes when it redoes "demo": new text, 2 s longer, its own @scope style; later starts left stale. */
const redoDemo = (d: Doc, style = '@scope { .sub { color: var(--va-color-accent); } }') => {
  text(d, 'demo-sub', 'Ship on Friday')
  beat(d, 'demo').attrs.find((a) => a.name === 'data-duration')!.value = '5'
  const css = load(`<div data-composition-id="x"><style>${style}</style></div>`).root.childNodes[0]!
  beat(d, 'demo').childNodes.unshift(css)
}
const quiet = <T>(f: () => T): T => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    return f()
  } finally {
    spy.mockRestore()
  }
}
/** check-contract --fix until clean, at most `rounds` times; the last result. */
const fix = (root: string, rounds = 2) => {
  let r = quiet(() => checkContract(root, { fix: true }))
  for (let n = 1; n < rounds && r.code !== 0; n++) r = quiet(() => checkContract(root, { fix: true }))
  return r
}

/** A restored run workspace without prepare-run (tampered variants): the manifest, the frozen parent and video/. */
function workspace(
  parent: Record<string, string | Uint8Array>,
  agent: Record<string, string | Uint8Array>,
  m: RunManifest,
) {
  const root = mkdtempSync(join(tmpdir(), 'va-gate-'))
  write(root, {
    '.render/run-manifest.json': JSON.stringify(m),
    ...Object.fromEntries(Object.entries(parent).map(([p, b]) => [`${FROZEN_DIR}/${p}`, b])),
    ...Object.fromEntries(Object.entries(agent).map(([p, b]) => [`video/${p}`, b])),
  })
  return root
}
const base: RunManifest = {
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
}
const parentFiles = {
  'index.html': music,
  'summary.json': JSON.stringify(summary),
  'assets/logo.svg': '<svg/>',
}

describe('redo a scene, run side end to end', () => {
  it('prepare-run → one scene edited → check-contract --fix → render-job up to the render', async () => {
    // The parent's archive, as finalize saved it.
    const src = mkdtempSync(join(tmpdir(), 'va-gate-src-'))
    write(src, Object.fromEntries(Object.entries(parentFiles).map(([p, b]) => [`video/${p}`, b])))
    const archive = join(src, 'source.tar.gz')
    execFileSync('tar', ['-czf', archive, '-C', src, 'video'])
    const root = mkdtempSync(join(tmpdir(), 'va-gate-'))
    const m: RunManifest = {
      ...base,
      source: { key: 'vid_1/v1/source.tar.gz', sha256: sha256Hex(readFileSync(archive)), parentN: 1 },
      feedback: { video: { key: 'vid_1/v1/video.mp4', sha256: sha256Hex(readFileSync(mp4)) }, pins: [] },
      scope: {
        beats: ['demo'],
        stills: [
          { atSec: 0.2, path: scopeStillPath('demo', 'before'), what: 'before', beat: 'demo' },
          { atSec: 0.5, path: scopeStillPath('demo', 'after'), what: 'after', beat: 'demo' },
        ],
      },
    }
    // 1. prepare-run.
    await quiet(() =>
      prepare(m, {
        tmp: root,
        root,
        fetch: async (key, to) => {
          copyFileSync(key.endsWith('.mp4') ? mp4 : archive, to)
        },
      }),
    )
    for (const p of [
      `${FROZEN_DIR}/index.html`,
      `${FROZEN_DIR}/${SCOPE_LAYOUT_FILE}`,
      'video/feedback/scope/demo-before.jpg',
      'video/feedback/scope/demo-after.jpg',
    ])
      expect(existsSync(join(root, p)), p).toBe(true)
    write(root, { '.render/run-manifest.json': JSON.stringify(m) })
    step('prepare', { ok: true })
    // 2. The agent redoes "demo".
    const agent = edit(readFileSync(join(root, 'video/index.html'), 'utf8'), (d) => redoDemo(d))
    write(root, { 'video/index.html': agent, 'video/assets/beats/demo/glow.svg': '<svg/>' })
    step('edit')
    // 3. check-contract --fix converges.
    const checked = fix(root)
    step('fix', { code: checked.code })
    expect(checked.code).toBe(0)
    expect(checked.lines.at(-1)).toBe('Contract v1: OK (scope: demo)')
    // 4. render-job up to the render: the guard writes the splice, the contract passes on it.
    const verified = quiet(() => scopeGuard(root, 'att_1', engine))
    step('render-job', { verified })
    expect(verified).toEqual({ beats: ['demo'], lengthDelta: 2, newFiles: ['assets/beats/demo/glow.svg'] })
    expect(engine.contract(join(root, 'video'))).toEqual([])
    const want = spliceBytes(
      spliceScoped({
        parent: { html: music, summary },
        agent: { html: agent, summary },
        beats: ['demo'],
        lockedLength: false,
      }),
    )
    expect(readFileSync(join(root, 'video/index.html'), 'utf8')).toBe(want['index.html'])
    const outro = (
      JSON.parse(readFileSync(join(root, 'video/summary.json'), 'utf8')) as Summary
    ).captions!.find((c) => c.beat === 'outro')!
    expect([outro.start, outro.end]).toEqual([8.2, 10.5])
    rmSync(src, { recursive: true, force: true })
  })

  describe('tampered runs fail at check-contract and at render-job', () => {
    const cases: [string, (d: Doc) => void, Record<string, string | null>, RegExp][] = [
      [
        'an edit in a frozen scene',
        (d) => text(d, 'intro-title', 'Org hooks'),
        {},
        /Scene "Opening" changed \(its headline text\)/,
      ],
      [
        'a deleted existing file',
        () => undefined,
        { 'assets/logo.svg': null },
        /assets\/logo\.svg was deleted/,
      ],
      [
        'a GSAP selector string in the redone scene',
        (d) =>
          editText(
            [...walk(beat(d, 'demo'))].find((e) => e.tagName === 'script')!,
            "vaBeat('demo', (tl, el) => { tl.from('.sub', { opacity: 0 }) })",
          ),
        {},
        /selector string in tl\.from/,
      ],
      [
        'a colour role declared in the scoped style',
        (d) => {
          const style = [...walk(beat(d, 'demo'))].find((e) => e.tagName === 'style')!
          editText(style, '@scope { .sub { --va-color-accent: red; } }')
        },
        {},
        /declares --va-color-accent/,
      ],
    ]
    for (const [name, tamper, files, message] of cases)
      it(name, () => {
        const agent = edit(music, (d) => {
          redoDemo(d)
          tamper(d)
        })
        const agentFiles = Object.fromEntries(
          Object.entries({ ...parentFiles, 'index.html': agent }).filter(([p]) => files[p] !== null),
        )
        // At render-job, when the agent skipped --fix.
        const root = workspace(parentFiles, agentFiles, base)
        expect(() => quiet(() => scopeGuard(root, 'att_1', engine))).toThrow(
          new RegExp(`^scope_violated: [\\s\\S]*${message.source}`),
        )
        // At check-contract.
        const checked = quiet(() => checkContract(root, { fix: true }))
        expect(checked.code).toBe(1)
        expect(checked.lines.join('\n')).toMatch(message)
      })

    it('only the frozen-scene edit is put back; a second --fix is then clean', () => {
      const agent = edit(music, (d) => {
        redoDemo(d)
        text(d, 'intro-title', 'Org hooks')
      })
      const root = workspace(parentFiles, { ...parentFiles, 'index.html': agent }, base)
      expect(quiet(() => checkContract(root, { fix: true })).lines[0]).toMatch(/^Put back: Scene "Opening"/)
      expect(fix(root, 1).code).toBe(0)
      expect(quiet(() => scopeGuard(root, 'att_1', engine))?.beats).toEqual(['demo'])
    })
  })

  it('narrated: a scoped scene keeps its length', () => {
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
    const parent = { ...parentFiles, 'index.html': narrated }
    const longer = edit(narrated, (d) => redoDemo(d))
    const root = workspace(parent, { ...parent, 'index.html': longer }, base)
    expect(quiet(() => checkContract(root, { fix: true })).lines.join('\n')).toMatch(
      /keep each scoped scene exactly as long as it is now \(3s\)/,
    )
    const same = edit(narrated, (d) => text(d, 'demo-sub', 'Ship on Friday'))
    expect(fix(workspace(parent, { ...parent, 'index.html': same }, base)).code).toBe(0)
  })

  it('voiced: only the scoped line is re-voiced', () => {
    const voiced = save(load(fx('contract1-voice/index.html')))
    const voicedSummary = fx('contract1-voice/summary.json')
    const voice = JSON.parse(fx('contract1-voice/assets/voice/voice.json')) as VoiceFile
    const script = {
      lines: [
        { beat: 'intro', text: voice.beats[0]!.text },
        { beat: 'outro', text: voice.beats[1]!.text },
      ],
    }
    const pcm = (s: number) => wav(new Uint8Array(Math.round(s * 24_000) * 2))
    const parent = {
      'index.html': voiced,
      'summary.json': voicedSummary,
      'assets/voice/voice.json': JSON.stringify(voice),
      'assets/voice/script.json': JSON.stringify(script),
      'assets/voice/intro.wav': pcm(2.2),
      'assets/voice/outro.wav': pcm(1.5),
    }
    const m = { ...base, scope: { beats: ['intro'], stills: [] } }
    // The intro's line re-spoken: its voice.json entry, script line and WAV change; the outro's stay.
    const intro = {
      ...voice.beats[0]!,
      text: 'Hello there.',
      hash: 'c'.repeat(64),
      duration: 2,
      cues: [{ text: 'Hello there.', start: 0, end: 2 }],
    }
    const agentVoice = { ...voice, beats: [intro, voice.beats[1]!] }
    const agentScript = { lines: [{ beat: 'intro', text: 'Hello there.' }, script.lines[1]!] }
    const agent = edit(voiced, (d) => {
      const audio = [...walk(beat(d, 'intro'))].find((e) => attr(e, 'data-va-voice') === 'intro')!
      audio.attrs.find((a) => a.name === 'data-duration')!.value = '2'
    })
    const files = {
      ...parent,
      'index.html': agent,
      'assets/voice/voice.json': JSON.stringify(agentVoice),
      'assets/voice/script.json': JSON.stringify(agentScript),
      'assets/voice/intro.wav': pcm(2),
    }
    const root = workspace(parent, files, m)
    expect(fix(root).code).toBe(0)
    const cues = (JSON.parse(readFileSync(join(root, 'video/summary.json'), 'utf8')) as Summary).captions!
    expect(cues.filter((c) => c.beat === 'intro').map((c) => c.text)).toEqual(['Hello there.'])
    expect(cues.filter((c) => c.beat === 'outro' && c.voice).map((c) => c.text)).toEqual(['Read the docs.'])
    // The outro's line changed too: refused.
    const both = {
      ...files,
      'assets/voice/script.json': JSON.stringify({
        lines: [agentScript.lines[0]!, { beat: 'outro', text: 'Read on.' }],
      }),
    }
    expect(quiet(() => checkContract(workspace(parent, both, m), { fix: true })).lines.join('\n')).toMatch(
      /Scene "outro"'s voice-over line changed/,
    )
  })
})
