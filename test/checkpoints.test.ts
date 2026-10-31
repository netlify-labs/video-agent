// Run checkpoints (plan v2 §6 A2, §14 rule 28): token, latest running attempt only, ordering, bounds, rate, its
// own store, cleanup, and never touching attempt rows. Plus the best-effort client in scripts/checkpoint.ts.
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { postCheckpoint } from '../scripts/checkpoint.js'
import { checkpointBundleKey } from '../src/domain/checkpoints.js'
import { failedSnap, running } from './fakes.js'
import { harness, type Harness } from './helpers.js'

const PROMPT = 'A short launch video for org webhooks, with three beats and an end card.'

async function runningAttempt(h: Harness) {
  h.deps.runner.nextScripts.push({ timeline: [running()] })
  const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
  await h.drive(2)
  const [a] = await h.attempts(v.id)
  expect(a?.stage).toBe('running')
  const prompt = h.deps.runner.starts.at(-1)?.prompt ?? ''
  const token = /--token (\S+)/.exec(prompt)?.[1] ?? ''
  const url = /checkpoint\.ts --attempt \S+ --url (\S+)/.exec(prompt)?.[1] ?? ''
  return { id: v.id as string, attemptId: a?.id ?? '', token, url }
}

const post = (h: Harness, attemptId: string, token: string | null, body: unknown) =>
  h.call('POST', `/api/internal/runs/${attemptId}/checkpoint`, {
    origin: null,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body,
  })
const progress = async (h: Harness, id: string) =>
  h.json(await h.call('GET', `/api/v1/videos/${id}/progress`, { as: h.member }))
const gz = (s: string) => gzipSync(Buffer.from(s)).toString('base64')

describe('checkpoints', () => {
  it('the prompt names the checkpoint script with this attempt and its URL', async () => {
    const h = harness()
    const { attemptId, url } = await runningAttempt(h)
    expect(url).toBe(`https://video.example.com/api/internal/runs/${attemptId}/checkpoint`)
  })

  it('needs the attempt token', async () => {
    const h = harness()
    const { attemptId } = await runningAttempt(h)
    expect((await post(h, attemptId, null, { seq: 1, message: 'x' })).status).toBe(401)
    expect((await post(h, attemptId, 'wrong', { seq: 1, message: 'x' })).status).toBe(401)
  })

  it('shows the latest milestone in progress; older or equal seqs never replace it', async () => {
    const h = harness()
    const { id, attemptId, token } = await runningAttempt(h)
    expect(
      await h.json(await post(h, attemptId, token, { seq: 3, message: 'Writing the end card' })),
    ).toEqual({
      accepted: true,
      seq: 3,
    })
    const late = await h.json(await post(h, attemptId, token, { seq: 2, message: 'Reading context' }))
    expect(late).toMatchObject({ accepted: false, seq: 3 })
    expect((await post(h, attemptId, token, { seq: 3, message: 'dup' })).status).toBe(200)
    const p = await progress(h, id)
    expect(p.checkpoint).toMatchObject({
      seq: 3,
      message: 'Writing the end card',
      renderPercent: null,
      hasBundle: false,
    })
  })

  it('a render-progress post keeps the last milestone text', async () => {
    const h = harness()
    const { id, attemptId, token } = await runningAttempt(h)
    await post(h, attemptId, token, { seq: 1, message: 'Rendering' })
    await post(h, attemptId, token, { seq: 2, renderPercent: 40 })
    expect((await progress(h, id)).checkpoint).toMatchObject({ message: 'Rendering', renderPercent: 40 })
  })

  it('bounds: message length, bundle size and type, empty posts', async () => {
    const h = harness()
    const { id, attemptId, token } = await runningAttempt(h)
    await post(h, attemptId, token, { seq: 1, message: 'x'.repeat(900) })
    expect((await progress(h, id)).checkpoint.message).toHaveLength(500)
    expect((await post(h, attemptId, token, { seq: 2, message: 'y'.repeat(2001) })).status).toBe(400)
    expect((await post(h, attemptId, token, { seq: 3 })).status).toBe(400)
    expect((await post(h, attemptId, token, { seq: 4, renderPercent: 101 })).status).toBe(400)
    const notGzip = Buffer.from('plain text').toString('base64')
    expect((await post(h, attemptId, token, { seq: 5, message: 'm', bundle: notGzip })).status).toBe(400)
    const big = Buffer.alloc(2 * 1024 * 1024 + 10)
    big[0] = 0x1f
    big[1] = 0x8b
    expect(
      (await post(h, attemptId, token, { seq: 6, message: 'm', bundle: big.toString('base64') })).status,
    ).toBe(400)
  })

  it('rate-limits to 10 a minute', async () => {
    const h = harness()
    const { attemptId, token } = await runningAttempt(h)
    for (let i = 1; i <= 10; i++)
      expect((await post(h, attemptId, token, { seq: i, message: `m${i}` })).status).toBe(200)
    expect((await post(h, attemptId, token, { seq: 11, message: 'too many' })).status).toBe(429)
    h.deps.clock.advance(61_000)
    expect((await post(h, attemptId, token, { seq: 12, message: 'later' })).status).toBe(200)
  })

  it('keeps only the latest bundle, under the attempt in the checkpoints store', async () => {
    const h = harness()
    const { id, attemptId, token } = await runningAttempt(h)
    await post(h, attemptId, token, { seq: 1, message: 'first', bundle: gz('one') })
    expect(await h.deps.blobs.get('checkpoints', checkpointBundleKey(attemptId, 1))).not.toBeNull()
    await post(h, attemptId, token, { seq: 2, message: 'second', bundle: gz('two') })
    expect(await h.deps.blobs.get('checkpoints', checkpointBundleKey(attemptId, 1))).toBeNull()
    expect(await h.deps.blobs.get('checkpoints', checkpointBundleKey(attemptId, 2))).not.toBeNull()
    await post(h, attemptId, token, { seq: 3, message: 'no bundle this time' })
    expect((await progress(h, id)).checkpoint).toMatchObject({ seq: 3, hasBundle: true })
  })

  it('only while the attempt is the latest and running', async () => {
    const h = harness()
    h.deps.runner.nextScripts.push({ timeline: [running(), failedSnap()] })
    const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
    await h.drive(2)
    const [a] = await h.attempts(v.id)
    const token = /--token (\S+)/.exec(h.deps.runner.starts[0]?.prompt ?? '')?.[1] ?? ''
    expect((await post(h, a?.id ?? '', token, { seq: 1, message: 'ok' })).status).toBe(200)
    await h.drive(4)
    expect((await h.attempts(v.id))[0]?.stage).toBe('failed')
    expect((await post(h, a?.id ?? '', token, { seq: 2, message: 'after the end' })).status).toBe(410)
    // A retry makes a new attempt; the old one's token can't post for it.
    await h.call('POST', `/api/v1/videos/${v.id}/versions/1/retry`, { as: h.member })
    expect((await post(h, a?.id ?? '', token, { seq: 3, message: 'old attempt' })).status).toBe(410)
  })

  it('stops after a cancel or delete', async () => {
    const h = harness()
    const { id, attemptId, token } = await runningAttempt(h)
    await h.call('POST', `/api/v1/videos/${id}/versions/1/cancel`, { as: h.member })
    expect((await post(h, attemptId, token, { seq: 1, message: 'x' })).status).toBe(410)
    const other = await runningAttempt(h)
    await h.call('DELETE', `/api/v1/videos/${other.id}`, { as: h.member })
    expect((await post(h, other.attemptId, other.token, { seq: 1, message: 'x' })).status).toBe(410)
  })

  it('never changes attempt rows, receipts or leases', async () => {
    const h = harness()
    const { id, attemptId, token } = await runningAttempt(h)
    const before = JSON.stringify(await h.attempts(id))
    await post(h, attemptId, token, { seq: 1, message: 'm', bundle: gz('x') })
    expect(JSON.stringify(await h.attempts(id))).toBe(before)
    expect(await h.deps.store.getReceipt(attemptId)).toBeNull()
  })

  it('schedules cleanup of the bundles when the attempt ends', async () => {
    const h = harness()
    const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
    await h.drive(4)
    const [a] = await h.attempts(v.id)
    const due = await h.deps.store.listDueCleanup(new Date(Date.now() + 365 * 86400_000).toISOString(), 100)
    expect(due.some((c) => c.store === 'checkpoints' && c.prefix === `${a?.id}/`)).toBe(true)
  })
})

describe('scripts/checkpoint.ts', () => {
  it('numbers posts in order and never throws', async () => {
    const bodies: { seq: number; message?: string; renderPercent?: number }[] = []
    const ok = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const attempt = `t-${Date.now()}`
    expect(
      await postCheckpoint({ attempt, url: 'https://x/c', token: 't', message: 'one', fetchImpl: ok }),
    ).toEqual({
      ok: true,
    })
    await postCheckpoint({ attempt, url: 'https://x/c', token: 't', renderPercent: 42.4, fetchImpl: ok })
    expect(bodies.map((b) => b.seq)).toEqual([1, 2])
    expect(bodies[1]?.renderPercent).toBe(42)
    const down = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    expect(
      await postCheckpoint({ attempt, url: 'https://x/c', token: 't', message: 'x', fetchImpl: down }),
    ).toEqual({
      ok: false,
      reason: 'network down',
    })
    const gone = (async () => new Response('{}', { status: 410 })) as unknown as typeof fetch
    expect(
      (await postCheckpoint({ attempt, url: 'https://x/c', token: 't', message: 'x', fetchImpl: gone })).ok,
    ).toBe(false)
  })
})
