// Spike S1 (plan v2 §12): AI Gateway latency, tokens and credits for planning calls. Throwaway branch only.
import type { Config } from '@netlify/functions'
import { choice, TypeSafeClient } from '@typesafe-ai/sdk'

const TOKEN = 'c093e6a8a9c66e64bdcc725912aae640'
const PROMPT =
  'A 30-second launch video for our new org-wide webhooks feature: teams subscribe once for every project. Ends on our logo.'
const CONTEXT = `Brand: Netlify. Colors Neutral 800 #181A1C, Teal 200 #32E6E2, Blue 700 #2E51ED. Headlines Figtree Bold, body Instrument Sans.
Voice: plain, confident, developer-first. Recent videos by this person: "Deploy previews for every PR" (9:16, 15s), "Edge functions in 60 seconds" (16:9, 60s).`
const SYSTEM_Q = `You are storyboarding a short marketing or product video. Ask only questions whose answers would change the video.
Checklist: audience, key message, length, call to action, tone, must-include, avoid. Skip anything the request already answers.
Return JSON only: {"questions":[{"id":"q1","question":"...","why":"...","options":[{"id":"a","label":"...","description":"..."}],"multiSelect":false,"allowOther":true}]} with 0-6 questions and 2-4 options each.`
const SYSTEM_B = `Turn the request and the answers into a short brief. Return JSON only:
{"goal":"","audience":"","keyMessage":"","beats":[{"text":"","seconds":0}],"tone":"","callToAction":"","mustInclude":[],"avoid":[]}`

async function claude(model: string, system: string, user: string, maxTokens: number) {
  const t0 = Date.now()
  const res = await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
  })
  const ms = Date.now() - t0
  const body = (await res.json()) as { usage?: unknown; content?: { type?: string; text?: string }[]; error?: unknown }
  const text = body.content?.find((c) => c.type === 'text')?.text ?? ''
  const blocks = body.content?.map((c) => c.type)
  let parsed = false
  try {
    JSON.parse(text.replace(/^\`\`\`json\s*|\`\`\`$/g, ''))
    parsed = true
  } catch {}
  return { model, status: res.status, ms, usage: body.usage, parsed, blocks, sample: text.slice(0, 400), error: body.error }
}

export default async (req: Request) => {
  if (new URL(req.url).searchParams.get('t') !== TOKEN) return new Response('no', { status: 404 })
  const env = {
    anthropic: Boolean(process.env.ANTHROPIC_BASE_URL),
    typesafe: Boolean(process.env.TYPESAFE_BASE_URL),
  }
  const out: Record<string, unknown> = { env }
  const probes: Record<string, unknown> = {}
  for (const [name, req] of [
    ['minimal_string', { state: 'I was charged twice. Please fix this ASAP.', questions: { category: choice('What is this ticket about?', { billing: null, technical: null, other: null }) } }],
    ['readme_object', { state: { document: 'I was charged twice. Please fix this ASAP.' }, questions: { category: choice('What is this ticket about?', { billing: null, technical: null, other: null }) } }],
  ] as const) {
    try {
      const c = new TypeSafeClient()
      const t0 = Date.now()
      const r = await c.systemOne(req as never)
      probes[name] = { ms: Date.now() - t0, answers: r.answers, usage: r.usage, model: r.model }
    } catch (e) {
      const err = e as { message?: string; status?: number; error?: unknown; body?: unknown }
      probes[name] = { error: err.message, status: err.status, body: err.error ?? err.body }
    }
  }
  out.probes = probes
  try {
    const client = new TypeSafeClient()
    const t0 = Date.now()
    const r = await client.systemOne({
      state: { request: PROMPT, context: CONTEXT },
      questions: {
        needsQuestions: choice('Does this video request leave open questions that would change the video?', { yes: null, no: null }),
        template: choice('What kind of video is this?', { launch: null, tutorial: null, social: null, changelog: null, sales: null, other: null }),
        model: choice('How complex is the creative brief?', { simple: null, standard: null, complex: null }),
        aspect: choice('Which shape does the request imply?', { landscape_16_9: null, vertical_9_16: null, square_1_1: null, portrait_4_5: null, unspecified: null }),
      },
    })
    out.router = { ms: Date.now() - t0, model: r.model, answers: r.answers, usage: r.usage }
  } catch (e) {
    const err = e as { message?: string; status?: number; error?: unknown }
    out.router = { error: err.message, status: err.status, body: err.error }
  }
  const user = `<request>${PROMPT}</request>\n<context>${CONTEXT}</context>`
  out.questions = await Promise.all(
    ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5-5'].map((m) => claude(m, SYSTEM_Q, user, 1500)),
  )
  out.brief = await claude(
    'claude-sonnet-5',
    SYSTEM_B,
    user + '\n<answers>audience: developers and platform teams; length: 30s; cta: "Read the docs"; tone: confident</answers>',
    1200,
  )
  return Response.json(out)
}

export const config: Config = { path: '/spike-s1' }
