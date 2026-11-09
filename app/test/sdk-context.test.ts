// The SDK and the GitHub Action plan's phase 3 fields (beads va-mg4i.4.2, 4.3): context, externalRef, externalUrl and
// private are refused with unsupported_by_server when the server doesn't list their feature (an older server would drop
// them and still answer 202), and sent when it does. One JSON line per case.
import { describe, expect, it } from 'vitest'
import { isVideoAgentError, VideoAgent } from '../../packages/sdk/src/index.js'
import { apiKey, harness, PROMPT, readyVideo, type Harness } from './helpers.js'
import { appFetch } from './sdk-fetch.js'

const log = (fields: Record<string, unknown>) => console.log(JSON.stringify(fields))
const CONTEXT = { source: 'github_pr' as const, label: 'GitHub PR #123', text: 'Adds a retry button.' }

/** A client; `older` hides context and external_ref from /api/v1/config, like a server before phase 3. */
const client = async (h: Harness, older = false) =>
  new VideoAgent({
    url: 'https://video.example.com',
    apiKey: await apiKey(h, h.member),
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init)
      const res = await appFetch(h, req)
      if (!older || new URL(req.url).pathname !== '/api/v1/config') return res
      const body = (await res.json()) as { features: string[] }
      body.features = body.features.filter((f) => f !== 'context' && f !== 'external_ref')
      return Response.json(body)
    },
  })

const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => (isVideoAgentError(e) ? e : Promise.reject(e as Error)),
  )

describe('SDK: context and external refs', () => {
  it('refuses each gated field on a server without the feature, before any request is sent', async () => {
    const h = harness()
    const va = await client(h, true)
    const source = await readyVideo(h)
    for (const [name, call] of [
      ['create context', () => va.videos.create({ prompt: PROMPT, context: CONTEXT })],
      ['create externalRef', () => va.videos.create({ prompt: PROMPT, externalRef: 'github:acme/web#pr-1' })],
      [
        'create externalUrl',
        () => va.videos.create({ prompt: PROMPT, externalUrl: 'https://github.com/acme/web/pull/1' }),
      ],
      ['create private', () => va.videos.create({ prompt: PROMPT, private: true })],
      ['revise context', () => va.videos.revise(source, { prompt: 'Make it orange.', context: CONTEXT })],
      ['remix context', () => va.videos.remix(source, { prompt: 'Same, for payments.', context: CONTEXT })],
      [
        'remix externalRef',
        () => va.videos.remix(source, { prompt: 'Same, for payments.', externalRef: 'github:acme/web@v1' }),
      ],
      ['list externalRef', () => va.videos.list({ externalRef: 'github:acme/web#pr-1' })],
    ] as const) {
      const e = await failure(call())
      log({ case: name, code: e?.code })
      expect(e?.code, name).toBe('unsupported_by_server')
    }
    // Nothing was created.
    expect((await va.videos.list({ owner: 'me' })).items).toHaveLength(1)
  })

  it('sends them when the server lists the features', async () => {
    const h = harness()
    const va = await client(h)
    expect(await va.config.supports('context')).toBe(true)
    expect(await va.config.supports('external_ref')).toBe(true)
    const v = await va.videos.create({
      prompt: PROMPT,
      context: CONTEXT,
      externalRef: 'github:acme/web#pr-1',
      externalUrl: 'https://github.com/acme/web/pull/1',
      private: true,
    })
    expect(v).toMatchObject({ externalRef: 'github:acme/web#pr-1', private: true })
    expect(v.versions[0]?.context).toEqual(CONTEXT)
    expect((await va.videos.list({ externalRef: 'github:acme/web#pr-1' })).items.map((x) => x.id)).toEqual([
      v.id,
    ])
    log({ case: 'sent', video: v.id })
  })
})
