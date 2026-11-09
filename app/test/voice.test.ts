// Voice-over (docs/spikes.md S9): phrase timing, the run script with a fake provider, sync into captions and ducking,
// and the editing contract's voice rules.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateVoice, readVoice, revoiceVideo, syncVoice } from '../../scripts/voice.js'
import { elevenlabs, pickProvider } from '../../scripts/lib/voice-providers.js'
import { bundleManifest, compositionFiles } from '../server/lib/bundle-manifest.js'
import { checkRevoiced, FROZEN_FILES, keptHash } from '../server/lib/revoice.js'
import { applyEdits, duckPoints, load, read, validate, type Summary } from '../server/lib/contract.js'
import {
  SAMPLE_RATE,
  estimateWords,
  layoutBeat,
  joinPcm,
  minBeatSeconds,
  parseScript,
  pauseAfter,
  splitPhrases,
  spokenText,
  voiceCaptions,
  wav,
  wordsFromCharacters,
  type Speech,
  type VoiceProvider,
} from '../server/lib/voice.js'

const fx = (f: string) => readFileSync(new URL(`./fixtures/contract1/${f}`, import.meta.url), 'utf8')
const baseHtml = fx('index.html')
const baseSummary = JSON.parse(fx('summary.json')) as Summary

const MUSIC =
  '<audio id="music" data-va-layer="music" data-va-duck="0.3" src="assets/media/med_abc12345.mp3" data-start="0" data-duration="9" data-track-index="2" data-volume="0.8"></audio>'
const voiceTag = (beat: string, start: number, dur: number) =>
  `<audio id="voice-${beat}" data-va-voice="${beat}" src="assets/voice/${beat}.wav" data-start="${start}" data-duration="${dur}" data-track-index="3" data-volume="1"></audio>`

/** The contract fixture with voices in intro (0.3 + 2.2 s) and outro (0.2 + 1.5 s) and a ducked music layer. */
function voicedHtml(lane?: string) {
  return baseHtml
    .replace(
      '<section id="intro"',
      `${MUSIC.replace('></audio>', lane ? ` data-automation='${lane}'></audio>` : '></audio>')}\n      <section id="intro"`,
    )
    .replace(/(data-va-beat="intro"[^>]*>)/, `$1\n        ${voiceTag('intro', 0.3, 2.2)}`)
    .replace(/(data-va-beat="outro"[^>]*>)/, `$1\n        ${voiceTag('outro', 0.2, 1.5)}`)
}
const LANE_POINTS = [
  { t: 0, v: 1 },
  { t: 0.05, v: 1 },
  { t: 0.3, v: 0.3 },
  { t: 2.5, v: 0.3 },
  { t: 2.9, v: 1 },
  { t: 5.95, v: 1 },
  { t: 6.2, v: 0.3 },
  { t: 7.7, v: 0.3 },
  { t: 8.1, v: 1 },
]
const LANE = JSON.stringify({ version: 1, lanes: [{ target: 'volume', points: LANE_POINTS }] })
const voiceSummary: Summary = {
  ...baseSummary,
  captions: [
    {
      start: 0.3,
      end: 1.2,
      text: 'Meet org webhooks.',
      beat: 'intro',
      voice: true,
      beatStart: 0.3,
      beatEnd: 1.2,
    },
    {
      start: 1.5,
      end: 2.5,
      text: 'One place for every event.',
      beat: 'intro',
      voice: true,
      beatStart: 1.5,
      beatEnd: 2.5,
    },
    {
      start: 3.5,
      end: 6,
      text: 'One subscription for every project',
      beat: 'demo',
      textId: 'demo-sub',
      beatStart: 0.5,
      beatEnd: 3,
    },
    {
      start: 6.2,
      end: 7.7,
      text: 'Read the docs.',
      beat: 'outro',
      voice: true,
      beatStart: 0.2,
      beatEnd: 1.7,
    },
  ],
}

/** A fake provider: 0.1 s of tone per word, as raw PCM, with word times when asked. */
function fakeProvider(name = 'fake', withWords = false) {
  const calls: string[] = []
  const provider: VoiceProvider = {
    name,
    synthesize(text) {
      calls.push(text)
      const n = text.split(' ').length
      const samples = Math.round(n * 0.1 * SAMPLE_RATE)
      const audio = new Uint8Array(samples * 2).fill(7)
      const speech: Speech = { audio, format: 'pcm' }
      if (withWords)
        speech.words = text.split(' ').map((w, i) => ({ text: w, start: i * 0.1, end: i * 0.1 + 0.09 }))
      return Promise.resolve(speech)
    },
  }
  return { provider, calls }
}

describe('phrases and timing', () => {
  it('splits sentences, and long sentences at commas and then every few words', () => {
    expect(splitPhrases('  Meet org webhooks.  One place for every event!  ')).toEqual([
      'Meet org webhooks.',
      'One place for every event!',
    ])
    const long =
      'Every deploy, every form submission and every failed build can reach your endpoint, signed and retried for you automatically.'
    const parts = splitPhrases(long)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.join(' ')).toBe(long)
    for (const p of parts) expect(p.split(' ').length).toBeLessThanOrEqual(12)
    expect(splitPhrases('')).toEqual([])
  })

  it('pauses longer after a sentence than after a comma', () => {
    expect(pauseAfter('Done.')).toBe(0.3)
    expect(pauseAfter('"Done!"')).toBe(0.3)
    expect(pauseAfter('First,')).toBe(0.15)
    expect(pauseAfter('and then')).toBe(0.06)
  })

  it('lays clips back to back with pauses, so cues start and end exactly where their audio does', () => {
    const laid = layoutBeat([
      { text: 'Meet org webhooks.', seconds: 1.2 },
      { text: 'Signed,', seconds: 0.5, words: [{ text: 'Signed,', start: 0.05, end: 0.45 }] },
      { text: 'and retried', seconds: 0.8 },
    ])
    expect(laid.cues).toEqual([
      { text: 'Meet org webhooks.', start: 0, end: 1.2 },
      { text: 'Signed,', start: 1.5, end: 2 },
      { text: 'and retried', start: 2.15, end: 2.95 },
    ])
    expect(laid.placements.map((p) => p.offsetSamples)).toEqual([0, 1.5 * SAMPLE_RATE, 2.15 * SAMPLE_RATE])
    expect(laid.duration).toBe(2.95)
    // Provider words are shifted to the beat's clock; the others are estimated inside their phrase.
    expect(laid.words).toContainEqual({ text: 'Signed,', start: 1.55, end: 1.95 })
    expect(laid.words[0]).toMatchObject({ text: 'Meet', start: 0 })
    expect(laid.words[2]?.end).toBeCloseTo(1.2, 3)
    expect(laid.estimated).toBe(true)
  })

  it('spreads estimated words by letters and reads provider character times', () => {
    const w = estimateWords('a webhooks', 0, 1)
    expect(w[0]?.end).toBeLessThan(w[1]!.end - w[1]!.start)
    expect(w[1]?.end).toBe(1)
    expect(
      wordsFromCharacters(['H', 'i', ' ', 'y', 'o'], [0, 0.1, 0.2, 0.3, 0.4], [0.1, 0.2, 0.3, 0.4, 0.5]),
    ).toEqual([
      { text: 'Hi', start: 0, end: 0.2 },
      { text: 'yo', start: 0.3, end: 0.5 },
    ])
  })

  it('writes a valid WAV of the laid-out length', () => {
    const wav = joinPcm(
      [new Uint8Array(4).fill(1), new Uint8Array(4).fill(2)],
      [{ offsetSamples: 0 }, { offsetSamples: 4 }],
      6,
    )
    expect(Buffer.from(wav.subarray(0, 4)).toString()).toBe('RIFF')
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(SAMPLE_RATE)
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(12)
    expect([...wav.subarray(44)]).toEqual([1, 1, 1, 1, 0, 0, 0, 0, 2, 2, 2, 2])
  })

  it('rounds the shortest beat up from lead + voice + tail', () => {
    expect(minBeatSeconds(0.3, 2.2)).toBe(2.9)
    expect(minBeatSeconds(0, 1.01)).toBe(1.5)
  })

  it('checks script.json', () => {
    expect(
      parseScript('{"lines":[{"beat":"intro","text":"Hi."}],"voice":"af_heart","speed":1.1}').lines,
    ).toHaveLength(1)
    expect(() => parseScript('{"lines":[]}')).toThrow(/lines/)
    expect(() => parseScript('{"lines":[{"beat":"Intro","text":"Hi."}]}')).toThrow(/beat id/)
    expect(() => parseScript('{"lines":[{"beat":"a","text":"x"},{"beat":"a","text":"y"}]}')).toThrow(
      /two lines/,
    )
    expect(() => parseScript('{"lines":[{"beat":"a","text":"x"}],"speed":3}')).toThrow(/speed/)
    expect(() => parseScript('{"lines":[{"beat":"a","text":"x"}],"voice":"a b"}')).toThrow(/voice/)
  })
})

describe('spoken forms', () => {
  it('swaps whole terms only, keeping everything else as written', () => {
    expect(spokenText('Two CLIs, the CLI and an A/B test, 24/7.')).toBe(
      "Two C-L-I's, the CLI and an A-B test, twenty four seven.",
    )
    expect(spokenText('Edit .env, e.g. on Vite vs. Deno.')).toBe(
      'Edit dot env, for example on veet versus dee-no.',
    )
    expect(spokenText('Loads in 1.5 ms or 50ms.')).toBe('Loads in 1.5 milliseconds or 50 milliseconds.')
    // Not inside other words, and case matters.
    expect(spokenText('Visit Vitesse, saas.dev, an ISRs list, items, forms and ARRow.')).toBe(
      'Visit Vitesse, saas.dev, an ISRs list, items, forms and ARRow.',
    )
    expect(spokenText('Meet org webhooks.')).toBe('Meet org webhooks.')
  })
})

describe('captions from the voice', () => {
  it('makes one cue per phrase, offset by the beat start and the voice lead', () => {
    const caps = voiceCaptions(
      [
        { id: 'intro', start: 0, voice: { start: 0.3 } },
        { id: 'demo', start: 3, voice: null },
        { id: 'outro', start: 6, voice: { start: 0.2 } },
      ],
      {
        beats: [
          {
            beat: 'intro',
            text: '',
            hash: '',
            file: '',
            duration: 2.2,
            cues: [{ text: 'Meet org webhooks.', start: 0, end: 0.9 }],
            words: [],
            estimated: true,
          },
          {
            beat: 'outro',
            text: '',
            hash: '',
            file: '',
            duration: 1.5,
            cues: [{ text: 'Read the docs.', start: 0, end: 1.5 }],
            words: [],
            estimated: true,
          },
        ],
      },
    )
    expect(caps).toEqual([
      {
        start: 0.3,
        end: 1.2,
        text: 'Meet org webhooks.',
        beat: 'intro',
        voice: true,
        beatStart: 0.3,
        beatEnd: 1.2,
      },
      {
        start: 6.2,
        end: 7.7,
        text: 'Read the docs.',
        beat: 'outro',
        voice: true,
        beatStart: 0.2,
        beatEnd: 1.7,
      },
    ])
  })
})

describe('scripts/voice.ts', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'va-voice-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const script = {
    lines: [
      { beat: 'intro', text: 'Meet org webhooks. One place for every event.' },
      { beat: 'outro', text: 'Read the docs.' },
    ],
  }

  it('speaks each beat into one file with cues, and reuses unchanged beats', async () => {
    const fake = fakeProvider()
    const v = await generateVoice(dir, script, { provider: fake.provider, voice: 'af_heart', speed: 1 })
    expect(fake.calls).toEqual(['Meet org webhooks.', 'One place for every event.', 'Read the docs.'])
    expect(v.beats.map((b) => [b.beat, b.file, b.duration])).toEqual([
      ['intro', 'assets/voice/intro.wav', 1.1], // 0.3 s + 0.3 s pause + 0.5 s
      ['outro', 'assets/voice/outro.wav', 0.3],
    ])
    expect(v.beats[0]?.cues).toEqual([
      { text: 'Meet org webhooks.', start: 0, end: 0.3 },
      { text: 'One place for every event.', start: 0.6, end: 1.1 },
    ])
    const wav = readFileSync(join(dir, 'assets/voice/intro.wav'))
    expect(wav.length).toBe(44 + Math.round(1.1 * SAMPLE_RATE) * 2)
    expect(readVoice(dir)?.provider).toBe('fake')

    // Same script: nothing is spoken again. A changed line re-speaks only its beat.
    await generateVoice(dir, script, { provider: fake.provider, voice: 'af_heart', speed: 1 })
    expect(fake.calls).toHaveLength(3)
    await generateVoice(
      dir,
      { lines: [script.lines[0]!, { beat: 'outro', text: 'Read the docs today.' }] },
      { provider: fake.provider, voice: 'af_heart', speed: 1 },
    )
    expect(fake.calls.slice(3)).toEqual(['Read the docs today.'])
    // A new voice or speed re-speaks everything.
    await generateVoice(dir, script, { provider: fake.provider, voice: 'am_adam', speed: 1 })
    expect(fake.calls).toHaveLength(7)
  })

  it('keeps provider word times', async () => {
    const v = await generateVoice(
      dir,
      { lines: [{ beat: 'intro', text: 'Hi there.' }] },
      {
        provider: fakeProvider('fake', true).provider,
        voice: 'x',
        speed: 1,
      },
    )
    expect(v.beats[0]?.estimated).toBe(false)
    expect(v.beats[0]?.words).toEqual([
      { text: 'Hi', start: 0, end: 0.09 },
      { text: 'there.', start: 0.1, end: 0.19 },
    ])
  })

  it('speaks tricky terms as SPOKEN_AS says, and captions keep the written words', async () => {
    const fake = fakeProvider('fake', true)
    const v = await generateVoice(
      dir,
      { lines: [{ beat: 'intro', text: 'Ship SaaS with CI/CD in 50ms. Read the docs.' }] },
      { provider: fake.provider, voice: 'x', speed: 1 },
    )
    expect(fake.calls).toEqual(['Ship sass with CI CD in 50 milliseconds.', 'Read the docs.'])
    expect(v.beats[0]?.cues.map((c) => c.text)).toEqual(['Ship SaaS with CI/CD in 50ms.', 'Read the docs.'])
    // The provider's words were for the spoken phrase, so that phrase's words are spread over its written ones.
    expect(v.beats[0]?.words.map((w) => w.text)).toEqual([
      'Ship',
      'SaaS',
      'with',
      'CI/CD',
      'in',
      '50ms.',
      'Read',
      'the',
      'docs.',
    ])
    expect(v.beats[0]?.estimated).toBe(true)
  })

  it('reads "backend" as two words, so the stress lands on "back"', () => {
    expect(spokenText('Backends and a backend. Backend first.')).toBe(
      'Back ends and a back end. Back end first.',
    )
  })

  it('says every form of "deploy" with a full "dee"', () => {
    expect(spokenText('Deploy it. We deployed, redeploying deployments.')).toBe(
      'Dee-ploy it. We dee-ployed, ree-dee-ploying dee-ployments.',
    )
  })

  it('voice files are part of the composition (kept in the source archive and frozen bundles)', async () => {
    await generateVoice(dir, script, { provider: fakeProvider().provider, voice: 'af_heart', speed: 1 })
    writeFileSync(join(dir, 'assets/voice/script.json'), JSON.stringify(script))
    writeFileSync(join(dir, 'index.html'), '<html></html>')
    expect(compositionFiles(dir)).toEqual([
      'assets/voice/intro.wav',
      'assets/voice/outro.wav',
      'assets/voice/script.json',
      'assets/voice/voice.json',
      'index.html',
    ])
  })

  it('sync writes narration captions and the ducking lane, and the result keeps the contract', async () => {
    mkdirSync(join(dir, 'assets/voice'), { recursive: true })
    writeFileSync(
      join(dir, 'assets/voice/voice.json'),
      JSON.stringify({
        v: 1,
        provider: 'fake',
        voice: 'af_heart',
        speed: 1,
        beats: [
          {
            beat: 'intro',
            text: '',
            hash: 'h',
            file: 'assets/voice/intro.wav',
            duration: 2.2,
            cues: [
              { text: 'Meet org webhooks.', start: 0, end: 0.9 },
              { text: 'One place for every event.', start: 1.2, end: 2.2 },
            ],
            words: [],
            estimated: true,
          },
          {
            beat: 'outro',
            text: '',
            hash: 'h',
            file: 'assets/voice/outro.wav',
            duration: 1.5,
            cues: [{ text: 'Read the docs.', start: 0, end: 1.5 }],
            words: [],
            estimated: true,
          },
        ],
      }),
    )
    writeFileSync(join(dir, 'index.html'), voicedHtml())
    writeFileSync(join(dir, 'summary.json'), JSON.stringify(baseSummary))
    expect(syncVoice(dir)).toEqual([])
    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as Summary
    expect(summary.title).toBe('Org webhooks')
    // Voiced beats get narration cues; the beat without a voice keeps its text caption.
    expect(summary.captions?.map((c) => [c.start, c.end, c.text, c.voice ?? false])).toEqual([
      [0.3, 1.2, 'Meet org webhooks.', true],
      [1.5, 2.5, 'One place for every event.', true],
      [3.5, 6, 'One subscription for every project', false],
      [6.2, 7.7, 'Read the docs.', true],
    ])
    const html = readFileSync(join(dir, 'index.html'), 'utf8')
    expect(validate(html, summary)).toEqual([])
    expect(html).toContain('data-automation=')
  })

  it('sync leaves recorded-narration cues as they are', async () => {
    mkdirSync(join(dir, 'assets/voice'), { recursive: true })
    writeFileSync(
      join(dir, 'assets/voice/voice.json'),
      JSON.stringify({
        v: 1,
        provider: 'fake',
        voice: 'af_heart',
        speed: 1,
        beats: [
          {
            beat: 'intro',
            text: '',
            hash: 'h',
            file: 'assets/voice/intro.wav',
            duration: 2.2,
            cues: [{ text: 'Meet org webhooks.', start: 0, end: 0.9 }],
            words: [],
            estimated: true,
          },
          {
            beat: 'outro',
            text: '',
            hash: 'h',
            file: 'assets/voice/outro.wav',
            duration: 1.5,
            cues: [{ text: 'Read the docs.', start: 0, end: 1.5 }],
            words: [],
            estimated: true,
          },
        ],
      }),
    )
    const cue = {
      narration: true,
      id: 'nc_0123456789ab',
      start: 2.6,
      end: 3.4,
      text: 'My own words',
      words: [{ text: 'My', start: 2.6, end: 2.8 }],
    }
    writeFileSync(join(dir, 'index.html'), voicedHtml())
    writeFileSync(
      join(dir, 'summary.json'),
      JSON.stringify({ ...baseSummary, captions: [...(baseSummary.captions ?? []), cue] }),
    )
    expect(syncVoice(dir)).toEqual([])
    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as Summary
    expect(summary.captions?.filter((c) => c.narration)).toEqual([cue])
    expect(validate(readFileSync(join(dir, 'index.html'), 'utf8'), summary)).toEqual([])
  })

  it('sync refuses a voice placed wrong, and writes nothing', () => {
    mkdirSync(join(dir, 'assets/voice'), { recursive: true })
    writeFileSync(
      join(dir, 'assets/voice/voice.json'),
      JSON.stringify({
        v: 1,
        provider: 'fake',
        voice: 'af_heart',
        speed: 1,
        beats: [
          {
            beat: 'intro',
            text: '',
            hash: 'h',
            file: 'assets/voice/intro.wav',
            duration: 2.9,
            cues: [],
            words: [],
            estimated: true,
          },
          {
            beat: 'demo',
            text: '',
            hash: 'h',
            file: 'assets/voice/demo.wav',
            duration: 1,
            cues: [],
            words: [],
            estimated: true,
          },
        ],
      }),
    )
    writeFileSync(join(dir, 'index.html'), voicedHtml())
    const problems = syncVoice(dir)
    expect(problems).toContainEqual(expect.stringMatching(/intro.*data-duration="2.9"/))
    expect(problems).toContainEqual(expect.stringMatching(/intro.*needs at least 3.6s/))
    expect(problems).toContainEqual(expect.stringMatching(/demo.*no <audio data-va-voice="demo"/))
    expect(problems).toContainEqual(expect.stringMatching(/outro.*no line in voice.json/))
    expect(existsSync(join(dir, 'summary.json'))).toBe(false)
  })
})

describe('providers', () => {
  it('picks Kokoro for Kokoro voices and by default, ElevenLabs for other ids when its key is set', () => {
    expect(pickProvider('am_michael', {}, '/tmp')).toMatchObject({
      voice: 'am_michael',
      provider: { name: 'kokoro' },
    })
    expect(pickProvider(undefined, {}, '/tmp')).toMatchObject({
      voice: 'af_heart',
      provider: { name: 'kokoro' },
    })
    expect(pickProvider(undefined, { ELEVENLABS_API_KEY: 'k' }, '/tmp').provider.name).toBe('elevenlabs')
    expect(pickProvider('AbC123', { ELEVENLABS_API_KEY: 'k' }, '/tmp')).toMatchObject({ voice: 'AbC123' })
    expect(() => pickProvider('AbC123', {}, '/tmp')).toThrow(/ELEVENLABS_API_KEY/)
  })

  it('ElevenLabs returns MP3 with word times from its alignment, and reports refusals without the key', async () => {
    let sent: { url: string; headers: Record<string, string>; body: string } | null = null
    const ok = (async (url: string, init: RequestInit) => {
      sent = { url, headers: init.headers as Record<string, string>, body: init.body as string }
      return new Response(
        JSON.stringify({
          audio_base64: Buffer.from('mp3').toString('base64'),
          alignment: {
            characters: ['H', 'i'],
            character_start_times_seconds: [0, 0.1],
            character_end_times_seconds: [0.1, 0.2],
          },
        }),
      )
    }) as unknown as typeof fetch
    const s = await elevenlabs('secret-key', ok).synthesize('Hi', { voice: 'voice1', speed: 1.5 })
    expect(s.format).toBe('mp3')
    expect(s.words).toEqual([{ text: 'Hi', start: 0, end: 0.2 }])
    expect(sent!.url).toContain('/v1/text-to-speech/voice1/with-timestamps')
    expect(JSON.parse(sent!.body)).toMatchObject({ text: 'Hi', voice_settings: { speed: 1.2 } })
    const refused = (async () =>
      new Response(JSON.stringify({ detail: { message: 'quota exceeded' } }), {
        status: 401,
      })) as unknown as typeof fetch
    await expect(
      elevenlabs('secret-key', refused).synthesize('Hi', { voice: 'v', speed: 1 }),
    ).rejects.toThrow(/^ElevenLabs returned 401: quota exceeded\.$/)
  })
})

describe('contract: voice and ducking', () => {
  const html = voicedHtml(LANE)

  it('reads each beat voice and accepts voice captions without a text id', () => {
    expect(validate(html, voiceSummary)).toEqual([])
    const c = read(load(html))
    expect(c.beats.map((b) => b.voice)).toEqual([
      { id: 'voice-intro', src: 'assets/voice/intro.wav', start: 0.3, duration: 2.2 },
      null,
      { id: 'voice-outro', src: 'assets/voice/outro.wav', start: 0.2, duration: 1.5 },
    ])
    expect(duckPoints(load(html), 0.3)).toEqual(LANE_POINTS)
  })

  it('refuses voices outside their beat, without an id, outside assets/voice/, running past the beat, or two in a beat', () => {
    const bad = (from: string, to: string) => validate(html.replace(from, to), voiceSummary)
    expect(bad('data-duration="2.2"', 'data-duration="2.9"')).toContainEqual(
      expect.stringMatching(/Beat "intro" is 3s but its voice-over runs to 3.2s/),
    )
    expect(bad('id="voice-intro" ', '')).toContainEqual(expect.stringMatching(/needs an id/))
    expect(bad('src="assets/voice/intro.wav"', 'src="https://x.test/a.wav"')).toContainEqual(
      expect.stringMatching(/assets\/voice\//),
    )
    expect(bad('data-va-voice="intro"', 'data-va-voice="demo"')).toContainEqual(
      expect.stringMatching(/direct child of beat "demo"/),
    )
    expect(
      bad(
        voiceTag('intro', 0.3, 2.2),
        `${voiceTag('intro', 0.3, 2.2)}${voiceTag('intro', 0.3, 2.2).replace('voice-intro', 'voice-intro-2')}`,
      ),
    ).toContainEqual(expect.stringMatching(/more than one voice/))
    // A voice cue must point at a voiced beat.
    expect(
      validate(html, {
        ...voiceSummary,
        captions: [{ start: 3, end: 4, text: 'x', beat: 'demo', voice: true, beatStart: 0, beatEnd: 1 }],
      }),
    ).toContainEqual(expect.stringMatching(/needs the beat whose voice-over/))
  })

  it('refuses stale ducking and tells the agent how to fix it', () => {
    expect(validate(voicedHtml(), voiceSummary)).toContainEqual(expect.stringMatching(/voice\.ts sync/))
    expect(validate(voicedHtml(LANE.replace('"v":0.3', '"v":0.6')), voiceSummary)).toContainEqual(
      expect.stringMatching(/ducking/),
    )
  })

  it('a stretch keeps voice cues at their spoken times; a reorder moves voice, cues and the dip together', () => {
    const stretched = applyEdits(html, voiceSummary, [{ op: 'retime', beat: 'intro', duration: 4.5 }])
    const caps = stretched.summary.captions ?? []
    expect(caps.filter((c) => c.beat === 'intro').map((c) => [c.start, c.end])).toEqual([
      [0.3, 1.2],
      [1.5, 2.5],
    ])
    // The text caption in the next beat moves with the beat start.
    expect(caps.find((c) => c.beat === 'demo')?.start).toBe(5)
    expect(caps.find((c) => c.beat === 'outro')?.start).toBeCloseTo(7.7, 5)

    const reordered = applyEdits(html, voiceSummary, [{ op: 'reorder', order: ['outro', 'demo', 'intro'] }])
    expect(reordered.summary.captions?.filter((c) => c.voice).map((c) => [c.beat, c.start])).toEqual([
      ['outro', 0.2],
      ['intro', 6.3],
      ['intro', 7.5],
    ])
    expect(validate(reordered.html, reordered.summary)).toEqual([])
    // The outro's voice now starts 0.2 s in, so the music starts ducked.
    expect(duckPoints(load(reordered.html), 0.3)?.slice(0, 3)).toEqual([
      { t: 0, v: 0.3 },
      { t: 1.7, v: 0.3 },
      { t: 2.1, v: 1 },
    ])
  })

  it('refuses a retime shorter than the voice-over', () => {
    expect(() => applyEdits(html, voiceSummary, [{ op: 'retime', beat: 'intro', duration: 2 }])).toThrow(
      /voice-over runs to 2.5s/,
    )
  })
})

describe('voice in the editor audio model', () => {
  it('reads voice-over clips as voice tracks tied to their beats, next to the music', () => {
    const c = read(load(voicedHtml()))
    expect(c.audio.map((a) => [a.id, a.role, a.beat])).toEqual([
      ['music', 'music', null],
      ['voice-intro', 'voice', 'intro'],
      ['voice-outro', 'voice', 'outro'],
    ])
  })
})

describe('scripts/voice.ts revoice (lines changed in the editor)', () => {
  const vfx = (f: string) => readFileSync(new URL(`./fixtures/contract1-voice/${f}`, import.meta.url), 'utf8')
  let dir: string
  let frozen: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'va-revoice-'))
    frozen = mkdtempSync(join(tmpdir(), 'va-frozen-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(frozen, { recursive: true, force: true })
  })

  const silence = (seconds: number) => wav(new Uint8Array(Math.round(seconds * SAMPLE_RATE) * 2))
  /** The voiced fixture with its audio, then the draft's edits as the server freezes them (lines in script.json). */
  function frozenDraft(lines: Record<string, string>) {
    mkdirSync(join(dir, 'assets/voice'), { recursive: true })
    const voice = vfx('assets/voice/voice.json')
    writeFileSync(join(dir, 'assets/voice/voice.json'), voice)
    writeFileSync(join(dir, 'assets/voice/intro.wav'), silence(2.2))
    writeFileSync(join(dir, 'assets/voice/outro.wav'), silence(1.5))
    const spoken = Object.fromEntries(
      (JSON.parse(voice) as { beats: { beat: string; text: string }[] }).beats.map((b) => [b.beat, b.text]),
    )
    const out = applyEdits(
      vfx('index.html'),
      JSON.parse(vfx('summary.json')) as Summary,
      Object.entries(lines).map(([beat, text]) => ({ op: 'voice' as const, beat, text })),
      { narration: spoken },
    )
    const script = JSON.parse(vfx('assets/voice/script.json')) as { lines: { beat: string; text: string }[] }
    for (const l of script.lines) l.text = lines[l.beat] ?? l.text
    writeFileSync(join(dir, 'assets/voice/script.json'), JSON.stringify(script))
    writeFileSync(join(dir, 'index.html'), out.html)
    writeFileSync(join(dir, 'summary.json'), JSON.stringify(out.summary, null, 2))
    // What prepare-run keeps for render-job's check.
    for (const f of FROZEN_FILES) {
      mkdirSync(join(frozen, f, '..'), { recursive: true })
      writeFileSync(join(frozen, f), readFileSync(join(dir, f)))
    }
    const beats = Object.keys(lines)
    return { beats, keptHash: keptHash(bundleManifest(dir).files, beats) }
  }

  it('re-speaks only the marked beat; a longer line grows its beat and moves the rest, and the check passes', async () => {
    const longer =
      'Org webhooks send every event you care about. They reach your endpoint in one place. Signed and retried for you.'
    const plan = frozenDraft({ intro: longer })
    const fake = fakeProvider('kokoro')
    const r = await revoiceVideo(dir, { provider: fake.provider })
    expect(r.beats).toEqual(['intro'])
    // Only the intro's three sentences were spoken; the outro kept its audio.
    expect(fake.calls).toEqual(splitPhrases(longer))
    const voice = readVoice(dir)
    expect(voice).toMatchObject({ provider: 'kokoro', voice: 'af_heart', speed: 1 })
    expect(voice?.beats.map((b) => [b.beat, b.text, b.duration])).toEqual([
      ['intro', longer, 2.6], // 8, 7 and 5 words at 0.1 s + 2 × 0.3 s pauses
      ['outro', 'Read the docs.', 1.5],
    ])
    // 0.3 s lead + 2.6 s + 0.4 s quiet after no longer fits in 3 s.
    expect(r.lengthened).toEqual([{ beat: 'intro', from: 3, to: 3.3 }])
    const html = readFileSync(join(dir, 'index.html'), 'utf8')
    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as Summary
    const c = read(load(html))
    expect(c.beats.map((b) => [b.id, b.start, b.duration])).toEqual([
      ['intro', 0, 3.3],
      ['demo', 3.3, 3],
      ['outro', 6.3, 3],
    ])
    expect(c.beats[0]?.voice?.duration).toBe(2.6)
    expect(html).not.toContain('data-va-revoice')
    expect(validate(html, summary)).toEqual([])
    // The intro's captions are its new phrases at their spoken times; the others moved with their beats.
    expect(summary.captions?.map((x) => [x.beat, x.start, x.voice ?? false])).toEqual([
      ['intro', 0.3, true],
      ['intro', 1.4, true],
      ['intro', 2.4, true],
      ['demo', 3.8, false],
      ['outro', 6.5, true],
    ])
    expect(checkRevoiced(dir, frozen, plan)).toEqual([])
  })

  it('a line that still fits keeps every beat where it was', async () => {
    const plan = frozenDraft({ outro: 'Read the docs today.' })
    const r = await revoiceVideo(dir, { provider: fakeProvider('kokoro').provider })
    expect(r.lengthened).toEqual([])
    expect(read(load(readFileSync(join(dir, 'index.html'), 'utf8'))).duration).toBe(9)
    expect(checkRevoiced(dir, frozen, plan)).toEqual([])
  })

  it('refuses another provider than the one that voiced the video, and does nothing without marks', async () => {
    frozenDraft({ outro: 'Read the docs today.' })
    await expect(revoiceVideo(dir, { provider: fakeProvider('elevenlabs').provider })).rejects.toThrow(
      /voiced with kokoro/,
    )
    const fresh = mkdtempSync(join(tmpdir(), 'va-plain-'))
    writeFileSync(join(fresh, 'index.html'), vfx('index.html'))
    expect(await revoiceVideo(fresh, { provider: fakeProvider('kokoro').provider })).toEqual({
      beats: [],
      lengthened: [],
    })
    rmSync(fresh, { recursive: true, force: true })
  })

  it("render-job's check catches any change re-voicing doesn't explain", async () => {
    const plan = frozenDraft({ outro: 'Read the docs today.' })
    await revoiceVideo(dir, { provider: fakeProvider('kokoro').provider })
    const html = readFileSync(join(dir, 'index.html'), 'utf8')
    writeFileSync(join(dir, 'index.html'), html.replace('Org webhooks</h1>', 'Org hooks</h1>'))
    expect(checkRevoiced(dir, frozen, plan)).toContainEqual(expect.stringMatching(/index.html differs/))
    writeFileSync(join(dir, 'index.html'), html)
    expect(checkRevoiced(dir, frozen, plan)).toEqual([])
    // An unmarked beat's audio, or any other file, must stay as frozen.
    writeFileSync(join(dir, 'assets/voice/intro.wav'), silence(1))
    expect(checkRevoiced(dir, frozen, plan)).toContainEqual(expect.stringMatching(/Files other than/))
    writeFileSync(join(dir, 'assets/voice/intro.wav'), silence(2.2))
    // voice.json may change only for the marked beat.
    const voice = readVoice(dir)!
    writeFileSync(
      join(dir, 'assets/voice/voice.json'),
      JSON.stringify({
        ...voice,
        beats: voice.beats.map((b) => (b.beat === 'intro' ? { ...b, hash: 'x' } : b)),
      }),
    )
    expect(checkRevoiced(dir, frozen, plan)).toContainEqual(expect.stringMatching(/"intro" wasn't marked/))
  })
})
