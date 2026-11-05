// The CLI against the in-process app: main(argv, io) with io.fetch routed to createApp (and a stub storage host for
// signed file links), a temp config dir, and every byte of output captured.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../packages/cli/src/router.js'
import type { Io } from '../packages/cli/src/io.js'
import { apiKey, type Harness } from './helpers.js'
import { appFetch } from './sdk-fetch.js'

export const SITE = 'https://video.example.com'

export interface CliRun {
  code: number
  stdout: string
  stderr: string
  /** JSON.parse(stdout), for --json runs. */
  json: () => any
}

export async function cli(
  h: Harness,
  o: {
    as?: string
    key?: string | null
    /** Answers requests that aren't for the app (signed storage links, share JSON on other hosts). */
    other?: (req: Request) => Response | Promise<Response>
    stdin?: string
    /** Move the fake run one sweep tick on each poll of a video, so --wait walks the lifecycle. */
    drive?: boolean
  } = {},
) {
  const key = o.key === null ? undefined : (o.key ?? (await apiKey(h, o.as ?? h.member)))
  const opened: string[] = []
  const requests: Request[] = []
  const configDir = mkdtempSync(join(tmpdir(), 'va-cli-'))
  const run = async (argv: string[]): Promise<CliRun> => {
    let stdout = ''
    let stderr = ''
    const io: Io = {
      stdout: (t) => (stdout += t),
      stderr: (t) => (stderr += t),
      stdin: async () => o.stdin ?? '',
      env: { VIDEO_AGENT_URL: SITE, ...(key ? { VIDEO_AGENT_KEY: key } : {}) },
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const req = new Request(input, init)
        requests.push(req.clone())
        const url = new URL(req.url)
        if (o.drive && req.method === 'GET' && /^\/api\/v1\/videos\/[^/]+$/.test(url.pathname))
          await h.drive(1)
        if (url.origin === SITE && url.pathname.startsWith('/api/')) return appFetch(h, req)
        if (o.other) return o.other(req)
        return new Response('not found', { status: 404 })
      },
      now: () => Date.now(),
      openBrowser: async (u) => void opened.push(u),
      configDir,
      pollMs: 0,
    }
    const code = await main(argv, io)
    return { code, stdout, stderr, json: () => JSON.parse(stdout) }
  }
  return { run, opened, requests, key }
}
