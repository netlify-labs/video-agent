// A complete, minimal HTTP destination receiver for Video Agent's destination contract v1
// (docs/plans/2026-11-04-publish-destinations.md §3; /docs/destinations). No dependencies: a request handler you can
// put behind any HTTPS server or serverless function. It stores "pages" in memory; replace that with your own.
//
// It shows everything a receiver must do:
// - verify x-video-agent-signature over the raw body (±300 s, constant time) with the destination's secret;
// - be idempotent by `operation` (retries re-send the same operation id with a new signature);
// - answer ping (with capabilities), targets (generic: id, name, description, url, metadata), publish and remove;
// - treat `target` as untrusted: look it up yourself for this publisher, never trust its metadata;
// - answer publish/remove with 202 and finish later through the callback (Authorization: Bearer <token>).
import { createHmac, timingSafeEqual } from 'node:crypto'

export interface ReceiverOptions {
  /** The signing secret Video Agent showed when the destination was added. */
  secret: string
  /** Seconds since the epoch (injectable for tests). */
  now?: () => number
  /** Sends a callback; the default uses fetch. */
  post?: (url: string, token: string, body: object) => Promise<number>
  /** Finish publishes in the background (true) or answer 200 live at once (false). Default true. */
  async?: boolean
}

/** The parts of a contract v1 request this receiver reads (see /docs/destinations for every field). */
interface DestinationRequest {
  contract: number
  event: 'ping' | 'targets' | 'publish' | 'remove'
  publisher: { id: string } | null
  publication: string
  operation: string
  options?: Record<string, unknown>
  target?: { id: string } | null
  externalId?: string | null
  manifest: { video: { title: string } }
  callback: { url: string; token: string }
}

interface Page {
  id: string
  owner: string
  name: string
  url: string
  videos: string[]
}

export function verifySignature(secret: string, raw: string, header: string, nowSec: number): boolean {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header)
  if (!m) return false
  const t = Number(m[1])
  if (Math.abs(nowSec - t) > 300) return false
  const want = createHmac('sha256', secret).update(`${t}.${raw}`).digest()
  const got = Buffer.from(m[2] ?? '', 'hex')
  return got.length === want.length && timingSafeEqual(got, want)
}

export function createReceiver(o: ReceiverOptions) {
  const now = o.now ?? (() => Math.floor(Date.now() / 1000))
  const post =
    o.post ??
    (async (url: string, token: string, body: object) =>
      (
        await fetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).status)
  const pages = new Map<string, Page>()
  /** Answers by operation id, so a retried request gets the same answer (and does the work once). */
  const answered = new Map<string, { status: number; body: unknown }>()
  const pending: Promise<unknown>[] = []

  async function handle(raw: string, headers: Record<string, string | undefined>) {
    if (!verifySignature(o.secret, raw, headers['x-video-agent-signature'] ?? '', now()))
      return { status: 401, body: { error: { message: 'Bad signature.' } } }
    const req = JSON.parse(raw) as DestinationRequest
    if (req.contract !== 1) return { status: 400, body: { error: { message: 'Unsupported contract.' } } }
    const owner = req.publisher?.id ?? ''
    switch (req.event) {
      case 'ping':
        return {
          status: 200,
          body: {
            capabilities: {
              targets: true,
              targetNoun: 'page',
              instructions: true,
              instructionsLabel: 'Notes for the page',
            },
          },
        }
      case 'targets':
        return {
          status: 200,
          body: {
            targets: [...pages.values()]
              .filter((p) => p.owner === owner)
              .map((p) => ({
                id: p.id,
                name: p.name,
                description: `${p.videos.length} video(s)`,
                url: p.url,
                metadata: { videos: p.videos.length },
              })),
          },
        }
      case 'publish':
      case 'remove': {
        const prior = answered.get(req.operation)
        if (prior) return prior
        const answer = req.event === 'publish' ? publish(req, owner) : remove(req, owner)
        answered.set(req.operation, answer)
        return answer
      }
      default:
        return { status: 400, body: { error: { message: 'Unknown event.' } } }
    }
  }

  function publish(req: DestinationRequest, owner: string) {
    // The target came back through a browser: look it up yourself, for this publisher.
    let page: Page | undefined
    if (req.target) {
      page = pages.get(req.target.id)
      if (!page || page.owner !== owner)
        return { status: 403, body: { error: { message: 'Not your page.' } } }
    } else {
      const id = `page-${pages.size + 1}`
      const name = (
        typeof req.options?.name === 'string' ? req.options.name : req.manifest.video.title
      ).slice(0, 60)
      page = { id, owner, name, url: `https://pages.example.com/${id}`, videos: [] }
      pages.set(id, page)
    }
    const p = page
    const finish = async () => {
      // A real receiver copies manifest.files[].url (signed, 10 minutes) and checks each file's sha256 here.
      p.videos.push(req.publication)
      return {
        operation: req.operation,
        status: 'live',
        url: `${p.url}#${req.publication}`,
        externalId: p.id,
      }
    }
    if (o.async === false) {
      p.videos.push(req.publication)
      return { status: 200, body: { status: 'live', url: `${p.url}#${req.publication}`, externalId: p.id } }
    }
    pending.push(
      (async () => {
        await post(req.callback.url, req.callback.token, {
          operation: req.operation,
          status: 'working',
          message: 'Copying the video',
        })
        await post(req.callback.url, req.callback.token, await finish())
      })(),
    )
    return { status: 202, body: { status: 'accepted', externalId: p.id, message: 'Adding it to the page' } }
  }

  function remove(req: DestinationRequest, owner: string) {
    const page = req.externalId ? pages.get(req.externalId) : undefined
    if (!page || page.owner !== owner) return { status: 404, body: {} }
    page.videos = page.videos.filter((v) => v !== req.publication)
    return { status: 200, body: { status: 'removed' } }
  }

  return { handle, pages, settle: () => Promise.all(pending.splice(0)) }
}
