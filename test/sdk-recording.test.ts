// The SDK's screen recording methods (screen-recording plan §6.2; va-rsk5.2.11) against the real app: uploadRecording
// with a trace (progress, ready item with hasTrace, getTrace), a refused file surfaced with its reason, trace_frozen as
// a typed error, and every recording call refused with unsupported_by_server while the server doesn't list
// screen_recording. One JSON line per case.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { components } from '../packages/sdk/src/generated/schema.js'
import { isVideoAgentError, VideoAgent, type UploadProgress } from '../packages/sdk/src/index.js'
import { screenRecordingApi } from '../src/domain/features.js'
import type { VersionMediaRow } from '../src/domain/types.js'
import { apiKey, harness, readyVideo, type Harness } from './helpers.js'
import { appFetch } from './sdk-fetch.js'

const log = (fields: Record<string, unknown>) => console.log(JSON.stringify(fields))
const mp4 = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/mp4/${name}`, import.meta.url)))

/** trace-good.json fitted to gop30.mp4 (320x180, 3 s): times scaled into the clip. */
function traceFor(): components['schemas']['PointerTrace'] {
  const t = JSON.parse(
    readFileSync(new URL('./fixtures/recording/trace-good.json', import.meta.url), 'utf8'),
  ) as Record<string, any>
  t.frame = { width: 320, height: 180, fps: 30, duration: 3 }
  t.moves = [
    [0, 0.5, 0.5],
    [1, 0.6, 0.4],
  ]
  t.events = [{ kind: 'click', t: 1.2, x: 0.6, y: 0.4, button: 0 }]
  t.redact = []
  return t as components['schemas']['PointerTrace']
}

const client = async (h: Harness) =>
  new VideoAgent({
    url: 'https://video.example.com',
    apiKey: await apiKey(h, h.member),
    fetch: async (input: string | URL | Request, init?: RequestInit) => appFetch(h, new Request(input, init)),
  })

const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => (isVideoAgentError(e) ? e : Promise.reject(e as Error)),
  )

describe('SDK screen recordings', () => {
  afterEach(() => {
    screenRecordingApi.ready = false
  })

  it('refuses every recording call while the server lacks screen_recording', async () => {
    const h = harness()
    const va = await client(h)
    const file = mp4('gop30.mp4')
    for (const [name, call] of [
      ['uploadRecording', () => va.media.uploadRecording(file)],
      ['upload role', () => va.media.upload(file, { role: 'screen-recording' })],
      ['setTrace', () => va.media.setTrace('med_x', traceFor())],
    ] as const) {
      const e = await failure(call())
      log({ case: name, code: e?.code })
      expect(e?.code, name).toBe('unsupported_by_server')
    }
  })

  it('uploads a recording with its trace, reporting progress', async () => {
    screenRecordingApi.ready = true
    const h = harness()
    const va = await client(h)
    const phases: UploadProgress['phase'][] = []
    const item = await va.media.uploadRecording(mp4('gop30.mp4'), {
      filename: 'take.mp4',
      trace: traceFor(),
      onProgress: (p) => phases.push(p.phase),
    })
    log({
      case: 'upload',
      mediaId: item.id,
      role: item.role,
      hasTrace: item.hasTrace,
      phases: [...new Set(phases)],
    })
    expect(item).toMatchObject({ status: 'ready', role: 'screen-recording', hasTrace: true })
    expect(new Set(phases)).toEqual(new Set(['checking', 'uploading', 'verifying', 'done']))
    expect(await va.media.getTrace(item.id)).toMatchObject({ v: 1, frame: { width: 320, height: 180 } })
  })

  it('surfaces a refused recording with its reason, and a frozen trace as trace_frozen', async () => {
    screenRecordingApi.ready = true
    const h = harness()
    const va = await client(h)
    const bad = await failure(va.media.uploadRecording(mp4('gop300.mp4')))
    log({ case: 'rejected', code: bad?.code, message: bad?.message })
    expect(bad?.code).toBe('media_rejected')
    expect(bad?.message).toMatch(/keyframe every second/)
    const item = await va.media.uploadRecording(mp4('gop30.mp4'), { trace: traceFor() })
    const job = await readyVideo(h)
    const vm: VersionMediaRow = {
      jobId: job,
      versionN: 1,
      mediaId: item.id,
      position: 0,
      kind: 'video',
      key: `${item.id}/original.mp4`,
      sha256: 'a'.repeat(64),
      filename: `${item.id}.mp4`,
      caption: null,
    }
    await h.deps.store.insertVersionMedia([vm])
    const frozen = await failure(va.media.setTrace(item.id, traceFor()))
    log({ case: 'frozen', code: frozen?.code, status: frozen?.status })
    expect(frozen).toMatchObject({ code: 'trace_frozen', status: 409 })
  })
})
