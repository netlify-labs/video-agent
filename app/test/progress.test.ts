// Live progress (plan v2 §6 A1, §14 rules 3, 28): a pure read that reads the runner at most every 5 s per run
// through a shared cache, falls back to stored rows, and marks stale values.
import { describe, expect, it } from 'vitest'
import type { RunnerSnapshot } from '../server/deps.js'
import { progressKey, SNAPSHOT_EVERY_MS } from '../server/domain/progress.js'
import { failedSnap, running } from './fakes.js'
import { apiKey, harness, mcpCall, PROMPT, readyVideo, type Harness } from './helpers.js'

const step = (latestStep: string, stepsCount: number, totalCreditsCost: number): RunnerSnapshot => ({
  kind: 'running',
  state: 'running',
  latestStep,
  usage: { stepsCount, totalCreditsCost },
})

/** A video whose run stays in `running`, with snapshot calls from progress counted. */
async function runningVideo(h: Harness, timeline: RunnerSnapshot[] = [step('Writing the end card', 7, 12)]) {
  h.deps.runner.nextScripts.push({ timeline })
  const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
  await h.drive(2)
  const [a] = await h.attempts(v.id)
  expect(a?.stage).toBe('running')
  const real = h.deps.runner.snapshot.bind(h.deps.runner)
  const counter = { calls: 0, fail: false }
  h.deps.runner.snapshot = async (handle: string) => {
    counter.calls++
    if (counter.fail) throw new Error('runner unreachable')
    return real(handle)
  }
  return { id: v.id as string, attemptId: a?.id ?? '', counter }
}

const progress = async (h: Harness, id: string, as = h.member) =>
  h.json(await h.call('GET', `/api/v1/videos/${id}/progress`, { as }))

describe('progress', () => {
  it("reports the agent's step, steps and credits while running", async () => {
    const h = harness()
    const { id, attemptId } = await runningVideo(h)
    const p = await progress(h, id)
    expect(p).toMatchObject({
      attemptId,
      versionN: 1,
      stage: 'running',
      step: 'Writing the end card',
      steps: 7,
      credits: 12,
      stale: false,
    })
    expect(p.observedAt).toBe(h.deps.clock.now().toISOString())
  })

  it('reads the runner at most once per 5 s, however many people poll', async () => {
    const h = harness()
    const { id, counter } = await runningVideo(h)
    for (let i = 0; i < 5; i++) await progress(h, id)
    expect(counter.calls).toBe(1)
    h.deps.clock.advance(SNAPSHOT_EVERY_MS + 1)
    await progress(h, id)
    await progress(h, id)
    expect(counter.calls).toBe(2)
  })

  it('serves the cache while another instance holds the fetch lease', async () => {
    const h = harness()
    const { id, attemptId, counter } = await runningVideo(h)
    const now = h.deps.clock.now().getTime()
    await h.deps.blobs.set(
      'internal',
      progressKey(attemptId),
      JSON.stringify({
        observedAt: now - 6000,
        fetchingUntil: now + 4000,
        step: 'From the other instance',
        steps: 3,
        credits: 5,
      }),
    )
    const p = await progress(h, id)
    expect(counter.calls).toBe(0)
    expect(p).toMatchObject({ step: 'From the other instance', steps: 3, stale: false })
  })

  it('marks the last known value stale when the runner cannot be read', async () => {
    const h = harness()
    const { id, counter } = await runningVideo(h)
    await progress(h, id)
    counter.fail = true
    h.deps.clock.advance(SNAPSHOT_EVERY_MS + 1)
    const p = await progress(h, id)
    expect(p).toMatchObject({ step: 'Writing the end card', steps: 7, stale: true })
  })

  it('falls back to the stored step (stale) when nothing is cached and the runner fails', async () => {
    const h = harness()
    const { id, counter } = await runningVideo(h)
    counter.fail = true
    const p = await progress(h, id)
    expect(p.stale).toBe(true)
    expect(p.observedAt).toBeNull()
    expect(p.stage).toBe('running')
  })

  it('handles null usage', async () => {
    const h = harness()
    const { id } = await runningVideo(h, [running('running', 'Checking, round 2')])
    expect(await progress(h, id)).toMatchObject({ step: 'Checking, round 2', steps: null, credits: null })
  })

  it('answers queued and starting from rows without reading the runner', async () => {
    const h = harness({ MAX_ACTIVE_RUNS: '1' })
    await runningVideo(h)
    const queued = await h.json(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
    )
    const before = h.deps.runner.starts.length
    const p = await progress(h, queued.id)
    expect(p).toMatchObject({ stage: 'queued', step: null, stale: false, observedAt: null })
    expect(h.deps.runner.starts.length).toBe(before)
  })

  it('never changes attempt rows', async () => {
    const h = harness()
    const { id } = await runningVideo(h)
    const before = JSON.stringify(await h.attempts(id))
    await progress(h, id)
    h.deps.clock.advance(SNAPSHOT_EVERY_MS + 1)
    await progress(h, id)
    expect(JSON.stringify(await h.attempts(id))).toBe(before)
  })

  it('follows a retry to the new attempt', async () => {
    const h = harness()
    h.deps.runner.nextScripts.push({ timeline: [running(), failedSnap()] })
    const v = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
    await h.drive(5)
    const failed = await progress(h, v.id)
    expect(failed.stage).toBe('failed')
    expect((await h.call('POST', `/api/v1/videos/${v.id}/versions/1/retry`, { as: h.member })).status).toBe(
      202,
    )
    const retried = await progress(h, v.id)
    expect(retried.attemptId).not.toBe(failed.attemptId)
    expect(['queued', 'starting', 'running']).toContain(retried.stage)
  })

  it('is 404 for a private video someone else owns', async () => {
    const h = harness()
    const bob = h.deps.identity.addUser({ id: 'u_bob', email: 'bob@acme.com', name: 'Bob' }).cookie
    await h.call('GET', '/api/v1/me', { as: bob })
    const { id } = await runningVideo(h)
    await h.call('PATCH', `/api/v1/videos/${id}`, { as: h.member, body: { private: true } })
    expect((await h.call('GET', `/api/v1/videos/${id}/progress`, { as: bob })).status).toBe(404)
  })

  it('MCP get_video includes progress while a version is in progress', async () => {
    const h = harness()
    const { id } = await runningVideo(h)
    const r = await mcpCall(h, await apiKey(h, h.member), 'tools/call', {
      name: 'get_video',
      arguments: { video_id: id },
    })
    expect(r.structuredContent.progress).toMatchObject({
      step: 'Writing the end card',
      steps: 7,
      credits: 12,
    })
  })

  it('schedules cleanup of the progress cache when the attempt ends', async () => {
    const h = harness()
    const [a] = await h.attempts(await readyVideo(h))
    expect(a?.stage).toBe('ready')
    const due = await h.deps.store.listDueCleanup(new Date(Date.now() + 365 * 86400_000).toISOString(), 100)
    expect(due.some((c) => c.store === 'internal' && c.prefix === progressKey(a?.id ?? ''))).toBe(true)
  })
})
