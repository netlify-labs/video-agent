// WebMCP's shared pieces (va-qago) against a fake document.modelContext: registration and unregistering by abort, the
// annotations each kind of tool gets, input checks with actionable errors, and the person's confirm for consequential
// tools.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pendingConfirm } from './confirm'
import { inputProblems, isToolName, ok, type InputSchema } from './tools'
import { executeTool, registerWebMcpTool, type WebMcpTool } from './useWebMcpTool'

/** A model context like the browser's: tools live until their registration's signal aborts. */
function fakeModelContext() {
  const tools = new Map<string, WebMCP.ModelContextTool>()
  return {
    tools,
    registerTool(tool: WebMCP.ModelContextTool, opts?: WebMCP.ModelContextRegisterToolOptions) {
      if (tools.has(tool.name)) return Promise.reject(new DOMException('Duplicate tool', 'InvalidStateError'))
      tools.set(tool.name, tool)
      opts?.signal?.addEventListener('abort', () => tools.delete(tool.name))
      return Promise.resolve()
    },
    /** What an agent gets back: the browser JSON-serializes the result. */
    async call(name: string, input: unknown) {
      const t = tools.get(name)
      if (!t) throw new Error(`no tool ${name}`)
      return JSON.parse(
        JSON.stringify(await t.execute(input as object, { signal: new AbortController().signal })),
      )
    },
  }
}

const schema: InputSchema = {
  type: 'object',
  properties: {
    prompt: { type: 'string', minLength: 10, maxLength: 40 },
    sound: { type: 'string', enum: ['silent', 'music'] },
    seconds: { type: 'number', minimum: 0, maximum: 30 },
    beats: { type: 'array', items: { type: 'string' }, maxItems: 2 },
    look: { type: ['string', 'null'] },
  },
  required: ['prompt'],
  additionalProperties: false,
}

const read: WebMcpTool<{ q?: string }> = {
  name: 'list_videos',
  title: 'List videos',
  kind: 'read',
  untrusted: true,
  description: 'd',
  input: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false },
  run: ({ q }) => ok({ q: q ?? null }),
}

afterEach(() => {
  pendingConfirm()?.resolve(false)
  vi.restoreAllMocks()
})

describe('names and input checks', () => {
  it('follows the spec name rule', () => {
    expect(isToolName('list_videos')).toBe(true)
    expect(isToolName('video.seek-to_1')).toBe(true)
    expect(isToolName('')).toBe(false)
    expect(isToolName('has space')).toBe(false)
    expect(isToolName('a'.repeat(129))).toBe(false)
  })

  it('names every problem, so an agent can fix them all at once', () => {
    expect(inputProblems(schema, { prompt: 'A launch video' })).toEqual([])
    expect(
      inputProblems(schema, {
        prompt: 'short',
        sound: 'loud',
        seconds: 31,
        beats: ['a', 'b', 'c'],
        extra: 1,
      }),
    ).toEqual([
      'prompt must be at least 10 characters.',
      'sound must be one of "silent", "music".',
      'seconds must be at most 30.',
      'beats must have at most 2 items.',
      "extra isn't an input of this tool; it takes prompt, sound, seconds, beats, look.",
    ])
    expect(inputProblems(schema, {})).toEqual(['prompt is required.'])
    expect(inputProblems(schema, { prompt: 'A launch video', look: null })).toEqual([])
    expect(inputProblems(schema, { prompt: 42 })).toEqual(['prompt must be string, not integer.'])
    expect(inputProblems(schema, [])).toEqual(['The input must be an object.'])
  })
})

describe('registration', () => {
  it('registers with the annotations its kind implies, and unregisters on abort', async () => {
    const mc = fakeModelContext()
    const c = new AbortController()
    await registerWebMcpTool(mc, () => read, c.signal)
    expect(mc.tools.get('list_videos')?.annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: true,
      consequentialHint: false,
    })
    expect(await mc.call('list_videos', { q: 'webhooks' })).toEqual({ ok: true, q: 'webhooks' })
    c.abort()
    expect(mc.tools.has('list_videos')).toBe(false)
  })

  it('execute sees the page as it is now, not as it was at registration', async () => {
    const mc = fakeModelContext()
    let value = 'first'
    const tool = (): WebMcpTool<Record<string, never>> => ({
      ...read,
      input: { type: 'object', properties: {} },
      run: () => ok({ value }),
    })
    await registerWebMcpTool(mc, tool, new AbortController().signal)
    value = 'second'
    expect(await mc.call('list_videos', {})).toEqual({ ok: true, value: 'second' })
  })

  it('a refused registration leaves the page working, with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mc = fakeModelContext()
    await registerWebMcpTool(mc, () => read, new AbortController().signal)
    await registerWebMcpTool(mc, () => read, new AbortController().signal)
    expect(warn).toHaveBeenCalledWith('[webmcp] registerTool failed', 'list_videos', expect.anything())
  })

  it('bad input never reaches the page: the agent gets every problem and how to fix it', async () => {
    const run = vi.fn(() => ok())
    const r = await executeTool(
      { ...read, input: schema, run },
      { prompt: 'x' },
      new AbortController().signal,
    )
    expect(r).toEqual({
      ok: false,
      error: {
        code: 'invalid_input',
        message: 'prompt must be at least 10 characters.',
        fix: 'Fix the input and call the tool again.',
      },
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('a page error comes back as a failure, not an exception', async () => {
    const r = await executeTool(
      {
        ...read,
        run: () => {
          throw new Error('The player is not ready.')
        },
      },
      {},
      new AbortController().signal,
    )
    expect(r).toMatchObject({ ok: false, error: { code: 'failed', message: 'The player is not ready.' } })
  })
})

describe('consequential tools wait for the person', () => {
  const spend = (run: () => ReturnType<typeof ok>): WebMcpTool<{ prompt: string }> => ({
    name: 'create_video',
    title: 'Create a video',
    kind: 'consequential',
    description: 'd',
    input: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
    confirm: ({ prompt }) => ({ title: 'Create a video', body: `Make "${prompt}".`, action: 'Create video' }),
    run,
  })

  it('are marked consequential, never read-only or untrusted', async () => {
    const mc = fakeModelContext()
    await registerWebMcpTool(mc, () => spend(() => ok()), new AbortController().signal)
    expect(mc.tools.get('create_video')?.annotations).toEqual({
      readOnlyHint: false,
      untrustedContentHint: false,
      consequentialHint: true,
    })
  })

  it('run only after the person allows it in the app', async () => {
    const run = vi.fn(() => ok({ id: 'vid_1' }))
    const result = executeTool(spend(run), { prompt: 'Webhooks' }, new AbortController().signal)
    await Promise.resolve()
    expect(pendingConfirm()).toMatchObject({
      title: 'Create a video',
      body: 'Make "Webhooks".',
      action: 'Create video',
    })
    expect(run).not.toHaveBeenCalled()
    pendingConfirm()?.resolve(true)
    expect(await result).toEqual({ ok: true, id: 'vid_1' })
  })

  it('a no, or the agent cancelling, never runs it and says what to do', async () => {
    const run = vi.fn(() => ok())
    const declined = executeTool(spend(run), { prompt: 'Webhooks' }, new AbortController().signal)
    await Promise.resolve()
    pendingConfirm()?.resolve(false)
    expect(await declined).toMatchObject({ ok: false, error: { code: 'declined' } })
    const c = new AbortController()
    const cancelled = executeTool(spend(run), { prompt: 'Webhooks' }, c.signal)
    await Promise.resolve()
    c.abort()
    expect(await cancelled).toMatchObject({ ok: false, error: { code: 'declined' } })
    expect(pendingConfirm()).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  it('a second request while one is open is declined, never stacked', async () => {
    const run = vi.fn(() => ok())
    const first = executeTool(spend(run), { prompt: 'One' }, new AbortController().signal)
    await Promise.resolve()
    expect(await executeTool(spend(run), { prompt: 'Two' }, new AbortController().signal)).toMatchObject({
      ok: false,
      error: { code: 'declined' },
    })
    pendingConfirm()?.resolve(true)
    expect(await first).toEqual({ ok: true })
    expect(run).toHaveBeenCalledTimes(1)
  })
})
