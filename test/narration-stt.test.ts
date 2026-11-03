// The STT stage (plan 2026-11-02 §6.6, bead va-2qq.3.12): provider selection, the outer deadline killing a slow
// provider and every process it started, the Parakeet offset correction and transcript parsing (S11's fixture), the
// ElevenLabs Scribe request and response with a mocked fetch, the local cache, and stt.json plus the receipt.
// Cases that decode the bus skip without ffmpeg.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NARRATION_SRC } from '../src/lib/contract.js'
import { SAMPLE_RATE as S, type NarrationOp } from '../src/lib/timeline.js'
import { wav } from '../src/lib/voice.js'
import { FIXTURE_HYPERFRAMES } from '../spikes/s11/metrics.js'
import { narrationPaths, type NarrationInputs } from '../scripts/lib/narration-inputs.js'
import { alive, runTree } from '../scripts/lib/proc-tree.js'
import { which } from '../scripts/lib/run-tools.js'
import { parseScribe, scribe, SCRIBE_MODEL, SCRIBE_URL } from '../scripts/lib/stt/elevenlabs.js'
import { pickSttProvider, readSttRecord, runStt, type SttProvider } from '../scripts/lib/stt/index.js'
import {
  correctOffset,
  parakeet,
  parseHyperframesTranscript,
  PARAKEET_MODEL,
  PARAKEET_OFFSET_S,
} from '../scripts/lib/stt/parakeet.js'
import type { TreeOptions, TreeResult } from '../scripts/lib/proc-tree.js'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'va-stt-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A node script that starts a child in its own session (like npx's workers), records both pids and hangs. */
function slowTree(dir: string) {
  const child = join(dir, 'child.mjs')
  const parent = join(dir, 'parent.mjs')
  const pids = join(dir, 'pids.txt')
  writeFileSync(child, `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\n`)
  writeFileSync(
    parent,
    `import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
const c = spawn(process.execPath, [${JSON.stringify(child)}], { detached: true, stdio: 'ignore' })
appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n' + c.pid + '\\n')
process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)
`,
  )
  const read = () => readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number)
  return { parent, read }
}

describe('runTree (the outer deadline)', () => {
  it('kills a command that outlives its deadline and the child it started in another session', async () => {
    const t = slowTree(tmp())
    const r = await runTree(process.execPath, [t.parent], { deadlineMs: 1500, graceMs: 300, sampleMs: 100 })
    expect(r.timedOut).toBe(true)
    expect(r.ok).toBe(false)
    const pids = t.read()
    expect(pids).toHaveLength(2)
    await sleep(100)
    expect(pids.filter(alive)).toEqual([])
  })

  it('a command that finishes in time is ok', async () => {
    const r = await runTree(process.execPath, ['-e', 'console.log("hi")'], { deadlineMs: 10_000 })
    expect(r).toMatchObject({ ok: true, timedOut: false, code: 0 })
    expect(r.stdout.trim()).toBe('hi')
  })

  it('a command that is not there is a failure, not a throw', async () => {
    const r = await runTree('va-no-such-command', [], { deadlineMs: 1000 })
    expect(r.ok).toBe(false)
    expect(r.code).toBe(127)
  })
})

describe('Parakeet', () => {
  it('parses the hyperframes transcript (S11 fixture) and drops entries without text or times', () => {
    const words = parseHyperframesTranscript([
      ...FIXTURE_HYPERFRAMES,
      { id: 'x', text: ' ', start: 4, end: 5 },
      { id: 'y', text: 'z' },
    ])
    expect(words).toHaveLength(7)
    expect(words[0]).toEqual({ text: 'The', start: 0.52, end: 0.68 })
    expect(words[3]?.text).toBe('north.')
    expect(() => parseHyperframesTranscript({})).toThrow(/not an array/)
  })

  it('takes the fixed 240 ms off starts and ends, clamped at 0', () => {
    expect(PARAKEET_OFFSET_S).toBe(0.24)
    expect(
      correctOffset([
        { text: 'a', start: 0.1, end: 0.2 },
        { text: 'b', start: 0.2, end: 0.5 },
        { text: 'c', start: 1.0, end: 1.3 },
      ]),
    ).toEqual([
      { text: 'a', start: 0, end: 0 },
      { text: 'b', start: 0, end: 0.26 },
      { text: 'c', start: 0.76, end: 1.06 },
    ])
  })

  it('installs, then transcribes with the S11 flags, and corrects the words', async () => {
    const calls: { args: string[]; opts: TreeOptions }[] = []
    const ok = (): TreeResult => ({
      code: 0,
      signal: null,
      ok: true,
      timedOut: false,
      wallMs: 1,
      stdout: '{}',
      stderrTail: '',
      reaped: [],
    })
    const run = (_cmd: string, args: string[], opts: TreeOptions) => {
      calls.push({ args, opts })
      const dir = args[args.indexOf('--dir') + 1]
      if (args.includes('transcribe') && dir)
        writeFileSync(join(dir, 'transcript.json'), JSON.stringify(FIXTURE_HYPERFRAMES))
      return Promise.resolve(ok())
    }
    const work = tmp()
    const out = await parakeet(run).transcribe('/x/bus16k.wav', {
      deadlineAt: Date.now() + 60_000,
      workDir: work,
      cwd: work,
      language: 'en',
    })
    expect(calls.map((c) => c.args.slice(1, 4))).toEqual([
      ['hyperframes', 'models', 'install'],
      ['hyperframes', 'transcribe', '/x/bus16k.wav'],
    ])
    expect(calls[1]?.args).toEqual(
      expect.arrayContaining(['--engine', 'parakeet', '--language', 'en', '--json']),
    )
    expect(calls.every((c) => c.opts.deadlineMs > 0 && c.opts.deadlineMs <= 60_000)).toBe(true)
    expect(out).toMatchObject({ provider: 'local', model: PARAKEET_MODEL })
    expect(out.words[0]).toEqual({ text: 'The', start: 0.28, end: 0.44 })
  })

  it('a timed-out install is a timeout', async () => {
    const run = () =>
      Promise.resolve<TreeResult>({
        code: null,
        signal: 'SIGKILL',
        ok: false,
        timedOut: true,
        wallMs: 1,
        stdout: '',
        stderrTail: '',
        reaped: [],
      })
    await expect(
      parakeet(run).transcribe('/x.wav', {
        deadlineAt: Date.now() + 1000,
        workDir: tmp(),
        cwd: '.',
        language: 'en',
      }),
    ).rejects.toThrow(/deadline/)
  })
})

describe('ElevenLabs Scribe', () => {
  it('posts the 16 kHz WAV with scribe_v1 and word timestamps, and keeps only words', async () => {
    const dir = tmp()
    const file = join(dir, 'bus16k.wav')
    writeFileSync(file, wav(new Uint8Array(320)))
    let seen: { url: string; init: RequestInit } | null = null
    const fetchImpl = ((url: string, init: RequestInit) => {
      seen = { url, init }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            language_code: 'en',
            text: 'Hello there.',
            words: [
              { text: 'Hello', start: 0.1, end: 0.4, type: 'word' },
              { text: ' ', start: 0.4, end: 0.5, type: 'spacing' },
              { text: '(laughs)', start: 0.5, end: 0.6, type: 'audio_event' },
              { text: 'there.', start: 0.5, end: 0.9, type: 'word' },
            ],
          }),
          { status: 200 },
        ),
      )
    }) as unknown as typeof fetch
    const out = await scribe('xi-key', fetchImpl).transcribe(file, {
      deadlineAt: Date.now() + 10_000,
      workDir: dir,
      cwd: dir,
      language: 'en',
    })
    expect(out).toMatchObject({ provider: 'elevenlabs', model: SCRIBE_MODEL })
    expect(out.words).toEqual([
      { text: 'Hello', start: 0.1, end: 0.4 },
      { text: 'there.', start: 0.5, end: 0.9 },
    ])
    const s = seen as unknown as { url: string; init: RequestInit }
    expect(s.url).toBe(SCRIBE_URL)
    expect(s.url).toBe('https://api.elevenlabs.io/v1/speech-to-text')
    expect((s.init.headers as Record<string, string>)['xi-api-key']).toBe('xi-key')
    const form = s.init.body as FormData
    expect(form.get('model_id')).toBe('scribe_v1')
    expect(form.get('timestamps_granularity')).toBe('word')
    expect(form.get('language_code')).toBe('en')
    expect(form.get('file')).toBeInstanceOf(Blob)
  })

  it('an error response throws with the detail', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ detail: { message: 'quota' } }), { status: 401 }),
      )) as unknown as typeof fetch
    const dir = tmp()
    writeFileSync(join(dir, 'a.wav'), wav(new Uint8Array(4)))
    await expect(
      scribe('k', fetchImpl).transcribe(join(dir, 'a.wav'), {
        deadlineAt: Date.now() + 1000,
        workDir: dir,
        cwd: dir,
        language: 'en',
      }),
    ).rejects.toThrow('ElevenLabs returned 401: quota.')
    expect(() => parseScribe({})).toThrow(/no words/)
  })
})

describe('pickSttProvider', () => {
  it('local by default, ElevenLabs only when chosen and keyed, nothing when off', () => {
    expect(pickSttProvider('local', { ELEVENLABS_API_KEY: 'k' }).provider?.name).toBe('local')
    expect(pickSttProvider('elevenlabs', { ELEVENLABS_API_KEY: 'k' }).provider?.name).toBe('elevenlabs')
    const fallback = pickSttProvider('elevenlabs', {})
    expect(fallback.provider?.name).toBe('local')
    expect(fallback.warnings[0]).toMatch(/ELEVENLABS_API_KEY/)
    expect(pickSttProvider('off', { ELEVENLABS_API_KEY: 'k' }).provider).toBeNull()
  })
})

const op = (muted = false): NarrationOp => ({
  op: 'narration',
  schema: 1,
  sampleRate: S,
  clips: [],
  tracks: {
    narration: { volumeDb: 0, muted, solo: false },
    aiVoice: { mode: 'replace', volumeDb: -6 },
    music: { duck: true, duckDb: -12 },
    original: { muteAll: false },
  },
  cleanup: 'off',
})

/** A prepared workspace after narration.ts: inputs, a 1 s bus and a receipt. */
function workspace(o: { setting?: NarrationInputs['transcriptionProvider']; muted?: boolean } = {}) {
  const root = tmp()
  const p = narrationPaths(root)
  mkdirSync(p.dir, { recursive: true })
  mkdirSync(join(root, 'video', 'assets', 'narration'), { recursive: true })
  writeFileSync(join(root, 'video', NARRATION_SRC), wav(new Uint8Array(S * 2)))
  const inputs: NarrationInputs = {
    v: 1,
    jobId: 'vid_1',
    attemptId: 'att_1',
    op: op(o.muted),
    recipe: { pipeline: 1, cleanup: 'off' },
    targetSamples: S,
    captions: 'sidecar',
    ...(o.setting ? { transcriptionProvider: o.setting } : {}),
    takes: [],
  }
  writeFileSync(p.manifest, JSON.stringify(inputs))
  writeFileSync(p.receipt, JSON.stringify({ v: 1, bus: { sha256: 'x' } }))
  return { root, p }
}

const receiptStt = (p: ReturnType<typeof narrationPaths>) =>
  (JSON.parse(readFileSync(p.receipt, 'utf8')) as { stt?: Record<string, unknown> }).stt

describe('runStt', () => {
  it("'off' skips, and says so in stt.json and the receipt", async () => {
    const { root, p } = workspace({ setting: 'off' })
    const r = await runStt({ root, cacheDir: tmp() })
    expect(r).toMatchObject({ status: 'off', setting: 'off', provider: null, words: [] })
    expect(readSttRecord(root)?.status).toBe('off')
    expect(receiptStt(p)).toMatchObject({ status: 'off', words: 0 })
  })

  it('a muted narration track is not transcribed', async () => {
    const { root } = workspace({ muted: true })
    expect((await runStt({ root, cacheDir: tmp() })).status).toBe('off')
  })

  it('without hydrated narration it fails without throwing', async () => {
    const r = await runStt({ root: tmp(), cacheDir: tmp() })
    expect(r.status).toBe('failed')
    expect(r.error).toMatch(/no recorded narration/)
  })

  describe.skipIf(!which('ffmpeg'))('with ffmpeg', () => {
    const words = [{ text: 'Hello.', start: 0.1, end: 0.5 }]
    const fake = (fn: SttProvider['transcribe']): SttProvider => ({
      name: 'local',
      model: 'fake-1',
      transcribe: fn,
    })

    it('transcribes a 16 kHz decode of the bus, writes stt.json and the receipt, and caches the words', async () => {
      const { root, p } = workspace()
      const cacheDir = tmp()
      let decoded = ''
      const r = await runStt({
        root,
        cacheDir,
        provider: fake((path) => {
          decoded = readFileSync(path).subarray(24, 28).readUInt32LE(0).toString()
          return Promise.resolve({ words, provider: 'local', model: 'fake-1', durationMs: 5 })
        }),
      })
      expect(decoded).toBe('16000')
      expect(r).toMatchObject({
        status: 'ok',
        provider: 'local',
        model: 'fake-1',
        words,
        cached: false,
        offsetMs: -240,
      })
      expect(r.busSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(readSttRecord(root)?.words).toEqual(words)
      expect(receiptStt(p)).toMatchObject({ status: 'ok', words: 1, provider: 'local' })
      // A retry in the same run hits the cache: the provider isn't called again.
      const again = await runStt({
        root,
        cacheDir,
        provider: fake(() => Promise.reject(new Error('should not run'))),
      })
      expect(again).toMatchObject({ status: 'ok', cached: true, words })
    })

    it('a provider that fails is status failed, and the run goes on', async () => {
      const { root } = workspace()
      const r = await runStt({
        root,
        cacheDir: tmp(),
        provider: fake(() => Promise.reject(new Error('model broke'))),
      })
      expect(r).toMatchObject({ status: 'failed', error: 'model broke', words: [] })
    })

    it('the deadline kills a slow provider and its children: status timeout', async () => {
      const { root } = workspace()
      const t = slowTree(tmp())
      const r = await runStt({
        root,
        cacheDir: tmp(),
        deadlineMs: 2500,
        provider: fake(async (_wav, o) => {
          const res = await runTree(process.execPath, [t.parent], {
            deadlineMs: Math.max(1, o.deadlineAt - Date.now()),
            graceMs: 300,
            sampleMs: 100,
          })
          if (res.timedOut) {
            const { SttTimeout } = await import('../scripts/lib/stt/types.js')
            throw new SttTimeout('slow provider stopped')
          }
          return { words, provider: 'local', model: 'fake-1', durationMs: 0 }
        }),
      })
      expect(r.status).toBe('timeout')
      await sleep(100)
      const pids = t.read()
      expect(pids).toHaveLength(2)
      expect(pids.filter(alive)).toEqual([])
    })
  })
})
