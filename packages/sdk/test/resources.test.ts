// The generated resource methods describe the right request; their types follow the spec (cli-and-sdk plan §4.1).
import { expect, it } from 'vitest'
import { PAGEABLE, resources } from '../src/generated/resources.js'
import { prepare, type Call, type CallOptions, type Transport } from '../src/transport.js'

const recorder = () => {
  const calls: { call: Call; opts?: CallOptions | undefined }[] = []
  const t: Transport = {
    call: async <T>(call: Call, opts?: CallOptions) => {
      calls.push({ call, opts })
      return undefined as T
    },
  }
  return { va: resources(t), calls }
}

it('positional path params, merged input and opts reach the transport', async () => {
  const { va, calls } = recorder()
  await va.versions.publish('v_1', 2, { showTranscript: true }, { idempotencyKey: 'k' })
  await va.videos.list({ owner: 'me', q: 'webhooks' })
  await va.versions.retry('v_1', 3)
  const [publish, list, retry] = calls.map((c) => ({ ...c, req: prepare(c.call) }))
  expect(publish?.req).toMatchObject({
    path: '/api/v1/videos/v_1/versions/2/publish',
    body: { showTranscript: true },
  })
  expect(publish?.opts).toEqual({ idempotencyKey: 'k' })
  expect(list?.req.query.toString()).toBe('owner=me&q=webhooks')
  expect(list?.call.method).toBe('GET')
  expect(retry?.req.path).toBe('/api/v1/videos/v_1/versions/3/retry')
})

it('feature-gated operations and fields name their features', async () => {
  const { va, calls } = recorder()
  await va.videos.remix('v_1', { prompt: 'Make it orange' })
  await va.videos.create({ prompt: 'A launch video', planId: 'p_1' })
  await va.videos.create({ prompt: 'A launch video' })
  expect(calls.map((c) => c.call.features)).toEqual([['remix'], ['planning'], []])
})

it('lists the pageable operations', () => {
  expect(PAGEABLE).toContain('videos.list')
  expect(PAGEABLE).not.toContain('media.recordings')
})
