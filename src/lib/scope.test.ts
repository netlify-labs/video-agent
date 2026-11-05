// The splice for a scoped revision (redo a scene, plan §4.5): the parent with the agent's scoped beats in, re-laid
// with frozen durations verbatim, captions shifted without re-snapping, voice cues recomputed, and a fixed point.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  applyDucking,
  applyHoldFrame,
  applyNarration,
  attr,
  editText,
  load,
  save,
  validate,
  walk,
  type Caption,
  type Doc,
  type Summary,
} from './contract.js'
import { fmt, frames } from './contract-core.js'
import {
  isLockedLength,
  isScopeRefusal,
  SCOPE_REFUSED_PREFIX,
  spliceBytes,
  spliceScoped,
  type ScopeInput,
} from './scope.js'
import { IDENTITY_FIT, SAMPLE_RATE as S, type NarrationOp, type Span } from './timeline.js'
import type { VoiceFile } from './voice.js'

const fx = (f: string) => readFileSync(new URL(`../../test/fixtures/${f}`, import.meta.url), 'utf8')
const music = fx('contract1-music/index.html')
const voiced = fx('contract1-voice/index.html')
const voicedSummary = JSON.parse(fx('contract1-voice/summary.json')) as Summary
const voiceFile = JSON.parse(fx('contract1-voice/assets/voice/voice.json')) as VoiceFile

const cue = (beat: string, textId: string, text: string, start: number, end: number, from = 0): Caption => ({
  start: from + start,
  end: from + end,
  text,
  beat,
  textId,
  beatStart: start,
  beatEnd: end,
})
/** The music fixture's on-screen cues: one per beat. */
const musicSummary: Summary = {
  title: 'Org webhooks',
  summary: 'The parent.',
  credits: ['"Theme" by A, CC BY 4.0'],
  captions: [
    cue('intro', 'intro-title', 'Org webhooks', 0.4, 2.5, 0),
    cue('demo', 'demo-sub', 'One subscription for every project', 0.5, 2.5, 3),
    cue('outro', 'outro-cta', 'Read the docs', 0.2, 2.5, 6),
  ],
}

const edit = (html: string, f: (d: Doc) => void) => {
  const d = load(html)
  f(d)
  return save(d)
}
const beatOf = (d: Doc, id: string) => [...walk(d.root)].find((e) => attr(e, 'data-va-beat') === id)!
const set = (d: Doc, id: string, name: string, value: string) => {
  const b = beatOf(d, id)
  const a = b.attrs.find((x) => x.name === name)
  if (a) a.value = value
  else b.attrs.push({ name, value })
}
const text = (d: Doc, id: string, value: string) =>
  editText(
    [...walk(d.root)].find((e) => attr(e, 'data-va-text') === id)!,
    value,
  )
const beatAttr = (html: string, id: string, name: string) => attr(beatOf(load(html), id), name)
const section = (html: string, id: string) =>
  new RegExp(`<section id="${id}"[\\s\\S]*?</section>`).exec(html)?.[0] ?? ''

const input = (agentHtml: string, extra: Partial<ScopeInput> = {}): ScopeInput => ({
  parent: { html: music, summary: musicSummary },
  agent: { html: agentHtml, summary: { ...musicSummary } },
  beats: ['demo'],
  lockedLength: false,
  ...extra,
})

describe('spliceScoped', () => {
  it('only the scoped beat changed: no problems, frozen scenes byte for byte, a valid composition', () => {
    const agent = edit(music, (d) => text(d, 'demo-sub', 'Ship on Friday'))
    const s = spliceScoped(input(agent))
    expect(s.problems).toEqual([])
    expect(s.putBack).toEqual([])
    expect(s.lengthDelta).toBe(0)
    expect(s.html).toContain('Ship on Friday')
    // Frozen scenes are the parent's after the parse5 round trip every composition goes through.
    for (const id of ['intro', 'outro']) expect(section(s.html!, id)).toBe(section(save(load(music)), id))
    expect(validate(s.html!, s.summary!)).toEqual([])
    expect(s.summary!.captions!.find((c) => c.beat === 'demo')?.text).toBe('Ship on Friday')
  })

  it('a scene 2 s longer with stale later starts is re-laid: later beats, layers, cues and ducking follow', () => {
    const agent = edit(music, (d) => set(d, 'demo', 'data-duration', '5'))
    const s = spliceScoped(input(agent))
    expect(s.problems).toEqual([])
    expect(s.lengthDelta).toBe(2)
    expect(beatAttr(s.html!, 'outro', 'data-start')).toBe('8')
    expect(beatAttr(s.html!, 'outro', 'data-duration')).toBe('3')
    expect(attr(load(s.html!).root, 'data-duration')).toBe('11')
    for (const l of [...walk(load(s.html!).root)].filter((e) => attr(e, 'data-va-layer') !== null))
      expect(attr(l, 'data-duration')).toBe('11')
    const outro = s.summary!.captions!.find((c) => c.beat === 'outro')!
    expect([outro.start, outro.end]).toEqual([8.2, 10.5])
    expect(beatAttr(s.html!, 'demo', 'data-va-authored-duration')).toBe('5')
    const again = load(s.html!)
    applyDucking(again)
    expect(save(again)).toBe(s.html)
  })

  it('snaps a 3.85 s scoped scene to whole frames; frozen ones keep their exact lengths', () => {
    const agent = edit(music, (d) => set(d, 'demo', 'data-duration', '3.85'))
    const s = spliceScoped(input(agent))
    expect(s.problems).toEqual([])
    expect(beatAttr(s.html!, 'demo', 'data-duration')).toBe(fmt(frames(3.85)))
    expect(beatAttr(s.html!, 'intro', 'data-duration')).toBe('3')
    expect(beatAttr(s.html!, 'outro', 'data-duration')).toBe('3')
  })

  it("keeps an authored parent's 3.85 s frozen scenes verbatim, and their cues exact or shifted by the delta", () => {
    const parent = edit(music, (d) => {
      set(d, 'intro', 'data-duration', '3.85')
      set(d, 'intro', 'data-va-authored-duration', '3.85')
      set(d, 'demo', 'data-start', '3.85')
      set(d, 'outro', 'data-start', '6.85')
      d.root.attrs.find((a) => a.name === 'data-duration')!.value = '9.85'
      for (const l of [...walk(d.root)].filter((e) => attr(e, 'data-va-layer') !== null))
        l.attrs.find((a) => a.name === 'data-duration')!.value = '9.85'
      applyDucking(d)
    })
    const summary: Summary = {
      captions: [
        cue('intro', 'intro-title', 'Org webhooks', 0.43, 2.71, 0),
        cue('demo', 'demo-sub', 'One subscription for every project', 0.5, 2.5, 3.85),
        { ...cue('outro', 'outro-cta', 'Read the docs', 0.2, 2.5, 6.85), start: 7.05, end: 9.35 },
      ],
    }
    expect(validate(parent, summary)).toEqual([])
    const agent = edit(parent, (d) => set(d, 'demo', 'data-duration', '4'))
    const s = spliceScoped({
      parent: { html: parent, summary },
      agent: { html: agent, summary },
      beats: ['demo'],
      lockedLength: false,
    })
    expect(s.problems).toEqual([])
    expect(beatAttr(s.html!, 'intro', 'data-duration')).toBe('3.85')
    expect(beatAttr(s.html!, 'outro', 'data-start')).toBe('7.85')
    const byBeat = (b: string) => s.summary!.captions!.find((c) => c.beat === b)!
    expect([byBeat('intro').start, byBeat('intro').end]).toEqual([0.43, 2.71])
    expect([byBeat('outro').start, byBeat('outro').end]).toEqual([8.05, 10.35])
  })

  it('a scene shorter than its voice-over gets "make the scene longer", by its name', () => {
    const parent = voiced
    const agent = edit(parent, (d) => set(d, 'intro', 'data-duration', '1'))
    const s = spliceScoped({
      parent: { html: parent, summary: voicedSummary, voice: voiceFile },
      agent: { html: agent, summary: voicedSummary, voice: voiceFile },
      beats: ['intro'],
      lockedLength: false,
    })
    expect(s.problems.join(' ')).toMatch(
      /Scene "Opening" is 1s but its voice-over runs to 2\.5s; make the beat longer/,
    )
  })

  it('refuses scene lengths outside 0.5 to 120 seconds', () => {
    for (const d of ['0.4', '121'])
      expect(spliceScoped(input(edit(music, (x) => set(x, 'demo', 'data-duration', d)))).problems).toEqual([
        `Scene "demo" lasts ${d}s; a scene lasts between 0.5 and 120 seconds.`,
      ])
  })

  it('reports renamed, removed, added and moved scenes by name', () => {
    const renamed = edit(music, (d) => {
      set(d, 'demo', 'data-composition-id', 'features')
      set(d, 'demo', 'data-va-beat', 'features')
    })
    expect(spliceScoped(input(renamed)).problems).toEqual([
      'Scene "demo" was renamed to "features"; keep its id "demo".',
    ])
    const removed = edit(music, (d) => {
      const b = beatOf(d, 'outro')
      d.root.childNodes.splice(d.root.childNodes.indexOf(b), 1)
    })
    expect(spliceScoped(input(removed)).problems).toEqual([
      'Scene "outro" was removed; redoing scenes keeps every scene.',
    ])
    const added = edit(music, (d) => {
      const b = beatOf(d, 'outro')
      const extra = {
        ...b,
        attrs: b.attrs.map((a) => ({ ...a, value: a.value === 'outro' ? 'bonus' : a.value })),
      }
      d.root.childNodes.push(extra)
    })
    expect(spliceScoped(input(added)).problems).toEqual([
      'Scene "bonus" is new; redoing scenes can\'t add one.',
    ])
    const moved = edit(music, (d) => {
      const kids = d.root.childNodes
      const a = kids.indexOf(beatOf(d, 'intro'))
      const b = kids.indexOf(beatOf(d, 'outro'))
      ;[kids[a], kids[b]] = [kids[b]!, kids[a]!]
    })
    expect(spliceScoped(input(moved)).problems).toEqual([
      'The scenes were moved; keep them in this order: intro, demo, outro.',
    ])
  })

  it('under recorded narration, a scoped scene keeps its exact length', () => {
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
    const narratedHtml = applyNarration(
      music,
      musicSummary,
      op,
      new Map<string, Span[]>([['t1', [[S, 2 * S]]]]),
    ).html
    const narrationCue: Caption = {
      start: 1.1,
      end: 1.9,
      text: 'Hello there.',
      narration: true,
      id: 'nc_aaaaaaaaaaaa',
    }
    const narrated = {
      html: narratedHtml,
      summary: { ...musicSummary, captions: [...musicSummary.captions!, narrationCue] },
    }
    expect(isLockedLength(narrated.html)).toBe(true)
    expect(isLockedLength(music)).toBe(false)
    const base = {
      parent: { html: narrated.html, summary: narrated.summary },
      beats: ['demo'],
      lockedLength: true,
    }
    const longer = edit(narrated.html, (d) => set(d, 'demo', 'data-duration', '4'))
    expect(spliceScoped({ ...base, agent: { html: longer, summary: narrated.summary } }).problems).toEqual([
      'Scene "demo": keep each scoped scene exactly as long as it is now (3s): the recorded narration is locked.',
    ])
    const same = edit(narrated.html, (d) => text(d, 'demo-sub', 'Ship on Friday'))
    const ok = spliceScoped({ ...base, agent: { html: same, summary: narrated.summary } })
    expect(ok.problems).toEqual([])
    // Recorded-narration cues (no beat) are kept as they were.
    expect(ok.summary!.captions!.filter((c) => c.narration)).toEqual([narrationCue])
  })

  it('refuses the held last frame and the scene before it as internal problems, without a splice', () => {
    const held = edit(music, (d) => applyHoldFrame(d, 1))
    for (const beats of [['va-hold'], ['outro']]) {
      const s = spliceScoped({
        parent: { html: held, summary: musicSummary },
        agent: { html: held, summary: musicSummary },
        beats,
        lockedLength: false,
      })
      expect(s.html).toBeNull()
      expect(s.problems[0]).toMatch(/^internal: /)
    }
    expect(spliceScoped(input(music, { beats: ['nope'] })).problems).toEqual([
      'internal: the scope names "nope", which isn\'t a scene of the parent.',
    ])
  })

  it('captions: derived beat times, frozen cues from the parent, sorted whatever the input order', () => {
    const agent = edit(music, (d) => text(d, 'demo-sub', 'Ship on Friday'))
    const s = spliceScoped(
      input(agent, {
        agent: {
          html: agent,
          summary: {
            captions: [
              // A frozen beat's cue the agent changed: ignored, the parent's is kept.
              { ...musicSummary.captions![2]!, text: 'Changed' },
              // No beat-relative times: derived from the agent's own start (3).
              { start: 4, end: 5, text: 'Ship on Friday', beat: 'demo', textId: 'demo-sub' },
              { ...musicSummary.captions![0]!, text: 'Also changed' },
            ],
          },
        },
      }),
    )
    expect(s.problems).toEqual([])
    expect(s.summary!.captions!.map((c) => [c.beat, c.text, c.start, c.end, c.beatStart])).toEqual([
      ['intro', 'Org webhooks', 0.4, 2.5, 0.4],
      ['demo', 'Ship on Friday', 4, 5, 1],
      ['outro', 'Read the docs', 6.2, 8.5, 0.2],
    ])
  })

  it("recomputes a voiced scoped scene's cues from voice.json; hand edits don't stick", () => {
    const agentSummary: Summary = {
      ...voicedSummary,
      captions: voicedSummary.captions!.map((c) => (c.beat === 'intro' ? { ...c, text: 'Hand edited' } : c)),
    }
    const s = spliceScoped({
      parent: { html: voiced, summary: voicedSummary, voice: voiceFile },
      agent: { html: voiced, summary: agentSummary, voice: voiceFile },
      beats: ['intro'],
      lockedLength: false,
    })
    expect(s.problems).toEqual([])
    expect(
      s.summary!.captions!.filter((c) => c.beat === 'intro').map((c) => [c.text, c.start, c.end]),
    ).toEqual([
      ['Meet org webhooks.', 0.3, 1.2],
      ['One place for every event.', 1.5, 2.5],
    ])
  })

  it('takes the title and summary from the agent and credits from both, once each, in order', () => {
    const s = spliceScoped(
      input(music, {
        agent: {
          html: music,
          summary: {
            ...musicSummary,
            title: 'New',
            summary: 'Redid it.',
            credits: ['"Whoosh" by B, CC BY 4.0', '"Theme" by A, CC BY 4.0'],
          },
        },
      }),
    )
    expect(s.summary).toMatchObject({
      title: 'New',
      summary: 'Redid it.',
      credits: ['"Theme" by A, CC BY 4.0', '"Whoosh" by B, CC BY 4.0'],
    })
  })

  it('is a fixed point and deterministic: splicing the splice gives the same bytes', () => {
    const agent = edit(music, (d) => {
      set(d, 'demo', 'data-duration', '4.37')
      text(d, 'demo-sub', 'Ship on Friday')
    })
    const first = spliceScoped(input(agent))
    expect(first.problems).toEqual([])
    const bytes = spliceBytes(first)
    expect(spliceBytes(spliceScoped(input(agent)))).toEqual(bytes)
    const again = spliceScoped(input(first.html!, { agent: { html: first.html!, summary: first.summary! } }))
    expect(again.problems).toEqual([])
    expect(spliceBytes(again)).toEqual(bytes)
    expect(() => spliceBytes({ html: null, summary: null })).toThrow()
  })
})

describe('isScopeRefusal', () => {
  it('matches the render-job and finalize refusals only', () => {
    expect(isScopeRefusal('scope_violated: Scene "Opening" changed')).toBe(true)
    expect(isScopeRefusal(`${SCOPE_REFUSED_PREFIX}: the music's volume`)).toBe(true)
    expect(isScopeRefusal('The MP4 is not valid: no moov')).toBe(false)
    expect(isScopeRefusal(null)).toBe(false)
  })
})
