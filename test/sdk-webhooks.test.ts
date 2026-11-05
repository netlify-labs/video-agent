// The SDK's webhook verification against signatures the server itself makes (src/lib/crypto.ts webhookSignature).
import { describe, expect, it } from 'vitest'
import { isVideoAgentError, parseWebhook, verifyWebhook } from '../packages/sdk/src/index.js'
import { webhookSignature } from '../src/lib/crypto.js'
import type { WebhookEventType } from '../src/domain/types.js'
import type { WebhookEventType as SdkEventType } from '../packages/sdk/src/webhooks.js'

const secret = 'whsec_test_secret'
const now = 1_800_000_000
const body = JSON.stringify({
  eventId: 'evt_1',
  event: 'video.ready',
  createdAt: '2026-11-05T00:00:00Z',
  version: 2,
})
const sig = (b = body, t = now, s = secret) => webhookSignature(s, b, t)
const refused = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  )
  return isVideoAgentError(e, 'invalid_signature')
}

describe('SDK webhooks', () => {
  it('accepts a signature the server made', async () => {
    await expect(verifyWebhook({ secret, body, signature: sig(), nowSec: now + 10 })).resolves.toBeUndefined()
  })

  it('refuses a tampered body, a wrong secret, old and future timestamps, and malformed or missing headers', async () => {
    expect(
      await refused(verifyWebhook({ secret, body: body.replace('2', '3'), signature: sig(), nowSec: now })),
    ).toBe(true)
    expect(
      await refused(verifyWebhook({ secret, body, signature: sig(body, now, 'other'), nowSec: now })),
    ).toBe(true)
    expect(await refused(verifyWebhook({ secret, body, signature: sig(), nowSec: now + 301 }))).toBe(true)
    expect(await refused(verifyWebhook({ secret, body, signature: sig(), nowSec: now - 301 }))).toBe(true)
    expect(
      await refused(verifyWebhook({ secret, body, signature: sig(), nowSec: now + 600, toleranceSec: 900 })),
    ).toBe(false)
    for (const bad of [null, '', 't=abc,v1=00', `t=${now}`, `v1=${'a'.repeat(64)}`, `t=${now},v1=xyz`])
      expect(await refused(verifyWebhook({ secret, body, signature: bad, nowSec: now })), String(bad)).toBe(
        true,
      )
  })

  it('parseWebhook verifies and returns the event with its dedupe fields', async () => {
    const headers = new Headers({
      'x-video-agent-signature': sig(),
      'x-video-agent-event': 'video.ready',
      'x-video-agent-delivery': 'del_1',
    })
    expect(await parseWebhook({ secret, body, headers, nowSec: now })).toMatchObject({
      eventId: 'evt_1',
      event: 'video.ready',
      version: 2,
      deliveryId: 'del_1',
    })
    // A plain header record (Express, Node http), any case.
    const ev = await parseWebhook({
      secret,
      body,
      headers: { 'X-Video-Agent-Signature': sig(), 'x-video-agent-delivery': ['del_2'] },
      nowSec: now,
    })
    expect(ev.deliveryId).toBe('del_2')
    expect(await refused(parseWebhook({ secret, body, headers: {}, nowSec: now }))).toBe(true)
  })

  it("lists the server's event types", () => {
    const same = (x: WebhookEventType): SdkEventType => x
    const back = (x: SdkEventType): WebhookEventType => x
    expect(back(same('video.ready'))).toBe('video.ready')
  })
})
