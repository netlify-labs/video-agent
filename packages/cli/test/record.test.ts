// video-agent record (screen-recording plan §4.6; va-rsk5.5.1, va-rsk5.5.2) on a local test page, headless: the file
// passes the same checks as an upload; the trace is schema-valid with the button's role and name, a scrubbed email,
// typing counted but never recorded, the password field keyed as it scrolls, and a click that lines up with the frame
// it shows in; r and s drive a recording; sign-in files stay out of the recording folder and save as 0600. Needs
// ffmpeg and Playwright's Chromium (CI installs both).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { classify } from '../../../src/lib/media/classify.js'
import { parseTrace } from '../../../src/lib/recording-trace.js'
import { checkStorageState, parseViewport } from '../src/commands/record.js'
import { runRecord, type RecordOptions } from '../src/record/capture.js'

const FIX = join(import.meta.dirname, 'fixtures', 'record')
const tmp = mkdtempSync(join(tmpdir(), 'va-record-test-'))
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
let server: Server
let url = ''

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(readFileSync(join(FIX, 'page.html')))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/start`
})
afterAll(() => {
  server.close()
  rmSync(tmp, { recursive: true, force: true })
})

function opts(
  out: string,
  extra: Partial<RecordOptions> = {},
): RecordOptions & { logs: Record<string, unknown>[] } {
  const logs: Record<string, unknown>[] = []
  return {
    url,
    viewport: { width: 1280, height: 720 },
    dpr: 1,
    fps: 30,
    out,
    headless: true,
    hide: [],
    names: true,
    tool: 'netlify-video-agent@test',
    log: (event, fields) => logs.push({ event, ...fields }),
    say: () => {},
    logs,
    ...extra,
  }
}

describe.runIf(hasFfmpeg)('video-agent record', () => {
  it('records a scripted session: a normalized file and a scrubbed, aligned trace', async () => {
    const out = join(tmp, 'a')
    const state = join(tmp, 'state.json')
    const o = opts(out, { script: join(FIX, 'tour.mjs'), saveStorageState: state })
    const r = await runRecord(o)
    console.log(JSON.stringify({ test: 'record', result: r, logs: o.logs.map((l) => l.event) }))
    // The file passes an upload's checks.
    expect(() => classify(new Uint8Array(readFileSync(r.file)), { role: 'screen-recording' })).not.toThrow()
    expect([r.width, r.height]).toEqual([1280, 720])
    // The trace: schema-valid, clicks with role and name.
    const text = readFileSync(r.trace, 'utf8')
    const trace = parseTrace(text)
    expect(trace.source).toMatchObject({ kind: 'script', tool: 'netlify-video-agent@test' })
    const clicks = trace.events.filter((e) => e.kind === 'click')
    expect(clicks[0]).toMatchObject({ target: { role: 'button', name: 'Add new site' } })
    // An email in a name is scrubbed.
    expect(clicks[1]).toMatchObject({ target: { role: 'link' } })
    expect(text).not.toContain('jane.doe@acme.com')
    expect(clicks[1]?.kind === 'click' && clicks[1].target?.name).toBe('Contact … today')
    // Typing: counted, never recorded.
    expect(trace.events.find((e) => e.kind === 'type')).toMatchObject({ keys: 8 })
    expect(text).not.toContain('hunter22')
    expect(trace.events.some((e) => e.kind === 'scroll')).toBe(true)
    // The password field is hidden from the start, and its keys follow it as the page scrolls.
    const pw = trace.redact[0]
    expect(pw?.reason).toBe('password field')
    expect(pw?.boxes.length).toBeGreaterThanOrEqual(2)
    expect(new Set(pw?.boxes.map((b) => b[2])).size).toBeGreaterThan(1)
    // The first click lines up with the first frame that shows the red corner, within a frame or two.
    const t = clicks[0]?.t ?? 0
    const at = (s: number) =>
      spawnSync('ffmpeg', [
        '-loglevel',
        'error',
        '-ss',
        String(s),
        '-i',
        r.file,
        '-frames:v',
        '1',
        '-vf',
        'crop=40:40:1240:0,scale=1:1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-',
      ]).stdout as Buffer
    const red = (s: number) => {
      const px = at(s)
      return (px[0] ?? 0) > 200 && (px[1] ?? 255) < 80
    }
    let first = -1
    for (let s = Math.max(0, t - 0.3); s < t + 0.5; s += 1 / 30)
      if (red(s)) {
        first = s
        break
      }
    console.log(
      JSON.stringify({ test: 'record-align', click: t, firstRed: first, deltaFrames: (first - t) * 30 }),
    )
    expect(first).toBeGreaterThanOrEqual(0)
    expect(Math.abs(first - t)).toBeLessThanOrEqual(2 / 30)
    // Logs per stage; the saved sign-in file is the owner's only.
    for (const e of ['record.opened', 'record.started', 'record.stopped', 'record.assembled', 'record.trace'])
      expect(
        o.logs.some((l) => l.event === e),
        e,
      ).toBe(true)
    expect(statSync(state).mode & 0o777).toBe(0o600)
  }, 120_000)

  it('starts on r and stops on s', async () => {
    const out = join(tmp, 'b')
    async function* keys() {
      yield 'x'
      yield 'r'
      await new Promise((res) => setTimeout(res, 1500))
      yield 's'
    }
    const r = await runRecord(opts(out, { keys: keys() }))
    expect(existsSync(r.file)).toBe(true)
    expect(r.seconds).toBeGreaterThan(1)
    expect(r.seconds).toBeLessThan(5)
  }, 120_000)

  it('q before r stops without recording', async () => {
    async function* keys() {
      yield 'q'
    }
    await expect(runRecord(opts(join(tmp, 'c'), { keys: keys() }))).rejects.toThrow(
      'Stopped before recording started.',
    )
  }, 60_000)
})

describe('video-agent record: options', () => {
  it('keeps sign-in files out of the recording folder', () => {
    expect(() => checkStorageState('./demo', ['./demo/state.json'])).toThrow(
      /Keep sign-in files out of the recording folder/,
    )
    expect(() => checkStorageState('./demo', ['./demo'])).toThrow()
    expect(() => checkStorageState('./demo', ['./demo-state.json', undefined])).not.toThrow()
  })

  it('reads the viewport', () => {
    expect(parseViewport('1440x900')).toEqual({ width: 1440, height: 900 })
    expect(parseViewport(undefined)).toEqual({ width: 1280, height: 800 })
    expect(() => parseViewport('big')).toThrow('--viewport takes a size like 1280x800')
  })
})
