import { describe, expect, it } from 'vitest'
import { verifyPath, webhookSignature } from '../src/lib/crypto.js'
import { RunnerError } from '../src/deps.js'
import { getSettings } from '../src/domain/settings.js'
import { harness } from './helpers.js'
import { failedSnap, running, succeeded } from './fakes.js'

const PROMPT = 'A short launch video for org webhooks, with three beats and an end card.'

describe('video lifecycle', () => {
  it('creates, runs, finalizes, serves, revises and publishes a video', async () => {
    const h = harness()
    const created = await h.call('POST', '/api/v1/videos', {
      as: h.member,
      body: { prompt: PROMPT, aspect: '16:9' },
    })
    expect(created.status).toBe(202)
    const video = await h.json(created)
    expect(video.status).toBe('queued')
    expect(created.headers.get('location')).toBe(`https://video.example.com/api/v1/videos/${video.id}`)

    await h.drive(4)
    const ready = await h.json(await h.call('GET', `/api/v1/videos/${video.id}`, { as: h.member }))
    expect(ready.status).toBe('ready')
    expect(ready.versions[0].output).toMatchObject({ width: 1920, height: 1080, title: 'Test video' })
    expect(ready.versions[0].usage).toEqual({ totalCreditsCost: 42 })

    // The run started from the production deploy with land none and the fenced prompt.
    const start = h.deps.runner.starts[0]
    expect(start?.deployId).toBe('deploy_prod_1')
    expect(start?.prompt).toContain(`<<<\n${PROMPT}\n>>>`)
    expect(start?.prompt).toContain('scripts/render-job.ts')

    // Files: signed redirect, verifiable by the edge function.
    const file = await h.call('GET', `/api/v1/videos/${video.id}/versions/1/video`, { as: h.member })
    expect(file.status).toBe(302)
    const loc = new URL(file.headers.get('location') ?? '', 'https://video.example.com')
    const { fileSigningSecret } = await getSettings(h.deps)
    expect(loc.pathname).toBe(`/files/${video.id}/v1/video.mp4`)
    expect(
      verifyPath(
        fileSigningSecret,
        loc.pathname,
        Number(loc.searchParams.get('exp')),
        loc.searchParams.get('sig') ?? '',
        Date.now() / 1000 - 3600,
      ),
    ).toBe(true)
    expect(await h.deps.blobs.get('videos', `${video.id}/v1/video.mp4`)).not.toBeNull()

    // Revise from v1: the run gets prepare-run with a manifest that names v1's source.
    const revised = await h.call('POST', `/api/v1/videos/${video.id}/versions`, {
      as: h.admin,
      body: { prompt: 'Make the end card orange.' },
    })
    expect(revised.status).toBe(202)
    await h.drive(4)
    const v2 = await h.json(await h.call('GET', `/api/v1/videos/${video.id}`, { as: h.member }))
    expect(v2.latestVersion).toBe(2)
    expect(v2.versions[0]).toMatchObject({ n: 2, status: 'ready', parentN: 1, authorId: 'u_admin' })
    expect(h.deps.runner.starts[1]?.prompt).toMatch(
      /prepare-run\.ts --job \S+ --attempt \S+ --manifest [0-9a-f]{64}/,
    )

    // Publishing: member (owner) publishes v2; the edge mirror appears; unpublish removes it.
    const pub = await h.json(
      await h.call('POST', `/api/v1/videos/${video.id}/versions/2/publish`, { as: h.member }),
    )
    expect(pub.urls.mp4).toBe(`https://video.example.com/v/${pub.slug}.mp4`)
    expect(h.deps.blobs.text('internal', `pub/${pub.slug}.json`)).toContain(`"versionN":2`)
    expect(
      (await h.call('DELETE', `/api/v1/videos/${video.id}/versions/2/publish`, { as: h.member })).status,
    ).toBe(204)
    expect(h.deps.blobs.text('internal', `pub/${pub.slug}.json`)).toBeNull()
    const again = await h.json(
      await h.call('POST', `/api/v1/videos/${video.id}/versions/2/publish`, { as: h.member }),
    )
    expect(again.slug).not.toBe(pub.slug)
  })

  it('finishes through the sweep when the callback never arrives (manifest from the final answer)', async () => {
    const h = harness({}, { autoCallback: false })
    const video = await h.json(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
    )
    // The agent's final answer carries the manifest json block.
    h.deps.runner.defaultScript = (req) => ({
      timeline: [running(), succeeded()],
      onTerminal: async () => {
        const { uploadAndManifest } = await import('./fakes.js')
        const m = await uploadAndManifest(h.deps.blobs, video.id, req.requestId)
        const r = h.deps.runner.runs.get(req.requestId)
        if (r) r.script.timeline = [succeeded(`All done.\n\n\`\`\`json\n${JSON.stringify(m)}\n\`\`\``)]
      },
    })
    await h.drive(6)
    expect((await h.json(await h.call('GET', `/api/v1/videos/${video.id}`, { as: h.member }))).status).toBe(
      'ready',
    )
  })

  it('never exceeds MAX_ACTIVE_RUNS and drains 20 queued jobs', async () => {
    const h = harness({ MAX_ACTIVE_RUNS: '3' })
    const ids: string[] = []
    for (let i = 0; i < 20; i++)
      ids.push(
        (
          await h.json(
            await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: `${PROMPT} #${i}` } }),
          )
        ).id,
      )
    let maxActive = 0
    for (let i = 0; i < 40; i++) {
      await Promise.all([h.drive(1), h.drive(1)]) // overlapping sweeps
      maxActive = Math.max(maxActive, await h.deps.store.countSlotHolders())
    }
    expect(maxActive).toBeLessThanOrEqual(3)
    const statuses = await Promise.all(ids.map(async (id) => (await h.deps.store.getJob(id))?.status))
    expect(statuses.every((s) => s === 'ready')).toBe(true)
    expect(h.deps.runner.starts.length).toBe(20)
  })

  it('reconciles an ambiguous start instead of starting a duplicate', async () => {
    const h = harness()
    h.deps.runner.loseNextResponse = true
    const video = await h.json(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
    )
    await h.drive(5)
    expect(h.deps.runner.starts.length).toBe(1)
    expect((await h.deps.store.getJob(video.id))?.status).toBe('ready')
    expect(h.deps.logs.some((l) => l.includes('attempt.reconciled'))).toBe(true)
  })

  it('marks an unmatched ambiguous start unresolved, keeps the slot, and lets an admin resolve it', async () => {
    const h = harness()
    h.deps.runner.startError = new RunnerError('ambiguous', 'lost', {
      sentAt: Date.now(),
      failedAt: Date.now(),
    })
    const video = await h.json(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
    )
    await h.drive(8)
    const [a] = await h.attempts(video.id)
    expect(a?.stage).toBe('unresolved')
    expect(await h.deps.store.countSlotHolders()).toBe(1)
    const stats = await h.json(await h.call('GET', '/api/v1/stats', { as: h.admin }))
    expect(stats.unresolved).toHaveLength(1)
    expect((await h.call('POST', `/api/v1/admin/attempts/${a?.id}/resolve`, { as: h.member })).status).toBe(
      403,
    )
    expect((await h.call('POST', `/api/v1/admin/attempts/${a?.id}/resolve`, { as: h.admin })).status).toBe(
      204,
    )
    expect(await h.deps.store.countSlotHolders()).toBe(0)
    expect((await h.deps.store.getJob(video.id))?.status).toBe('failed')
  })

  it('re-queues on platform capacity errors and pauses the queue when credits run out', async () => {
    const h = harness({ MAX_ACTIVE_RUNS: '1' })
    h.deps.runner.startError = new RunnerError('capacity', 'busy')
    const v1 = await h.json(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
    )
    await h.drive(1)
    expect((await h.attempts(v1.id))[0]?.stage).toBe('queued')
    await h.drive(4)
    expect((await h.deps.store.getJob(v1.id))?.status).toBe('ready')

    h.deps.runner.startError = new RunnerError('credits', 'no credits')
    const v2 = await h.json(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
    )
    const v3 = await h.json(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
    )
    await h.drive(3)
    expect((await h.attempts(v2.id))[0]?.errorCategory).toBe('credits_unavailable')
    expect((await h.attempts(v3.id))[0]?.stage).toBe('queued')
    const stats = await h.json(await h.call('GET', '/api/v1/stats', { as: h.admin }))
    expect(stats.queuePausedReason).toMatch(/credits/)
    expect((await h.call('POST', '/api/v1/admin/queue/resume', { as: h.admin })).status).toBe(204)
    await h.drive(4)
    expect((await h.deps.store.getJob(v3.id))?.status).toBe('ready')
  })

  it('fails fast when the agent asks a question (await_input)', async () => {
    const h = harness()
    h.deps.runner.nextScripts.push({ timeline: [running(), running('await_input', 'Asked: which color?')] })
    const video = await h.json(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
    )
    await h.drive(5)
    const [a] = await h.attempts(video.id)
    expect(a?.stage).toBe('failed')
    expect(a?.errorCategory).toBe('needs_input')
    expect(h.deps.runner.stopCalls).toBeGreaterThan(0)
  })

  it('stops a run past the authoring deadline as timed_out', async () => {
    const h = harness({ AUTHORING_DEADLINE_MIN: '3' })
    h.deps.runner.nextScripts.push({ timeline: [running()] })
    const video = await h.json(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
    )
    await h.drive(8)
    expect((await h.attempts(video.id))[0]?.stage).toBe('timed_out')
  })

  it('cancels a queued version locally and a running one through the runner', async () => {
    const h = harness({ MAX_ACTIVE_RUNS: '1' })
    h.deps.runner.nextScripts.push({ timeline: [running()] })
    const a = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
    const b = await h.json(await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }))
    await h.drive(2)
    const qb = await h.call('POST', `/api/v1/videos/${b.id}/versions/1/cancel`, { as: h.member })
    expect((await h.json(qb)).status).toBe('cancelled')
    expect(
      (await h.call('POST', `/api/v1/videos/${a.id}/versions/1/cancel`, { as: h.outsider })).status,
    ).toBe(403)
    expect((await h.call('POST', `/api/v1/videos/${a.id}/versions/1/cancel`, { as: h.member })).status).toBe(
      202,
    )
    await h.drive(3)
    expect((await h.deps.store.getJob(a.id))?.status).toBe('cancelled')
    expect(await h.deps.store.countSlotHolders()).toBe(0)
  })

  it('records runner failures and allows Try again', async () => {
    const h = harness()
    h.deps.runner.nextScripts.push({ timeline: [running(), failedSnap()] })
    const video = await h.json(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
    )
    await h.drive(4)
    const failed = await h.json(await h.call('GET', `/api/v1/videos/${video.id}`, { as: h.member }))
    expect(failed.versions[0]).toMatchObject({ status: 'failed', error: { category: 'runner_failed' } })
    expect(
      (await h.call('POST', `/api/v1/videos/${video.id}/versions/1/retry`, { as: h.admin })).status,
    ).toBe(202)
    await h.drive(4)
    const ok = await h.json(await h.call('GET', `/api/v1/videos/${video.id}`, { as: h.member }))
    expect(ok.versions[0]).toMatchObject({ status: 'ready', attempts: 2 })
  })

  it('rejects outputs whose hash does not match the authenticated manifest', async () => {
    const h = harness({ FINALIZE_DEADLINE_MIN: '2' })
    const video = await h.json(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
    )
    h.deps.runner.defaultScript = ((orig) => (req) => {
      const s = orig(req)
      const inner = s.onTerminal
      return {
        ...s,
        onTerminal: async () => {
          await inner?.(req)
          await h.deps.blobs.set(
            'uploads',
            `${req.requestId}/video.mp4`,
            new TextEncoder().encode('tampered'),
          )
        },
      }
    })(h.deps.runner.defaultScript)
    await h.drive(8)
    const [a] = await h.attempts(video.id)
    expect(a?.stage).toBe('failed')
    expect(a?.errorCategory).toBe('artifacts_missing')
  })

  it('rejects a video with the wrong dimensions', async () => {
    const h = harness()
    const video = await h.json(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT, aspect: '9:16' } }),
    )
    h.deps.runner.defaultScript = ((orig) => (req) => {
      const s = orig(req)
      return {
        ...s,
        onTerminal: async () => {
          const { fixtureFiles, uploadAndManifest } = await import('./fakes.js')
          const { receiveCallback } = await import('../src/domain/callback.js')
          const m = await uploadAndManifest(h.deps.blobs, video.id, req.requestId, fixtureFiles('16:9'))
          await receiveCallback(h.deps, req.requestId, /--token (\S+)/.exec(req.prompt)?.[1] ?? null, m)
        },
      }
    })(h.deps.runner.defaultScript)
    await h.drive(4)
    const [a] = await h.attempts(video.id)
    expect(a?.errorCategory).toBe('invalid_output')
    expect(a?.errorMessage).toMatch(/1080x1920/)
  })

  it('delivers a signed webhook for API-key videos', async () => {
    const h = harness()
    const key = await h.json(await h.call('POST', '/api/v1/keys', { as: h.member, body: { name: 'ci' } }))
    const res = await h.call('POST', '/api/v1/videos', {
      key: key.key,
      origin: null,
      body: { prompt: PROMPT, webhookUrl: 'https://hooks.example.com/v' },
    })
    expect(res.status).toBe(202)
    await h.drive(4)
    const { deliverWebhooks } = await import('../src/domain/webhooks.js')
    await deliverWebhooks(h.deps, { deadline: Date.now() + 5000, maxItems: 10 })
    const call = h.deps.http.calls[0]
    expect(call?.url).toBe('https://hooks.example.com/v')
    const body = JSON.parse(call?.body ?? '{}')
    expect(body.event).toBe('video.ready')
    const t = Number(/t=(\d+)/.exec(call?.headers['x-video-agent-signature'] ?? '')?.[1])
    expect(call?.headers['x-video-agent-signature']).toBe(
      webhookSignature(key.webhookSecret, call?.body ?? '', t),
    )
    // Browser sessions can't register webhooks.
    expect(
      (
        await h.call('POST', '/api/v1/videos', {
          as: h.member,
          body: { prompt: PROMPT, webhookUrl: 'https://x.example.com' },
        })
      ).status,
    ).toBe(400)
  })

  it('a late callback after cancellation is refused with 410', async () => {
    const h = harness()
    h.deps.runner.nextScripts.push({ timeline: [running()] })
    const video = await h.json(
      await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
    )
    await h.drive(2)
    await h.call('POST', `/api/v1/videos/${video.id}/versions/1/cancel`, { as: h.member })
    const [a] = await h.attempts(video.id)
    const token = /--token (\S+)/.exec(h.deps.runner.starts[0]?.prompt ?? '')?.[1]
    const res = await h.call('POST', `/api/internal/runs/${a?.id}/done`, {
      origin: null,
      headers: { authorization: `Bearer ${token}` },
      body: { attemptId: a?.id },
    })
    expect(res.status).toBe(410)
  })
})
