// A demo's run manifest and prepare-run (screen-recording plan §5.5; va-rsk5.3.11): the optional recording block and
// its shape check (old manifests still verify), prepare-run hydrating the trace and input.json outside video/ (hash
// checked), the 5-minute probe for the recording only, and the reconciler carrying the block on author runs, revisions
// and editor renders.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { hydrateRecording, prepare, probeClip } from '../scripts/prepare-run.js'
import { inheritRecording, manifestRecording } from '../src/domain/demo-recording.js'
import type { VersionRecording } from '../src/domain/types.js'
import {
  runManifestKey,
  serializeRunManifest,
  verifyRunManifest,
  type RunManifest,
  type RunRecording,
} from '../src/lib/run-manifest.js'
import { harness, readyVideo, type Harness } from './helpers.js'

const root = mkdtempSync(join(tmpdir(), 'va-recmanifest-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')
const ID = 'med_rec0000001'
const media = [
  { key: `${ID}/original.mp4`, sha256: 'a'.repeat(64), filename: `${ID}.mp4`, kind: 'video' as const },
  {
    key: 'med_logo000001/original.png',
    sha256: 'b'.repeat(64),
    filename: 'med_logo000001.png',
    kind: 'image' as const,
  },
]
const box = {
  start: 0,
  end: 10,
  reason: 'email',
  boxes: [[0, 0.1, 0.1, 0.2, 0.05]] as [number, number, number, number, number][],
}
const bareRecording: RunRecording = {
  mediaId: ID,
  key: `${ID}/original.mp4`,
  sha256: 'a'.repeat(64),
  filename: `${ID}.mp4`,
  boxes: [box],
}
const recording: RunRecording = {
  mediaId: ID,
  key: `${ID}/original.mp4`,
  sha256: 'a'.repeat(64),
  filename: `${ID}.mp4`,
  trace: { key: `${ID}/trace.json`, sha256: 'c'.repeat(64) },
  boxes: [box],
  trim: [1, 9],
}
const base: RunManifest = {
  v: 1,
  jobId: 'vid_1',
  attemptId: 'att_1',
  versionN: 1,
  kind: 'author',
  source: null,
  bundle: null,
  media,
  feedback: null,
}
const verify = (m: unknown, raw = false) => {
  const text = raw ? JSON.stringify(m) : serializeRunManifest(m as RunManifest)
  return verifyRunManifest(text, { attemptId: 'att_1', sha256: sha(text) })
}

describe('run manifest: recording', () => {
  it('verifies with and without a recording block', () => {
    expect(verify(base).recording).toBeUndefined()
    expect(verify({ ...base, recording }).recording).toEqual(recording)
    expect(verify({ ...base, recording: bareRecording }).recording).toEqual(bareRecording)
  })

  it('refuses each bad shape', () => {
    const bad: [string, unknown][] = [
      ['key outside the media list', { ...recording, key: `${ID}/clean.mp4` }],
      ['sha mismatch', { ...recording, sha256: 'd'.repeat(64) }],
      [
        'an image, not a video',
        {
          ...recording,
          key: media[1]?.key,
          sha256: media[1]?.sha256,
          filename: media[1]?.filename,
          mediaId: 'med_logo000001',
        },
      ],
      [
        'wrong trace key',
        { ...recording, trace: { key: 'med_other00001/trace.json', sha256: 'c'.repeat(64) } },
      ],
      ['bad media id', { ...recording, mediaId: 'nope' }],
      ['201 boxes', { ...recording, boxes: Array.from({ length: 201 }, () => box) }],
      [
        'a two-key box',
        {
          ...recording,
          boxes: [
            {
              ...box,
              boxes: [
                [0, 0.1, 0.1, 0.2, 0.05],
                [1, 0.1, 0.1, 0.2, 0.05],
              ],
            },
          ],
        },
      ],
      ['a box past the frame', { ...recording, boxes: [{ ...box, boxes: [[0, 0.9, 0.1, 0.2, 0.05]] }] }],
      ['trim reversed', { ...recording, trim: [9, 1] }],
      ['compose not a boolean', { ...recording, compose: 'yes' }],
    ]
    for (const [name, r] of bad)
      expect(() => verify({ ...base, recording: r }, true), name).toThrow(
        'The run manifest has a bad recording entry.',
      )
  })
})

describe('prepare-run: recording', () => {
  const fakeFetch = (files: Record<string, Uint8Array | string>) => (key: string, to: string) => {
    const b = files[key]
    if (b === undefined) return Promise.reject(new Error(`no ${key}`))
    writeFileSync(to, b)
    return Promise.resolve()
  }

  it('hydrates the trace (hash checked) and input.json outside video/; without a trace only input.json', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const trace = '{"v":1}'
    const dir = join(root, 'h1')
    await hydrateRecording(
      dir,
      { ...recording, trace: { key: `${ID}/trace.json`, sha256: sha(trace) } },
      fakeFetch({ [`${ID}/trace.json`]: trace }),
    )
    expect(readFileSync(join(dir, '.va-run', 'recording', ID, 'trace.json'), 'utf8')).toBe(trace)
    expect(JSON.parse(readFileSync(join(dir, '.va-run', 'recording', ID, 'input.json'), 'utf8'))).toEqual({
      boxes: [box],
      trim: [1, 9],
    })
    const logLine = spy.mock.calls
      .map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
      .find((l) => l.step === 'recording')
    expect(logLine).toMatchObject({ mediaId: ID, trace: true, boxes: 1, trim: [1, 9] })

    const bare = join(root, 'h2')
    await hydrateRecording(bare, bareRecording, fakeFetch({}))
    expect(existsSync(join(bare, '.va-run', 'recording', ID, 'trace.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(bare, '.va-run', 'recording', ID, 'input.json'), 'utf8'))).toEqual({
      boxes: [box],
    })
    spy.mockRestore()
  })

  it('privacy mode and hide strings reach input.json (for analyze), and only when set', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const dir = join(root, 'h-privacy')
    await hydrateRecording(
      dir,
      { ...bareRecording, privacy: true, hideStrings: ['Acme Labs'] },
      fakeFetch({}),
    )
    expect(JSON.parse(readFileSync(join(dir, '.va-run', 'recording', ID, 'input.json'), 'utf8'))).toEqual({
      boxes: [box],
      privacy: true,
      hideStrings: ['Acme Labs'],
    })
  })

  it('stops the run on a tampered trace', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const dir = join(root, 'h3')
    await expect(
      hydrateRecording(dir, recording, fakeFetch({ [`${ID}/trace.json`]: 'tampered' })),
    ).rejects.toThrow("The pointer trace doesn't match its hash. Stop and report this.")
    expect(existsSync(join(dir, '.va-run', 'recording', ID, 'trace.json'))).toBe(false)
  })

  const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
  it.runIf(hasFfmpeg)(
    'a 4-minute recording passes the probe as the recording; the same file as an ordinary clip fails',
    async () => {
      const clip = join(root, 'four-min.mp4')
      const r = spawnSync('ffmpeg', [
        ...['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=160x90:r=5:d=240'],
        ...['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip],
      ])
      expect(r.status).toBe(0)
      expect(() => probeClip(clip, 'rec.mp4', { role: 'screen-recording' })).not.toThrow()
      expect(() => probeClip(clip, 'clip.mp4')).toThrow('Clip clip.mp4 is longer than 2 minutes.')
      // Through prepare: the manifest's recording is probed as one.
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const bytes = readFileSync(clip)
      const target = join(root, 'p1')
      mkdirSync(join(target, 'video'), { recursive: true })
      const m: RunManifest = {
        ...base,
        media: [{ key: `${ID}/original.mp4`, sha256: sha(bytes), filename: `${ID}.mp4`, kind: 'video' }],
        recording: {
          mediaId: ID,
          key: `${ID}/original.mp4`,
          sha256: sha(bytes),
          filename: `${ID}.mp4`,
          boxes: [],
        },
      }
      await prepare(m, {
        tmp: target,
        root: target,
        fetch: fakeFetch({ [`${ID}/original.mp4`]: bytes }),
        engine: {},
      })
      expect(existsSync(join(target, '.va-run', 'recording', ID, 'input.json'))).toBe(true)
      const plain: RunManifest = { ...m, recording: undefined }
      await expect(
        prepare(plain, {
          tmp: join(root, 'p2'),
          root: join(root, 'p2'),
          fetch: fakeFetch({ [`${ID}/original.mp4`]: bytes }),
          engine: {},
        }),
      ).rejects.toThrow('longer than 2 minutes')
    },
    60_000,
  )
})

describe('reconciler: recording', () => {
  const rec: VersionRecording = {
    mediaId: ID,
    trace: { key: `${ID}/trace.json`, sha256: 'c'.repeat(64) },
    trim: [1, 9],
    boxes: [box],
    compose: false,
    summary: { sourceSec: 10, steps: 2, cutSec: 1, spedUpSec: 0, redactionsAdded: 0 },
    hidden: [],
  }

  const manifestOf = async (h: Harness, i: number) => {
    const req = h.deps.runner.starts[i]
    const s = /--manifest ([0-9a-f]{64})/.exec(req?.prompt ?? '')?.[1] ?? ''
    const jobId = (await h.deps.store.getAttempt(req?.requestId ?? ''))?.jobId ?? ''
    const raw = new TextDecoder().decode(
      await h.deps.blobs.get('sources', runManifestKey(jobId, req?.requestId ?? '')),
    )
    return verifyRunManifest(raw, { attemptId: req?.requestId ?? '', sha256: s })
  }

  it('helpers: a new version keeps the inputs, not the results; the block names the media entry', () => {
    expect(inheritRecording(rec)).toEqual({ ...rec, summary: null, hidden: [] })
    expect(inheritRecording(null)).toBeNull()
    expect(manifestRecording(rec, media)).toEqual(recording)
    expect(manifestRecording(rec, [media[1] as (typeof media)[number]])).toBeNull()
  })

  // The author run's manifest is written as the video is created, so the demo's v1 is seeded after it and the
  // revision (whose manifest is written when it starts) shows the inheritance.
  it('a revision of a demo inherits its inputs and its run carries the recording block', async () => {
    const h = harness()
    const v = { id: await readyVideo(h) }
    await h.deps.store.insertVersionMedia([
      {
        jobId: v.id,
        versionN: 1,
        mediaId: ID,
        position: 0,
        kind: 'video',
        key: `${ID}/original.mp4`,
        sha256: 'a'.repeat(64),
        filename: `${ID}.mp4`,
        caption: null,
      },
    ])
    await h.deps.store.updateVersion(v.id, 1, { recording: rec })
    // The frozen trace in the media store: its click targets become the prompt's clicked elements.
    const trace = {
      v: 1,
      source: { kind: 'cli', tool: 't', startedAt: '2026-11-05T10:00:00.000Z' },
      frame: { width: 1280, height: 720, fps: 30, duration: 10 },
      viewport: { width: 1280, height: 720, dpr: 1 },
      moves: [],
      events: [
        {
          kind: 'click',
          t: 4,
          x: 0.5,
          y: 0.5,
          button: 0,
          target: { role: 'button', name: 'Deploy site', box: [0.4, 0.4, 0.2, 0.1] },
        },
      ],
      redact: [],
    }
    await h.deps.blobs.set('media', `${ID}/trace.json`, JSON.stringify(trace))
    const revised = await h.call('POST', `/api/v1/videos/${v.id}/versions`, {
      as: h.member,
      body: { prompt: 'Make it faster' },
    })
    expect(revised.status).toBeLessThan(300)
    expect((await h.deps.store.getVersion(v.id, 2))?.recording).toEqual({ ...rec, summary: null, hidden: [] })
    await h.drive(4)
    const m = await manifestOf(h, h.deps.runner.starts.length - 1)
    expect(m.kind).toBe('revision')
    expect(m.recording).toEqual(recording)
    const prompt = h.deps.runner.starts.at(-1)?.prompt ?? ''
    expect(prompt).toContain(
      'Screen recording: this video is a demo made from assets/media/med_rec0000001.mp4',
    )
    expect(prompt).toContain('0:04 button "Deploy site"')
  })

  it('a revision of a video without a recording has no block (its manifest keeps its bytes)', async () => {
    const h = harness()
    const v = { id: await readyVideo(h) }
    await h.call('POST', `/api/v1/videos/${v.id}/versions`, { as: h.member, body: { prompt: 'Again' } })
    await h.drive(4)
    const m = await manifestOf(h, h.deps.runner.starts.length - 1)
    expect(m.kind).toBe('revision')
    expect(m.recording).toBeUndefined()
  })
})
