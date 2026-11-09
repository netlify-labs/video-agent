// Demos from the CLI (screen-recording plan §6.3; va-rsk5.5.3) against the real routes: a video-agent record folder
// uploads with its trace (media upload --role, create --recording), and create's demo flags reach the request with the
// API's field names (--trim, --privacy, --hide-text, --quick).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXIT } from '../../packages/cli/src/exit.js'
import { cli } from './cli-io.js'
import { harness, PROMPT } from './helpers.js'

/** A recording folder as video-agent record writes it: gop30.mp4 (320x180, 3 s) and a trace fitted to it. */
function recordingFolder() {
  const dir = mkdtempSync(join(tmpdir(), 'va-demo-cli-'))
  writeFileSync(
    join(dir, 'recording.mp4'),
    readFileSync(new URL('./fixtures/mp4/gop30.mp4', import.meta.url)),
  )
  const trace = JSON.parse(
    readFileSync(new URL('./fixtures/recording/trace-good.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>
  writeFileSync(
    join(dir, 'trace.json'),
    JSON.stringify({
      ...trace,
      frame: { width: 320, height: 180, fps: 30, duration: 3 },
      moves: [[0, 0.5, 0.5]],
      events: [{ kind: 'click', t: 1.2, x: 0.6, y: 0.4, button: 0 }],
      redact: [],
    }),
  )
  return dir
}

const posts = (requests: Request[], path: string) =>
  requests.filter((r) => r.method === 'POST' && new URL(r.url).pathname === path)

describe('demos from the CLI', () => {
  it('media upload --role screen-recording takes a record folder, trace and all', async () => {
    const h = harness()
    const { run } = await cli(h)
    const r = await run(['media', 'upload', recordingFolder(), '--role', 'screen-recording', '--json'])
    expect(r.code).toBe(0)
    const [item] = (r.json() as { items: { id: string; hasTrace: boolean }[] }).items
    console.log(JSON.stringify({ test: 'cli-demo', case: 'upload', item }))
    expect(item?.hasTrace).toBe(true)
    expect((await run(['media', 'upload', recordingFolder(), '--trace', 'x.json'])).code).toBe(EXIT.usage)
  })

  it('create --recording uploads the folder and sends trim, privacy mode, hide strings and Quick demo', async () => {
    const h = harness()
    const { run, requests } = await cli(h)
    const r = await run([
      ...['create', PROMPT, '--recording', recordingFolder(), '--trim', '0.5,2.5', '--privacy'],
      ...['--hide-text', 'Acme Labs', '--hide-text', 'Priya Raman', '--quick', '--json'],
    ])
    expect(r.code).toBe(0)
    const sent = (await posts(requests, '/api/v1/videos').at(-1)?.clone().json()) as Record<string, unknown>
    console.log(
      JSON.stringify({ test: 'cli-demo', case: 'create', recording: sent.recording, agent: sent.agent }),
    )
    expect(sent.recording).toMatchObject({
      trim: [0.5, 2.5],
      privacy: true,
      hideStrings: ['Acme Labs', 'Priya Raman'],
    })
    expect((sent.recording as { mediaId: string }).mediaId).toMatch(/^med_/)
    expect(sent.agent).toBe(false)
    // A media id is used as it is: nothing uploaded.
    const before = posts(requests, '/api/v1/media/uploads').length
    const id = (sent.recording as { mediaId: string }).mediaId
    expect((await run(['create', PROMPT, '--recording', id, '--json'])).code).toBe(0)
    expect(posts(requests, '/api/v1/media/uploads').length).toBe(before)
  })

  it('refuses --quick without a recording and a malformed --trim', async () => {
    const h = harness()
    const { run } = await cli(h)
    expect((await run(['create', PROMPT, '--quick'])).code).toBe(EXIT.usage)
    expect((await run(['create', PROMPT, '--recording', recordingFolder(), '--trim', '5'])).code).toBe(
      EXIT.usage,
    )
  })
})
