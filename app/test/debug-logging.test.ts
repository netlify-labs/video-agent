// DEBUG_LEVEL=verbose: requests, prompts, planner calls, MCP calls and the run's prompt go to the logs (secrets
// redacted); without it, none of those debug lines are written.
import { describe, expect, it } from 'vitest'
import { clip, createLogger, verboseFromEnv } from '../server/lib/log.js'
import { apiKey, harness, mcpCall, PROMPT, type Harness, runToken } from './helpers.js'

const lines = (h: Harness) => h.deps.logs.map((l) => JSON.parse(l) as Record<string, unknown>)
const debug = (h: Harness, event: string) => lines(h).filter((l) => l.level === 'debug' && l.event === event)

describe('debug logging', () => {
  it('reads DEBUG_LEVEL, writes debug lines only when verbose, and clips long text', () => {
    expect(verboseFromEnv({ DEBUG_LEVEL: 'verbose' })).toBe(true)
    expect(verboseFromEnv({ DEBUG_LEVEL: 'DEBUG' })).toBe(true)
    expect(verboseFromEnv({ DEBUG_LEVEL: 'info' })).toBe(false)
    expect(verboseFromEnv({})).toBe(false)
    const out: string[] = []
    createLogger({}, (l) => out.push(l)).debug('quiet')
    const loud = createLogger({}, (l) => out.push(l), { verbose: true })
    loud.child({ a: 1 }).debug('loud', { token: 'nva_abc' })
    expect(out).toHaveLength(1)
    expect(JSON.parse(out[0] ?? '{}')).toMatchObject({
      level: 'debug',
      event: 'loud',
      a: 1,
      token: '[redacted]',
    })
    expect(clip('x'.repeat(10), 4)).toBe('xxxx… [6 more characters]')
  })

  it('is silent by default', async () => {
    const h = harness()
    await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT } })
    await h.drive(1)
    expect(lines(h).some((l) => l.level === 'debug')).toBe(false)
  })

  it('verbose: logs requests, the prompt, the run prompt without its callback token, and MCP calls', async () => {
    const h = harness({ DEBUG_LEVEL: 'verbose' })
    await h.call('POST', '/api/v1/videos', { as: h.member, body: { prompt: PROMPT, title: 'Webhooks' } })
    const req = debug(h, 'http.request').find((l) => l.path === '/api/v1/videos')
    expect(req).toMatchObject({ method: 'POST', status: 202, caller: 'user', userId: 'u_member' })
    expect(debug(h, 'video.create_requested')[0]).toMatchObject({ prompt: PROMPT, title: 'Webhooks' })

    await h.drive(1)
    const start = debug(h, 'run.start_request')[0]
    const sent = h.deps.runner.starts.at(-1)?.prompt ?? ''
    expect(String(start?.prompt)).toContain(PROMPT)
    // The prompt carries no callback token (the run manifest does), so neither copy holds it.
    const token = await runToken(h.deps, h.deps.runner.starts.at(-1)?.requestId ?? '')
    expect(token.length).toBeGreaterThan(16)
    expect(sent).not.toContain(token)
    expect(String(start?.prompt)).not.toContain(token)

    const key = await apiKey(h, h.member, 'claude')
    await mcpCall(h, key, 'tools/call', { name: 'list_videos', arguments: { query: 'webhooks' } })
    expect(debug(h, 'mcp.call').at(-1)).toMatchObject({
      calls: [{ method: 'tools/call', tool: 'list_videos', arguments: '{"query":"webhooks"}' }],
      status: 200,
      isError: false,
    })
    expect(JSON.stringify(lines(h))).not.toContain(key)
  })
})
