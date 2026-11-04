// Editing contract v1 (plan v2 §8, §14 rules 18-20): the validator and the patcher on the spike S8 fixture.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  applyEdits,
  applyRevoice,
  changed,
  ContractError,
  editText,
  save,
  walk,
  load,
  read,
  validate,
  type EditOp,
  type Summary,
} from './contract.js'

const fx = (f: string) => readFileSync(new URL(`../../test/fixtures/contract1/${f}`, import.meta.url), 'utf8')
const html = fx('index.html')
const summary = JSON.parse(fx('summary.json')) as Summary
const musicHtml = readFileSync(
  new URL('../../test/fixtures/contract1-music/index.html', import.meta.url),
  'utf8',
)

describe('contract validator', () => {
  it('accepts the fixture and reads its beats, texts, colours and slots', () => {
    expect(validate(html, summary)).toEqual([])
    const c = read(load(html))
    expect(c.duration).toBe(9)
    expect(c.beats.map((b) => [b.id, b.start, b.duration])).toEqual([
      ['intro', 0, 3],
      ['demo', 3, 3],
      ['outro', 6, 3],
    ])
    // data-va-label is read where the author gave one, and null elsewhere.
    expect(c.beats.map((b) => b.label)).toEqual(['Opening', null, null])
    expect(c.beats[0]?.texts).toEqual([
      { id: 'intro-kicker', text: 'Netlify', label: null },
      { id: 'intro-title', text: 'Org webhooks', label: 'Headline' },
    ])
    expect(c.colors).toMatchObject({ bg: '#0b0d10', accent: '#14b8a6' })
    expect(c.beats[1]?.media).toEqual([
      {
        slot: 'hero-clip',
        label: null,
        kind: 'video',
        src: 'assets/media/med_clip.mp4',
        beat: 'demo',
        fit: null,
      },
    ])
    expect(c.layers).toEqual(['glow'])
    expect(c.audio).toEqual([])
  })

  it.each([
    ['no marker', (h: string) => h.replace('data-va-contract="1"', ''), /data-va-contract="1"/],
    [
      'no adapter',
      (h: string) => h.replace('<script src="vendor/va-contract.js"></script>', ''),
      /va-contract\.js/,
    ],
    [
      'beat on another track',
      (h: string) =>
        h.replace(
          'data-start="3" data-duration="3" data-va-authored-duration="3" data-track-index="0"',
          'data-start="3" data-duration="3" data-va-authored-duration="3" data-track-index="2"',
        ),
      /must be on track 0/,
    ],
    [
      'gap between beats',
      (h: string) =>
        h.replace(
          'data-va-beat="outro" data-composition-id="outro" data-start="6"',
          'data-va-beat="outro" data-composition-id="outro" data-start="6.5"',
        ),
      /should start at 6s/,
    ],
    [
      'duplicate text id',
      (h: string) => h.replace('data-va-text="outro-cta"', 'data-va-text="intro-title"'),
      /used twice/,
    ],
    [
      'document selectors',
      (h: string) =>
        h.replace(
          'tl.from(el.querySelector(\'[data-va-text="outro-cta"]\')',
          "tl.from(document.querySelector('#title')",
        ),
      /not document/,
    ],
    [
      'cross-beat reference',
      (h: string) =>
        h.replace("vaBeat('outro', (tl, el) => {", "vaBeat('outro', (tl, el) => { tl.set('#intro', {})"),
      /refers to beat "intro"/,
    ],
    [
      'timed element outside beats',
      (h: string) =>
        h.replace(
          '<div id="bg-glow"',
          '<div id="stray" data-start="0" data-duration="2"></div><div id="bg-glow"',
        ),
      /neither a beat nor a layer/,
    ],
    [
      'layer too short',
      (h: string) =>
        h.replace(
          'data-va-layer="glow" data-start="0" data-duration="9"',
          'data-va-layer="glow" data-start="0" data-duration="5"',
        ),
      /span the whole video/,
    ],
    [
      'media outside assets/media',
      (h: string) => h.replace('src="assets/media/med_logo.svg"', 'src="https://cdn.example.com/logo.svg"'),
      /assets\/media/,
    ],
    [
      'wrong root duration',
      (h: string) =>
        h.replace(
          'data-va-contract="1" data-start="0" data-duration="9"',
          'data-va-contract="1" data-start="0" data-duration="12"',
        ),
      /add up to 9s/,
    ],
  ])('rejects %s', (_n, mutate, msg) => {
    expect(validate(mutate(html)).join(' ')).toMatch(msg)
  })

  it('rejects captions that point at the wrong beat', () => {
    const bad = { ...summary, captions: [{ ...summary.captions![0]!, beat: 'outro' }] }
    expect(validate(html, bad).join(' ')).toMatch(/doesn't match a text in beat "outro"/)
  })
})

describe('contract patcher', () => {
  it('sets text as text, never HTML, and updates the caption', () => {
    const out = applyEdits(html, summary, [{ op: 'text', id: 'intro-title', text: '<b>Webhooks</b> & more' }])
    expect(out.html).toContain('&lt;b&gt;Webhooks&lt;/b&gt; &amp; more')
    expect(out.summary.captions?.[0]?.text).toBe('<b>Webhooks</b> & more')
  })

  it('edits text in place, keeping token spans (syntax highlighting) and indentation', () => {
    const line = (inner: string) => {
      const d = load(`<div data-composition-id="x"><span class="ln" data-va-text="c6">${inner}</span></div>`)
      const el = [...walk(d.root)].find((e) => e.attrs.some((a) => a.name === 'data-va-text'))
      if (!el) throw new Error('no line')
      return { d, el }
    }
    const html = (src: string) => /<span class="ln" data-va-text="c6">(.*?)<\/span><\/div>/s.exec(src)?.[1]
    const code = `  <span class="tk-prop">model</span>: <span class="tk-str">'claude-opus-4-8'</span>,`
    // The model name changes inside its string token; the token and the two-space indent stay.
    const { d, el } = line(code)
    editText(el, "model: 'claude-opus-5-5',")
    expect(html(save(d))).toBe(
      `  <span class="tk-prop">model</span>: <span class="tk-str">'claude-opus-5-5'</span>,`,
    )
    // Unchanged text changes nothing.
    const same = line(code)
    editText(same.el, "model: 'claude-opus-4-8',")
    expect(html(save(same.d))).toBe(code)
    // A change across tokens trims them, and the new text goes where the change starts.
    const across = line(code)
    editText(across.el, 'name: x,')
    expect(html(save(across.d))).toBe(`  <span class="tk-prop">name: x</span><span class="tk-str"></span>,`)
    // Plain text, and text in an element that had none, still work.
    const plain = line('Org webhooks')
    editText(plain.el, 'Org webhooks, now')
    expect(html(save(plain.d))).toBe('Org webhooks, now')
    expect(changed('abcd', 'abXd')).toEqual([2, 3, 'X'])
    expect(changed('ab', 'abc')).toEqual([2, 2, 'c'])
  })

  it('retimes by stretching: later beats shift, the root, layers, video slots and captions follow', () => {
    const out = applyEdits(html, summary, [{ op: 'retime', beat: 'intro', duration: 4.5 }])
    expect(out.composition.beats.map((b) => [b.id, b.start, b.duration])).toEqual([
      ['intro', 0, 4.5],
      ['demo', 4.5, 3],
      ['outro', 7.5, 3],
    ])
    expect(out.composition.duration).toBe(10.5)
    expect(out.html).toMatch(/data-va-layer="glow" data-start="0" data-duration="10.5"/)
    // Authored duration stays, so the adapter stretches the beat's own timeline by 1.5.
    expect(out.html).toMatch(/data-va-beat="intro"[^>]*data-va-authored-duration="3"/)
    expect(out.summary.captions?.map((c) => [c.start, c.end])).toEqual([
      [0.6, 4.5],
      [5, 7.5],
      [7.7, 10.5],
    ])
  })

  it('takes music as a layer and effects inside beats; retimes keep the music spanning the video', () => {
    const music =
      '<audio id="music" data-va-layer="music" src="assets/media/med_abc12345.mp3" data-start="0" data-duration="9" data-track-index="2" data-volume="0.8" data-fade-in="1" data-fade-out="1.5"></audio>'
    const sfx = '<audio id="sfx-pop" src="assets/sfx/pop.mp3" data-start="0.4" data-volume="0.35"></audio>'
    const withSound = html
      .replace('<section id="intro"', `${music}\n      <section id="intro"`)
      .replace(
        '<div class="kicker" data-va-text="intro-kicker">',
        `${sfx}<div class="kicker" data-va-text="intro-kicker">`,
      )
    expect(validate(withSound, summary)).toEqual([])
    const out = applyEdits(withSound, summary, [{ op: 'retime', beat: 'intro', duration: 4.5 }])
    expect(out.html).toMatch(/data-va-layer="music"[^>]*data-start="0" data-duration="10.5"/)
    expect(out.html).toContain('data-start="0.4" data-volume="0.35"')
    // Timed audio on the root that isn't a layer breaks the contract.
    expect(
      validate(
        html.replace(
          '<section id="intro"',
          `${music.replace(' data-va-layer="music"', '')}<section id="intro"`,
        ),
        summary,
      ),
    ).toContainEqual(expect.stringMatching(/<audio id="music"> is timed but is neither a beat nor a layer/))
  })

  it('quantizes times to frames', () => {
    const out = applyEdits(html, summary, [{ op: 'retime', beat: 'demo', duration: 2.01 }])
    expect(out.composition.beats[1]?.duration).toBe(2)
    expect(out.composition.beats[2]?.start).toBe(5)
  })

  it('edits a composition whose beats are between frames (3.85 s is 115.5 frames)', () => {
    // An agent-authored video had intro 3.85 s and the next beat at 3.85; snapping only the starts made it uneditable.
    const offFrame = html
      .replace(/(data-va-beat="intro"[^>]*?)data-duration="3"/, '$1data-duration="3.85"')
      .replace(/(data-va-beat="demo"[^>]*?)data-start="3"/, '$1data-start="3.85"')
      .replace(/(data-va-beat="demo"[^>]*?)data-duration="3"/, '$1data-duration="2.15"')
    expect(validate(offFrame, summary)).toEqual([])
    const out = applyEdits(offFrame, summary, [])
    const c = read(load(out.html))
    expect(c.beats.map((b) => [b.start, b.duration])).toEqual([
      [0, 3.866667],
      [3.866667, 2.133333],
      [6, 3],
    ])
    expect(c.duration).toBe(9)
  })

  it('reorders and deletes beats, refusing to delete the last one', () => {
    const re = applyEdits(html, summary, [{ op: 'reorder', order: ['intro', 'outro', 'demo'] }])
    expect(re.composition.beats.map((b) => [b.id, b.start])).toEqual([
      ['intro', 0],
      ['outro', 3],
      ['demo', 6],
    ])
    expect(re.summary.captions?.map((c) => c.textId)).toEqual(['intro-title', 'outro-cta', 'demo-sub'])
    const del = applyEdits(html, summary, [{ op: 'delete', beat: 'demo' }])
    expect(del.composition.duration).toBe(6)
    expect(del.summary.captions?.map((c) => c.textId)).toEqual(['intro-title', 'outro-cta'])
    expect(() =>
      applyEdits(html, summary, [
        { op: 'delete', beat: 'demo' },
        { op: 'delete', beat: 'outro' },
        { op: 'delete', beat: 'intro' },
      ]),
    ).toThrow(/last beat/)
    expect(() => applyEdits(html, summary, [{ op: 'reorder', order: ['intro', 'demo'] }])).toThrow(
      /every beat once/,
    )
  })

  it('swaps a colour role only within the palette', () => {
    const out = applyEdits(html, summary, [{ op: 'color', role: 'accent', value: '#FF5A1F' }], {
      palette: ['#ff5a1f', '#14b8a6'],
    })
    expect(out.composition.colors.accent).toBe('#ff5a1f')
    expect(() =>
      applyEdits(html, summary, [{ op: 'color', role: 'accent', value: '#000000' }], {
        palette: ['#ff5a1f'],
      }),
    ).toThrow(/brand palette/)
    expect(() => applyEdits(html, summary, [{ op: 'color', role: 'nope', value: '#fff' }])).toThrow(
      /no colour role/,
    )
  })

  it('swaps media within its kind with an explicit fit; video slots stay muted', () => {
    const out = applyEdits(html, summary, [
      { op: 'media', slot: 'hero-clip', src: 'assets/media/med_other.mp4', kind: 'video', fit: 'contain' },
    ])
    expect(out.composition.beats[1]?.media[0]).toMatchObject({
      src: 'assets/media/med_other.mp4',
      fit: 'contain',
    })
    expect(out.html).toMatch(/<video[^>]*data-va-media="hero-clip"[^>]*muted/)
    expect(() =>
      applyEdits(html, summary, [
        { op: 'media', slot: 'logo', src: 'assets/media/x.mp4', kind: 'video', fit: 'cover' },
      ]),
    ).toThrow(/takes image media/)
    expect(() =>
      applyEdits(html, summary, [
        { op: 'media', slot: 'logo', src: '../../etc/passwd', kind: 'image', fit: 'cover' },
      ]),
    ).toThrow(/assets\/media/)
  })

  it('refuses to edit a composition that does not conform', () => {
    expect(() => applyEdits(html.replace('data-va-contract="1"', ''), summary, [])).toThrow(ContractError)
  })

  it('random edit sequences keep the composition valid and the timeline consistent', () => {
    let seed = 7
    const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647
    for (let round = 0; round < 60; round++) {
      let cur = { html, summary }
      for (let step = 0; step < 6; step++) {
        const beats = read(load(cur.html)).beats.map((b) => b.id)
        const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)] as T
        const ops: EditOp[] = [
          { op: 'retime', beat: pick(beats), duration: 0.5 + rnd() * 8 },
          { op: 'reorder', order: [...beats].sort(() => rnd() - 0.5) },
          { op: 'text', id: 'outro-cta', text: `Go ${round}.${step}` },
        ]
        if (beats.length > 1 && rnd() < 0.2)
          ops.push({ op: 'delete', beat: pick(beats.filter((b) => b !== 'outro')) })
        const next = applyEdits(cur.html, cur.summary, [pick(ops)])
        const c = next.composition
        const sum = c.beats.reduce((s, b) => s + b.duration, 0)
        expect(Math.abs(sum - c.duration)).toBeLessThan(1e-5)
        expect(validate(next.html, next.summary)).toEqual([])
        for (const cap of next.summary.captions ?? []) expect(cap.end).toBeLessThanOrEqual(c.duration + 1e-5)
        cur = next
      }
    }
  })
})

describe('contract audio', () => {
  it('accepts a normalization gain above 1 (HyperFrames goes to about +12 dB) and edits it', () => {
    const loud = musicHtml.replace('data-volume="0.8"', 'data-volume="1.64059"')
    expect(validate(loud, summary)).toEqual([])
    const out = applyEdits(loud, summary, [{ op: 'audio', id: 'music', volume: 2 }], {})
    expect(out.composition.audio.find((a) => a.id === 'music')?.volume).toBe(2)
  })

  const sfx = '<audio id="sfx-pop" src="assets/sfx/pop.mp3" data-start="0.4" data-volume="0.35"></audio>'
  const withSfx = musicHtml.replace(
    '<div class="kicker" data-va-text="intro-kicker">',
    `${sfx}<div class="kicker" data-va-text="intro-kicker">`,
  )
  const music = (h: string) => read(load(h)).audio.find((a) => a.id === 'music')

  it('reads the music layer and effects as audio tracks', () => {
    expect(validate(withSfx, summary)).toEqual([])
    const c = read(load(withSfx))
    expect(c.layers).toEqual(['music', 'glow'])
    expect(c.audio).toEqual([
      {
        id: 'music',
        role: 'music',
        label: 'Music',
        src: 'assets/media/med_theme01.mp3',
        volume: 0.8,
        muted: false,
        beat: null,
      },
      {
        id: 'sfx-pop',
        role: 'sfx',
        label: null,
        src: 'assets/sfx/pop.mp3',
        volume: 0.35,
        muted: false,
        beat: 'intro',
      },
    ])
    // A voice line names its role; audio without an id isn't in the mix, so it isn't listed.
    const voice = withSfx.replace(
      sfx,
      '<audio id="vo-intro" data-va-audio="voice" src="assets/voice/intro.mp3" data-start="0"></audio><audio src="assets/sfx/x.mp3"></audio>',
    )
    expect(read(load(voice)).audio.map((a) => [a.id, a.role, a.volume, a.beat])).toEqual([
      ['music', 'music', 0.8, null],
      ['vo-intro', 'voice', 1, 'intro'],
    ])
  })

  it.each([
    [
      'audio outside assets/',
      (h: string) => h.replace('assets/media/med_theme01.mp3', 'https://cdn.example.com/a.mp3'),
      /must use a file in assets\//,
    ],
    [
      'a way out of assets/',
      (h: string) => h.replace('assets/media/med_theme01.mp3', 'assets/../secret.mp3'),
      /must use a file in assets\//,
    ],
    [
      'volume above HyperFrames’ maximum gain',
      (h: string) => h.replace('data-volume="0.8"', 'data-volume="4.5"'),
      /data-volume between 0 and 4/,
    ],
    [
      'an unknown role',
      (h: string) => h.replace('data-va-layer="music"', 'data-va-layer="music" data-va-audio="drums"'),
      /use music, voice or sfx/,
    ],
    [
      'muted but audible',
      (h: string) => h.replace('data-volume="0.8"', 'data-volume="0.8" data-va-muted'),
      /needs data-volume="0"/,
    ],
    [
      'a music layer without an id',
      (h: string) => h.replace('<audio id="music"', '<audio'),
      /music layer must be an <audio> with an id/,
    ],
    [
      'duplicate audio ids',
      (h: string) =>
        h.replace(
          '<div class="kicker"',
          '<audio id="music" src="assets/sfx/a.mp3"></audio><div class="kicker"',
        ),
      /Audio id "music" is used twice/,
    ],
  ])('rejects %s', (_n, mutate, msg) => {
    expect(validate(mutate(musicHtml)).join(' ')).toMatch(msg)
  })

  it('swaps the music for a library file, dropping the old trim point', () => {
    const trimmed = musicHtml.replace('data-volume="0.8"', 'data-volume="0.8" data-media-start="12"')
    const out = applyEdits(trimmed, summary, [
      { op: 'audio', id: 'music', src: 'assets/media/med_other02.m4a' },
    ])
    expect(music(out.html)).toMatchObject({ src: 'assets/media/med_other02.m4a', volume: 0.8, muted: false })
    expect(out.html).not.toContain('data-media-start')
    // Fades and the layer span stay.
    expect(out.html).toMatch(/<audio id="music"[^>]*data-fade-in="1" data-fade-out="1.5"/)
    expect(() =>
      applyEdits(musicHtml, summary, [{ op: 'audio', id: 'music', src: '../../etc/passwd' }]),
    ).toThrow(/assets\/media/)
    expect(() => applyEdits(musicHtml, summary, [{ op: 'audio', id: 'nope', volume: 0.5 }])).toThrow(
      /no audio "nope"/,
    )
  })

  it('sets the volume as data-volume, which HyperFrames applies in preview and render', () => {
    const out = applyEdits(musicHtml, summary, [{ op: 'audio', id: 'music', volume: 0.456 }])
    expect(out.html).toMatch(/<audio id="music"[^>]*data-volume="0.46"/)
    expect(music(out.html)?.volume).toBe(0.46)
    for (const volume of [-0.1, 4.2, Number.NaN])
      expect(() => applyEdits(musicHtml, summary, [{ op: 'audio', id: 'music', volume }])).toThrow(/0 to 4/)
  })

  it('mutes with data-volume="0", keeps the level, and unmutes back to it', () => {
    const muted = applyEdits(musicHtml, summary, [{ op: 'audio', id: 'music', muted: true }])
    expect(muted.html).toMatch(/<audio id="music"[^>]*data-volume="0" data-va-volume="0.8" data-va-muted=""/)
    expect(music(muted.html)).toMatchObject({ volume: 0.8, muted: true })
    // The element stays (with its src), so it can come back.
    expect(muted.composition.layers).toContain('music')
    const quieter = applyEdits(muted.html, muted.summary, [{ op: 'audio', id: 'music', volume: 0.3 }])
    expect(music(quieter.html)).toMatchObject({ volume: 0.3, muted: true })
    expect(quieter.html).toMatch(/data-volume="0"/)
    const back = applyEdits(quieter.html, quieter.summary, [{ op: 'audio', id: 'music', muted: false }])
    expect(music(back.html)).toMatchObject({ volume: 0.3, muted: false })
    expect(back.html).toMatch(/<audio id="music"[^>]*data-volume="0.3"/)
    expect(back.html).not.toMatch(/data-va-muted|data-va-volume/)
  })

  it('keeps the music spanning the video through retimes, deletes and reorders', () => {
    const out = applyEdits(musicHtml, summary, [
      { op: 'audio', id: 'music', src: 'assets/media/med_other02.mp3', volume: 0.5 },
      { op: 'retime', beat: 'intro', duration: 4.5 },
      { op: 'delete', beat: 'demo' },
      { op: 'reorder', order: ['outro', 'intro'] },
    ])
    expect(out.composition.duration).toBe(7.5)
    expect(out.html).toMatch(/<audio id="music"[^>]*data-start="0" data-duration="7.5"/)
    expect(validate(out.html, out.summary)).toEqual([])
  })

  it('edits effects inside beats by id too', () => {
    const out = applyEdits(withSfx, summary, [{ op: 'audio', id: 'sfx-pop', muted: true }])
    expect(read(load(out.html)).audio.find((a) => a.id === 'sfx-pop')).toMatchObject({
      volume: 0.35,
      muted: true,
      beat: 'intro',
    })
  })
})

describe('narration lines and re-voicing', () => {
  const vfx = (f: string) =>
    readFileSync(new URL(`../../test/fixtures/contract1-voice/${f}`, import.meta.url), 'utf8')
  const vHtml = vfx('index.html')
  const vSummary = JSON.parse(vfx('summary.json')) as Summary
  const narration = {
    intro: 'Meet org webhooks. One place for every event.',
    outro: 'Read the docs.',
  }
  const voiceOp = (beat: string, text: string): EditOp => ({ op: 'voice', beat, text })

  it("shows each voiced beat's line, and none without the voice script", () => {
    expect(applyEdits(vHtml, vSummary, [], { narration }).composition.narration).toEqual([
      { beat: 'intro', text: narration.intro, revoice: false },
      { beat: 'outro', text: 'Read the docs.', revoice: false },
    ])
    expect(read(load(vHtml)).narration).toEqual([])
  })

  it('a voice op records the line and marks the clip; the old audio stays for the preview', () => {
    const out = applyEdits(vHtml, vSummary, [voiceOp('outro', '  Read the   docs today. ')], { narration })
    expect(out.narration).toEqual({ ...narration, outro: 'Read the docs today.' })
    expect(out.composition.narration[1]).toEqual({
      beat: 'outro',
      text: 'Read the docs today.',
      revoice: true,
    })
    expect(out.html).toMatch(/data-va-voice="outro"[^>]*data-va-revoice=""/)
    // Same file, same length, same captions: the draft plays as before.
    expect(out.composition.beats[2]?.voice).toEqual(read(load(vHtml)).beats[2]?.voice)
    expect(out.summary).toEqual(vSummary)
    expect(validate(out.html, out.summary)).toEqual([])
    // Back to the spoken words (whitespace aside): nothing to re-voice.
    const back = applyEdits(out.html, out.summary, [voiceOp('outro', 'Read  the docs.')], { narration })
    expect(back.html).not.toContain('data-va-revoice')
  })

  it('refuses lines for beats without a voice, empty, too long, or with markup', () => {
    const bad =
      (op: EditOp, opts = { narration }) =>
      () =>
        applyEdits(vHtml, vSummary, [op], opts)
    expect(bad(voiceOp('demo', 'Hi.'))).toThrow(/no narration/)
    expect(bad(voiceOp('nope', 'Hi.'))).toThrow(/no beat "nope"/)
    expect(bad(voiceOp('intro', 'Hi.'), { narration: {} as typeof narration })).toThrow(/no narration/)
    expect(bad(voiceOp('intro', '   '))).toThrow(/needs some words/)
    expect(bad(voiceOp('intro', 'a'.repeat(601)))).toThrow(/under 600/)
    expect(bad(voiceOp('intro', 'Pause <break time="1s"/> here'))).toThrow(/plain text/)
    expect(bad(voiceOp('intro', 'Bell \u0007 here'))).toThrow(/plain text/)
    // The mark only goes on a voice.
    expect(
      validate(vHtml.replace('data-va-text="demo-sub"', 'data-va-text="demo-sub" data-va-revoice'), vSummary),
    ).toContainEqual(expect.stringMatching(/only goes on a voice/))
  })

  it('applyRevoice: a longer line that no longer fits grows its beat; later beats, captions and the dip follow', () => {
    const marked = applyEdits(vHtml, vSummary, [voiceOp('intro', 'A much longer opening line.')], {
      narration,
    })
    const cues = [
      { text: 'A much longer', start: 0.3, end: 1.8 },
      { text: 'opening line.', start: 2.1, end: 3.5 },
    ]
    const out = applyRevoice(marked.html, marked.summary, [
      { beat: 'intro', file: 'assets/voice/intro.wav', duration: 3.2, minBeat: 3.9, cues },
    ])
    expect(out.lengthened).toEqual([{ beat: 'intro', from: 3, to: 3.9 }])
    const c = read(load(out.html))
    expect(c.beats.map((b) => [b.id, b.start, b.duration])).toEqual([
      ['intro', 0, 3.9],
      ['demo', 3.9, 3],
      ['outro', 6.9, 3],
    ])
    expect(c.duration).toBe(9.9)
    expect(c.beats[0]?.voice).toMatchObject({ start: 0.3, duration: 3.2 })
    expect(out.html).not.toContain('data-va-revoice')
    expect(out.summary.captions?.map((x) => [x.beat, x.text, x.start, x.end])).toEqual([
      ['intro', 'A much longer', 0.3, 1.8],
      ['intro', 'opening line.', 2.1, 3.5],
      ['demo', 'One subscription for every project', 4.4, 6.9],
      ['outro', 'Read the docs.', 7.1, 8.6],
    ])
    expect(validate(out.html, out.summary)).toEqual([])
    // The music layer spans the longer video.
    expect(out.html).toMatch(/id="music"[^>]*data-duration="9.9"/)
  })

  it('applyRevoice: a shorter line keeps its beat, and every mark must be re-voiced', () => {
    const marked = applyEdits(
      vHtml,
      vSummary,
      [voiceOp('intro', 'Org webhooks.'), voiceOp('outro', 'Docs.')],
      {
        narration,
      },
    )
    const line = { beat: 'intro', file: 'assets/voice/intro.wav', duration: 1, minBeat: 1.7, cues: [] }
    expect(() => applyRevoice(marked.html, marked.summary, [line])).toThrow(
      /"outro" is marked but wasn't re-voiced/,
    )
    const out = applyRevoice(marked.html, marked.summary, [
      line,
      { ...line, beat: 'outro', file: 'assets/voice/outro.wav', duration: 0.5, minBeat: 1.1 },
    ])
    expect(out.lengthened).toEqual([])
    expect(read(load(out.html)).duration).toBe(9)
    expect(() => applyRevoice(vHtml, vSummary, [line])).toThrow(/isn't marked/)
  })
})
