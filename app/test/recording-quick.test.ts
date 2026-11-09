// The Quick demo (screen-recording plan §14 Q11; va-rsk5.3.17): agent: false makes a demo with no authoring. The
// version's recording says compose, the manifest carries it, and the run gets a fixed script (snapshot) like a
// render-unchanged run's; agent: false needs a recording and takes no voice-over; the fake runner drives it to ready;
// the SDK refuses `agent` against a server without screen_recording.
import { afterEach, describe, expect, it } from 'vitest'
import { isVideoAgentError, VideoAgent } from '../../packages/sdk/src/index.js'
import { screenRecordingApi } from '../server/domain/features.js'
import { runManifestKey, verifyRunManifest } from '../server/lib/run-manifest.js'
import { apiKey, harness, png, PROMPT, upload, type Harness } from './helpers.js'
import { appFetch } from './sdk-fetch.js'

async function recording(h: Harness) {
  const m = await h.json<{ id: string }>(await upload(h, h.member, png(300, 100), 'filename=screen.png'))
  await h.deps.store.updateMedia(m.id, {
    role: 'screen-recording',
    kind: 'video',
    ext: 'mp4',
    durationSec: 60,
  })
  return m.id
}
const log = (fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ test: 'quick-demo', ...fields }))

describe('Quick demo', () => {
  afterEach(() => {
    screenRecordingApi.ready = true
  })

  it('agent: false composes with a fixed script; the manifest says compose; it renders to ready', async () => {
    const h = harness()
    const id = await recording(h)
    const res = await h.call('POST', '/api/v1/videos', {
      as: h.member,
      body: { prompt: PROMPT, title: 'Add a site', agent: false, recording: { mediaId: id } },
    })
    expect(res.status).toBe(202)
    const v = await h.json<{ id: string; versions: { recording: { compose: boolean } }[] }>(res)
    expect(v.versions[0]?.recording.compose).toBe(true)
    await h.drive(4)
    const req = h.deps.runner.starts[0]
    const sha = /--manifest ([0-9a-f]{64})/.exec(req?.prompt ?? '')?.[1] ?? ''
    const m = verifyRunManifest(
      new TextDecoder().decode(await h.deps.blobs.get('sources', runManifestKey(v.id, req?.requestId ?? ''))),
      { attemptId: req?.requestId ?? '', sha256: sha },
    )
    expect(m.recording).toMatchObject({ mediaId: id, compose: true })
    const prompt = (req?.prompt ?? '')
      .replaceAll(req?.requestId ?? '', '<attempt>')
      .replaceAll(sha, '<manifest>')
      .replaceAll(id, '<media>')
    log({ case: 'prompt', length: prompt.length })
    expect(prompt).toMatchSnapshot()
    expect(prompt).not.toMatch(/hyperframes skill|Request \(from/)
    const after = await h.json<{ status: string }>(
      await h.call('GET', `/api/v1/videos/${v.id}`, { as: h.member }),
    )
    log({ case: 'ready', status: after.status })
    expect(after.status).toBe('ready')
  })

  it('needs a recording, and takes no voice-over', async () => {
    const h = harness()
    const id = await recording(h)
    const bare = await h.call('POST', '/api/v1/videos', {
      as: h.member,
      body: { prompt: PROMPT, agent: false },
    })
    expect(bare.status).toBe(400)
    expect(await bare.text()).toMatch(/needs a recording/)
    const voiced = await h.call('POST', '/api/v1/videos', {
      as: h.member,
      body: { prompt: PROMPT, agent: false, recording: { mediaId: id }, voiceover: { enabled: true } },
    })
    expect(voiced.status).toBe(400)
    expect(await voiced.text()).toMatch(/no voice-over/)
  })

  it('the SDK refuses agent against a server without screen_recording', async () => {
    const h = harness()
    screenRecordingApi.ready = false
    const va = new VideoAgent({
      url: 'https://video.example.com',
      apiKey: await apiKey(h, h.member),
      fetch: async (input: string | URL | Request, init?: RequestInit) =>
        appFetch(h, new Request(input, init)),
    })
    const e = await va.videos.create({ prompt: PROMPT, agent: false }).then(
      () => null,
      (err: unknown) => (isVideoAgentError(err) ? err : null),
    )
    log({ case: 'sdk', code: e?.code })
    expect(e?.code).toBe('unsupported_by_server')
  })
})
