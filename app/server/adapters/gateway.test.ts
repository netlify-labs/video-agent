// The AI Gateway adapter's messages call: errors keep their status even when the body is empty (live on 11-02 they
// surfaced as "Unexpected end of JSON input", and planning said it didn't finish in time).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGateway } from './gateway.js'

const env = {
  ANTHROPIC_BASE_URL: 'https://gw.example',
  ANTHROPIC_API_KEY: 'k',
  TYPESAFE_BASE_URL: 'https://ts.example',
}
const call = () =>
  createGateway(env).messages(
    { model: 'claude-haiku-4-5', system: 's', user: 'u', maxTokens: 10 },
    {
      signal: AbortSignal.timeout(5000),
    },
  )
const reply = (status: number, body: string) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status }))

describe('gateway messages', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reports the status of an error with an empty body', async () => {
    reply(413, '')
    await expect(call()).rejects.toThrow('AI Gateway returned 413: an empty body')
  })

  it('reports the message of a JSON error, and the text of any other', async () => {
    reply(400, JSON.stringify({ error: { message: 'max_tokens is too large' } }))
    await expect(call()).rejects.toThrow('AI Gateway returned 400: max_tokens is too large')
    vi.restoreAllMocks()
    reply(502, '<html>Bad gateway</html>')
    await expect(call()).rejects.toThrow('AI Gateway returned 502: <html>Bad gateway</html>')
  })

  it('returns the first text block and the usage of a good reply', async () => {
    reply(
      200,
      JSON.stringify({
        model: 'claude-haiku-4-5',
        content: [{ type: 'thinking' }, { type: 'text', text: '{"ok":true}' }],
        usage: { input_tokens: 3, output_tokens: 4 },
      }),
    )
    await expect(call()).resolves.toMatchObject({
      text: '{"ok":true}',
      usage: { inputTokens: 3, outputTokens: 4 },
    })
  })
})
