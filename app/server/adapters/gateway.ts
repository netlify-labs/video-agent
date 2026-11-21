// AI Gateway adapter (plan v2 §4, docs/spikes.md S1). Netlify injects TYPESAFE_* and ANTHROPIC_* into Functions.
// The router sees only the request and short titles: the jev router rejects larger states with 4 questions.
import { choice, TypeSafeClient } from '@typesafe-ai/sdk'
import type { GatewayPort, GatewayUsage, RouteAnswers } from '../deps.js'

export function createGateway(env: NodeJS.ProcessEnv = process.env): GatewayPort {
  let ts: TypeSafeClient | null = null
  return {
    available: () => Boolean(env.ANTHROPIC_BASE_URL && env.ANTHROPIC_API_KEY && env.TYPESAFE_BASE_URL),

    async route(input, opts) {
      ts ??= new TypeSafeClient()
      const r = await ts.systemOne(
        {
          state: { request: input.request, recent_titles: input.history.slice(0, 5).join(' | ') },
          questions: {
            needs_questions: choice(
              'Does this video request leave open questions whose answers would change the video?',
              {
                yes: null,
                no: null,
              },
            ),
            template: choice('What kind of video is this?', {
              launch: null,
              tutorial: null,
              social: null,
              changelog: null,
              sales: null,
              other: null,
            }),
            complexity: choice('How complex is the creative brief?', {
              simple: null,
              standard: null,
              complex: null,
            }),
            aspect: choice('Which shape does the request imply?', {
              landscape: null,
              vertical: null,
              square: null,
              portrait: null,
              unspecified: null,
            }),
          },
        },
        { signal: opts.signal, retry: { maxRetries: 1 } },
      )
      const a = r.answers as unknown as Record<keyof RouteAnswers, { choice: string }>
      return {
        answers: {
          needs_questions: a.needs_questions.choice,
          template: a.template.choice,
          complexity: a.complexity.choice,
          aspect: a.aspect.choice,
        } as RouteAnswers,
        model: r.model,
        usage: {
          inputTokens: r.usage.input_tokens ?? 0,
          outputTokens: r.usage.output_tokens ?? 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      }
    },

    async messages(req, opts) {
      const content: unknown[] = [
        ...(req.images ?? []).map((i) => ({
          type: 'image',
          source: { type: 'base64', media_type: i.mime, data: i.base64 },
        })),
        { type: 'text', text: req.user },
      ]
      const res = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
        method: 'POST',
        signal: opts.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY ?? '',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens,
          // The static system prompt is cached between calls.
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content }],
        }),
      })
      // Read as text first: an error can come back with an empty or non-JSON body, and res.json() would hide the
      // status behind "Unexpected end of JSON input".
      const raw = await res.text()
      let body: {
        content?: { type?: string; text?: string }[]
        model?: string
        usage?: Record<string, number>
        stop_reason?: string
        error?: { message?: string }
      } = {}
      try {
        body = raw ? (JSON.parse(raw) as typeof body) : {}
      } catch {
        if (res.ok)
          throw new Error(
            `AI Gateway returned ${res.status} with a body that isn't JSON: ${raw.slice(0, 200)}`,
          )
      }
      if (!res.ok)
        throw new Error(
          `AI Gateway returned ${res.status}: ${body.error?.message ?? (raw.slice(0, 200) || 'an empty body')}`,
        )
      const u = body.usage ?? {}
      const usage: GatewayUsage = {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      }
      // Models with thinking put a thinking block first; the answer is the first text block.
      return {
        text: body.content?.find((c) => c.type === 'text')?.text ?? '',
        model: body.model ?? req.model,
        usage,
        ...(body.stop_reason ? { stopReason: body.stop_reason } : {}),
      }
    },
  }
}
