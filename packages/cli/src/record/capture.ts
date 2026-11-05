// `video-agent record`'s capture (screen-recording plan §4.6; va-rsk5.5.1): Chromium at the viewport with spike D2's
// recipe for real 2x pixels (--force-device-scale-factor, viewport null, a CDP metrics override), the CDP screencast
// (JPEG q90 at viewport x dpr, every frame acked, timestamps kept), r to start and s to stop in the terminal (or a
// fixed --duration, or a --script that drives the page), then assembly (assemble.ts) and the pointer trace
// (trace-page.ts, trace-build.ts). Playwright is loaded only when recording, so the rest of the CLI never needs it.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { classify, MediaError } from '../../../../src/lib/media/classify.js'
import type { Trace } from '../../../../src/lib/recording-trace.js'
import { assemble, type CapturedFrame } from './assemble.js'
import { buildTrace } from './trace-build.js'
import { TRACE_BINDING, traceScript, type PageEvent } from './trace-page.js'

export interface RecordOptions {
  url: string
  viewport: { width: number; height: number }
  dpr: number
  fps: number
  out: string
  storageState?: string | undefined
  saveStorageState?: string | undefined
  /** Stop after this many seconds (and start at once); else wait for r and s. */
  durationS?: number | undefined
  /** A module whose default export drives the page: recording starts before it and stops after. */
  script?: string | undefined
  headless: boolean
  hide: string[]
  names: boolean
  tool: string
  /** Keys typed in the terminal (r, s); tests pass their own. */
  keys?: AsyncIterable<string> | undefined
  log: (event: string, fields?: Record<string, unknown>) => void
  say: (text: string) => void
}

export interface RecordResult {
  file: string
  trace: string
  seconds: number
  frames: number
  width: number
  height: number
  clicks: number
  hidden: number
  normalized: true
}

/** Playwright, or an error saying how to get it. */
async function playwright(): Promise<typeof import('playwright')> {
  try {
    return await import('playwright')
  } catch {
    throw new Error(
      'video-agent record needs Playwright: npm i -g playwright && npx playwright install chromium',
    )
  }
}

/** r, s and q from a terminal in raw mode, as single characters. */
async function* terminalKeys(): AsyncIterable<string> {
  const stdin = process.stdin
  if (stdin.isTTY) stdin.setRawMode(true)
  stdin.setEncoding('utf8')
  try {
    for await (const chunk of stdin)
      for (const c of String(chunk)) yield c === '\u0003' ? 'q' : c.toLowerCase()
  } finally {
    if (stdin.isTTY) stdin.setRawMode(false)
    stdin.pause()
  }
}

async function waitFor(keys: AsyncIterator<string>, want: string[]): Promise<string> {
  for (;;) {
    const k = await keys.next()
    if (k.done) return 'q'
    if (want.includes(k.value)) return k.value
  }
}

export async function runRecord(o: RecordOptions): Promise<RecordResult> {
  const { chromium } = await playwright()
  mkdirSync(o.out, { recursive: true })
  const work = mkdtempSync(join(tmpdir(), 'va-record-'))
  const started = Date.now()
  const browser = await chromium.launch({
    headless: o.headless,
    args: [
      `--force-device-scale-factor=${String(o.dpr)}`,
      `--window-size=${String(o.viewport.width)},${String(o.viewport.height + 120)}`,
    ],
  })
  try {
    const context = await browser.newContext({
      viewport: null,
      ...(o.storageState ? { storageState: o.storageState } : {}),
    })
    const events: PageEvent[] = []
    const navigations: { t: number; path: string }[] = []
    await context.exposeBinding(TRACE_BINDING, (_src, batch: PageEvent[]) => {
      events.push(...batch)
    })
    await context.addInitScript(traceScript({ hide: ['input[type=password]', ...o.hide], names: o.names }))
    const page = await context.newPage()
    const metrics = await context.newCDPSession(page)
    await metrics.send('Emulation.setDeviceMetricsOverride', {
      ...o.viewport,
      deviceScaleFactor: 0,
      mobile: false,
    })
    page.on('framenavigated', (f) => {
      if (f !== page.mainFrame()) return
      try {
        navigations.push({ t: Date.now(), path: new URL(f.url()).pathname })
      } catch {
        // about:blank and the like
      }
    })
    await page.goto(o.url)
    o.log('record.opened', { url: new URL(o.url).origin, ms: Date.now() - started })

    const keys = (o.keys ?? (o.durationS === undefined && !o.script ? terminalKeys() : undefined))?.[
      Symbol.asyncIterator
    ]()
    if (keys) {
      o.say(
        'Get the page ready (sign in, open the right screen). Press r to start recording, s to stop, q to quit.',
      )
      if ((await waitFor(keys, ['r', 'q'])) === 'q') throw new Error('Stopped before recording started.')
    }

    // The screencast: every frame acked, saved as it comes.
    const cdp = await context.newCDPSession(page)
    const frames: CapturedFrame[] = []
    cdp.on(
      'Page.screencastFrame',
      (e: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
        const file = join(work, `f${String(frames.length).padStart(6, '0')}.jpg`)
        writeFileSync(file, Buffer.from(e.data, 'base64'))
        frames.push({ file, ts: e.metadata.timestamp ?? Date.now() / 1000 })
        void cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {})
      },
    )
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 90,
      maxWidth: o.viewport.width * o.dpr,
      maxHeight: o.viewport.height * o.dpr,
      everyNthFrame: 1,
    })
    const startedAt = new Date().toISOString()
    o.say('Recording. Press s to stop.')
    o.log('record.started', { viewport: o.viewport, dpr: o.dpr })
    if (o.script) {
      const mod = (await import(pathToFileURL(o.script).href)) as {
        default: (page: unknown) => Promise<void>
      }
      await mod.default(page)
    } else if (o.durationS !== undefined) await page.waitForTimeout(o.durationS * 1000)
    else if (keys) await waitFor(keys, ['s', 'q'])
    // Let the last events and frames arrive.
    await page.waitForTimeout(400)
    await page.evaluate('void 0').catch(() => {})
    await cdp.send('Page.stopScreencast')
    const stopTs = Date.now() / 1000
    o.log('record.stopped', { frames: frames.length, ms: Date.now() - started })

    if (o.saveStorageState) {
      await context.storageState({ path: o.saveStorageState })
      chmodSync(o.saveStorageState, 0o600)
    }

    const file = join(o.out, 'recording.mp4')
    const first = frames[0]
    const seconds = await assemble(frames, { out: file, fps: o.fps, workDir: work, stopTs })
    const probe = spawnSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height',
        '-of',
        'csv=p=0',
        file,
      ],
      { encoding: 'utf8' },
    )
    const [width, height] = probe.stdout.trim().split(',').map(Number) as [number, number]
    o.log('record.assembled', { seconds, width, height, ms: Date.now() - started })
    // The same checks an upload gets (§4.2).
    try {
      classify(new Uint8Array(readFileSync(file)), { role: 'screen-recording' })
    } catch (e) {
      throw new Error(
        `The recording isn't a valid screen recording: ${e instanceof MediaError ? e.message : String(e)}`,
        { cause: e },
      )
    }

    const trace: Trace = buildTrace({
      events,
      navigations,
      start: first?.ts ?? stopTs,
      duration: seconds,
      frame: { width, height, fps: o.fps },
      viewport: { ...o.viewport, dpr: o.dpr },
      tool: o.tool,
      kind: o.script ? 'script' : 'cli',
      startedAt,
    })
    const tracePath = join(o.out, 'trace.json')
    writeFileSync(tracePath, `${JSON.stringify(trace)}\n`)
    const clicks = trace.events.filter((e) => e.kind === 'click').length
    o.log('record.trace', {
      moves: trace.moves.length,
      events: trace.events.length,
      clicks,
      hidden: trace.redact.length,
    })
    return {
      file,
      trace: tracePath,
      seconds,
      frames: frames.length,
      width,
      height,
      clicks,
      hidden: trace.redact.length,
      normalized: true,
    }
  } finally {
    await browser.close().catch(() => {})
    rmSync(work, { recursive: true, force: true })
  }
}
