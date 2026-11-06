// The latestStep leak (found on LT-2): the Agent Runner reports the agent's last shell command as the run's step, and
// render-job's command line carries the attempt's callback --token. A run whose step and failure message hold a token
// is checked through every way run text reaches people: the stored attempt row, the video DTO (API, video page, SDK,
// GitHub Action), progress, MCP get_video, a checkpoint's note and a webhook delivery. None may hold the token; a
// row stored before the redaction is redacted on the way out too.
import { randomBytes, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getSettings } from '../src/domain/settings.js'
import { deliverWebhooks } from '../src/domain/webhooks.js'
import { encrypt } from '../src/lib/crypto.js'
import { running, type RunScript } from './fakes.js'
import { apiKey, harness, mcpCall, PROMPT, runToken, type Harness } from './helpers.js'

// A token like the callback's (base64url, 43 characters), made fresh so no secret-shaped literal is in the repo.
const TOKEN = randomBytes(32).toString('base64url')
const attempt = randomUUID()
const RENDER_STEP = `Run command \`cd /opt/build/repo && npx tsx scripts/render-job.ts --job vid_x --attempt ${attempt} --callback https://site.example/api/internal/runs/${attempt}/done --token ${TOKEN} --upload blobs > /tmp/r.log 2>&1; echo exit=$?\``
const CURL_STEP = `Run command \`curl -sS -H "Authorization: Bearer ${TOKEN}" "https://api.example.com/v1/x?sig=${TOKEN}&a=1"\``

async function video(h: Harness, steps: string[], failure?: string) {
  const script: RunScript = {
    timeline: [
      ...steps.map((s) => running('running', s)),
      ...(failure
        ? [
            {
              kind: 'terminal' as const,
              status: 'failed' as const,
              resultText: null,
              usage: { totalCreditsCost: 5 },
              failure: { category: 'terminal' as const, code: 'error', message: failure },
            },
          ]
        : []),
    ],
  }
  h.deps.runner.nextScripts.push(script)
  const v = await h.json<{ id: string }>(
    await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } }),
  )
  return v.id
}

/** Every client-facing text for the video, as one string to search. */
async function outputs(h: Harness, id: string, key: string) {
  const dto = await (await h.call('GET', `/api/v1/videos/${id}`, { as: h.member })).text()
  const progress = await (await h.call('GET', `/api/v1/videos/${id}/progress`, { as: h.member })).text()
  const mcp = JSON.stringify(
    await mcpCall(h, key, 'tools/call', { name: 'get_video', arguments: { video_id: id } }),
  )
  return { dto, progress, mcp }
}

describe('run text never carries secrets to people', () => {
  it("render-job's command becomes a label: the row, the DTO, progress and MCP", async () => {
    const h = harness()
    const key = await apiKey(h, h.member)
    const id = await video(h, [RENDER_STEP])
    await h.drive(3)
    const a = (await h.deps.store.listAttempts(id))[0]
    console.log(JSON.stringify({ test: 'run-text-leak', case: 'render-job', stored: a?.latestStep }))
    expect(a?.latestStep).toBe('Rendering the video and uploading it')
    const out = await outputs(h, id, key)
    for (const [where, text] of Object.entries(out)) expect(text, where).not.toContain(TOKEN)
    expect(out.dto).toContain('Rendering the video and uploading it')
  })

  it('any other command keeps its words with the secrets hidden', async () => {
    const h = harness()
    const key = await apiKey(h, h.member)
    const id = await video(h, [CURL_STEP])
    await h.drive(3)
    const stored = (await h.deps.store.listAttempts(id))[0]?.latestStep ?? ''
    console.log(JSON.stringify({ test: 'run-text-leak', case: 'curl', stored }))
    expect(stored).toContain('curl')
    expect(stored).toContain('[hidden]')
    expect(stored).not.toContain(TOKEN)
    for (const [where, text] of Object.entries(await outputs(h, id, key)))
      expect(text, where).not.toContain(TOKEN)
  })

  it('a row stored before the redaction is redacted on the way out', async () => {
    const h = harness()
    const key = await apiKey(h, h.member)
    const id = await video(h, ['Writing the composition'])
    await h.drive(3)
    const a = (await h.deps.store.listAttempts(id))[0]
    if (!a) throw new Error('no attempt')
    await h.deps.store.updateAttempt(a.id, { latestStep: RENDER_STEP })
    for (const [where, text] of Object.entries(await outputs(h, id, key)))
      expect(text, where).not.toContain(TOKEN)
  })

  it("a failure message and a webhook's video carry no token", async () => {
    const h = harness()
    const { dataEncryptionKey } = await getSettings(h.deps)
    await h.deps.store.updateSettings({
      teamWebhookUrl: 'https://team.example.com/hook',
      teamWebhookSecretEnc: encrypt(dataEncryptionKey, 'team-secret'),
    })
    const id = await video(h, [RENDER_STEP], `Command failed: render-job.ts --token ${TOKEN}`)
    await h.drive(5)
    const a = (await h.deps.store.listAttempts(id))[0]
    expect(a?.stage).toBe('failed')
    expect(a?.errorMessage).toContain('--token [hidden]')
    const dto = await (await h.call('GET', `/api/v1/videos/${id}`, { as: h.member })).text()
    expect(dto).not.toContain(TOKEN)
    await deliverWebhooks(h.deps, { deadline: Date.now() + 5000, maxItems: 20 })
    const bodies = h.deps.http.calls.map((c) => c.body).join('\n')
    console.log(
      JSON.stringify({ test: 'run-text-leak', case: 'webhook', deliveries: h.deps.http.calls.length }),
    )
    expect(h.deps.http.calls.length).toBeGreaterThan(0)
    expect(bodies).not.toContain(TOKEN)
  })

  it("a checkpoint's note is redacted when it's stored", async () => {
    const h = harness()
    const id = await video(h, [
      'Writing the composition',
      'Writing the composition',
      'Writing the composition',
    ])
    await h.drive(1)
    const req = h.deps.runner.starts.at(-1)
    const res = await h.call('POST', `/api/internal/runs/${req?.requestId ?? ''}/checkpoint`, {
      origin: null,
      headers: { authorization: `Bearer ${await runToken(h.deps, req?.requestId ?? '')}` },
      body: { seq: 1, message: `Uploading with VIDEO_AGENT_KEY=${TOKEN}` },
    })
    expect(res.status, await res.clone().text()).toBeLessThan(300)
    const progress = await (await h.call('GET', `/api/v1/videos/${id}/progress`, { as: h.member })).text()
    console.log(
      JSON.stringify({ test: 'run-text-leak', case: 'checkpoint', progress: progress.slice(0, 300) }),
    )
    expect(progress).toContain('VIDEO_AGENT_KEY=[hidden]')
    expect(progress).not.toContain(TOKEN)
  })
})
