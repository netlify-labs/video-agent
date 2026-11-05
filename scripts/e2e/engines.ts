// Live tests for render engines (docs/plans/2026-11-04-render-engines.md §9; bead va-ed2s.2.11). Spends credits, so
// it asks the owner before each gate (owner decision 3, 2026-11-04: nothing is pre-approved) and stops at a ceiling.
//
//   npx tsx scripts/e2e/engines.ts --phase 1 --dry      # checks the env and ffprobe, prints the gates; no network
//   VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… [CREDIT_CEILING=400] npx tsx scripts/e2e/engines.ts --phase 1 [--keep]
//   npx tsx scripts/e2e/engines.ts --selftest           # against a local stand-in for the API; no credits
//
// Before each gate it prints "Run gate <n>: <what>, about <c> credits, ceiling <x>? [y/N]" and reads one line from
// stdin: y or yes runs it, anything else skips it (logged, not a failure). With no answer at all (no TTY and nothing
// piped) it refuses, so CI or an agent can never run a gate unattended. Before any step that spends credits it refuses
// once the credits so far plus that step's projection pass the ceiling (credits_guard). Every video it made is deleted
// at the end unless --keep, also on failure and on Ctrl-C. One JSON line per step on stdout:
// { ts, step, gate, videoId, attempt, ms, credits, renders, ok, detail }, then a summary { gates, totalCredits }.
//
// Modes: --phase 1 (one HyperFrames create and one browser edit rendered unchanged, about 290 credits). --poc,
// --phase 3 and --phase 4 arrive with their beads (POC.1, LT-3, LT-4).
import { spawnSync } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

/** What each spending step is projected to cost (S1, S4), before the API reports the real figure. */
export const PROJECTED = { create: 250, editRender: 40 }

interface Version {
  n: number
  status: string
  mode?: string
  editedFromN?: number | null
  editable?: boolean
  editing?: { engine?: string } | null
  error?: { message?: string } | null
  usage?: { totalCreditsCost?: number } | null
  output?: { durationSec?: number } | null
  links?: { captions?: string }
}
interface Video {
  id: string
  latestVersion: number
  versions: Version[]
}
interface Edit {
  id: string
  rev: number
  composition: {
    duration: number
    beats: { id: string; duration: number; texts: { id: string; text: string }[] }[]
  }
}

export interface Options {
  base: string
  key: string
  phase: string
  ceiling: number
  keep: boolean
  /** One line from the owner, or null when there's nobody to answer. */
  ask: (question: string) => Promise<string | null>
  out: (line: string) => void
  pollMs: number
  waitMinutes: number
}

class GateError extends Error {
  constructor(
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message)
  }
}
class Refused extends Error {}

interface Gate {
  n: number
  what: string
  credits: number
  steps: string[]
  run: (ctx: Ctx) => Promise<void>
}
interface Ctx {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the response type
  call: <T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<{ status: number; json: T; text: string }>
  log: (step: string, f?: Partial<Line>) => void
  spend: (step: string, projected: number) => void
  spent: (credits: number | undefined, projected: number) => void
  made: (videoId: string) => void
  waitVersion: (videoId: string, n: number) => Promise<Version>
}
interface Line {
  gate: number | null
  videoId: string | null
  attempt: number | null
  ms: number | null
  credits: number | null
  renders: unknown
  ok: boolean | null
  detail: unknown
}

function check(ok: boolean, msg: string, detail: Record<string, unknown> = {}): asserts ok {
  if (!ok) throw new GateError(msg, detail)
}

const PHASE_1: Gate[] = [
  {
    n: 1,
    what: 'one HyperFrames create, then a browser edit (text + retime) rendered unchanged',
    credits: PROJECTED.create + PROJECTED.editRender,
    steps: [
      `create a 20 s 16:9 video (≈${PROJECTED.create} credits) and wait until it's ready`,
      "check the version: editing.engine is 'hyperframes', editable (editing contract 1)",
      `open a draft, change a text and retime the first beat, render it unchanged (≈${PROJECTED.editRender} credits)`,
      "check the new version: render_unchanged from v1, editable, the MP4's length matches the draft, the captions carry the new text",
    ],
    async run(ctx) {
      ctx.spend('create', PROJECTED.create)
      const created = await ctx.call<Video>(
        'POST',
        '/api/v1/videos',
        {
          prompt:
            'A 20-second launch video for org webhooks: three beats (what it is, how to turn it on, an end card).',
          aspect: '16:9',
          durationSec: 20,
        },
        { 'idempotency-key': crypto.randomUUID() },
      )
      check(created.status === 202, 'create', { status: created.status, body: created.text.slice(0, 300) })
      const id = created.json.id
      ctx.made(id)
      const v1 = await ctx.waitVersion(id, 1)
      ctx.spent(v1.usage?.totalCreditsCost, PROJECTED.create)
      check(v1.status === 'ready', 'v1 ready', { status: v1.status, error: v1.error })
      check(v1.editing?.engine === 'hyperframes', "v1's engine is hyperframes", {
        editing: v1.editing ?? null,
      })
      check(v1.editable === true, 'v1 is editable (contract 1)')
      ctx.log('v1.checked', { videoId: id, attempt: 1, ok: true, detail: { engine: v1.editing.engine } })

      const opened = await ctx.call<Edit>('POST', `/api/v1/videos/${id}/versions/1/edits`)
      check(opened.status === 201 || opened.status === 200, 'open draft', { status: opened.status })
      const draft = opened.json
      const first = draft.composition.beats[0]
      const text = draft.composition.beats.flatMap((b) => b.texts)[0]
      check(!!first && !!text, 'the draft has a beat and a text', { beats: draft.composition.beats.length })
      const newText = `${text.text.slice(0, 40)} (edited)`
      const ops = [
        { op: 'text', id: text.id, text: newText },
        { op: 'retime', beat: first.id, duration: Math.round((first.duration + 1) * 30) / 30 },
      ]
      const saved = await ctx.call<Edit>('PUT', `/api/v1/edits/${draft.id}`, { rev: draft.rev, ops })
      check(saved.status === 200, 'save the draft', { status: saved.status, body: saved.text.slice(0, 300) })
      ctx.log('draft.saved', {
        videoId: id,
        ok: true,
        detail: { ops: ops.length, duration: saved.json.composition.duration },
      })

      ctx.spend('edit_render', PROJECTED.editRender)
      const rendered = await ctx.call<Video>('POST', `/api/v1/edits/${draft.id}/render`, undefined, {
        'idempotency-key': crypto.randomUUID(),
      })
      check(rendered.status === 202, 'render the draft', { status: rendered.status })
      const n = rendered.json.latestVersion
      const v = await ctx.waitVersion(id, n)
      ctx.spent(v.usage?.totalCreditsCost, PROJECTED.editRender)
      check(v.status === 'ready', 'the edit render is ready', { status: v.status, error: v.error })
      check(v.mode === 'render_unchanged' && v.editedFromN === 1, 'render_unchanged from v1', {
        mode: v.mode,
        editedFromN: v.editedFromN,
      })
      check(v.editable === true, 'the edited version is editable')
      const want = saved.json.composition.duration
      check(Math.abs((v.output?.durationSec ?? 0) - want) <= 0.25, "the MP4's length matches the draft", {
        mp4: v.output?.durationSec,
        draft: want,
      })
      const vtt = v.links?.captions ? await ctx.call<unknown>('GET', v.links.captions) : null
      check(!!vtt && vtt.status === 200 && vtt.text.includes(newText), 'the captions carry the edited text', {
        status: vtt?.status ?? null,
      })
      ctx.log('v.checked', {
        videoId: id,
        attempt: n,
        ok: true,
        detail: { mode: v.mode, mp4: v.output?.durationSec },
      })
    },
  },
]

const GATES: Record<string, Gate[] | string> = {
  '1': PHASE_1,
  poc: 'not built yet: see bead POC.1 (va-ed2s.4.1)',
  '3': 'not built yet: see bead LT-3 (va-ed2s.5.9)',
  '4': 'not built yet: see bead LT-4 (va-ed2s.6.6)',
}

/** Runs the gates for `o.phase`. Returns the exit code. */
export async function runGates(o: Options): Promise<number> {
  const started = Date.now()
  const write = (step: string, f: Partial<Line> = {}) => {
    o.out(
      JSON.stringify({
        ts: new Date().toISOString(),
        step,
        gate: null,
        videoId: null,
        attempt: null,
        ms: Date.now() - started,
        credits: null,
        renders: null,
        ok: null,
        detail: null,
        ...f,
      }),
    )
  }
  const gates = GATES[o.phase]
  if (!gates || typeof gates === 'string') {
    write('mode', {
      ok: false,
      detail: gates ?? `unknown mode ${o.phase}: use --phase 1, --poc, --phase 3 or --phase 4`,
    })
    return 2
  }
  let used = 0
  const made: string[] = []
  const summary: { n: number; ran: boolean; ok: boolean | null; credits: number }[] = []
  let code = 0
  let current: number | null = null
  const call: Ctx['call'] = async (method, path, body, headers = {}) => {
    const res = await fetch(path.startsWith('http') ? path : `${o.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${o.key}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    let json: unknown
    try {
      json = text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : {}
    } catch {
      json = {}
    }
    return { status: res.status, json: json as never, text }
  }
  const ctx: Ctx = {
    call,
    log: (step, f = {}) => {
      write(step, { gate: current, ...f })
    },
    spend: (step, projected) => {
      if (used + projected > o.ceiling) {
        write('credits_guard', {
          gate: current,
          ok: false,
          detail: { step, used, next: projected, ceiling: o.ceiling },
        })
        throw new GateError(`credits_guard: ${step} would pass the ceiling`, {
          used,
          next: projected,
          ceiling: o.ceiling,
        })
      }
    },
    spent: (credits, projected) => {
      // A run that reports no cost counts at its projection, so the ceiling never under-counts.
      used += credits ?? projected
      write('credits', {
        gate: current,
        credits: credits ?? null,
        detail: { used, counted: credits ?? projected },
      })
    },
    made: (videoId) => {
      made.push(videoId)
      write('created', { gate: current, videoId, ok: true })
    },
    waitVersion: async (videoId, n) => {
      const t = Date.now()
      for (let i = 0; Date.now() - t < o.waitMinutes * 60_000; i++) {
        const r = await call<Video>('GET', `/api/v1/videos/${videoId}`)
        const v = r.json.versions.find((x) => x.n === n)
        if (v && ['ready', 'failed', 'timed_out', 'cancelled'].includes(v.status)) {
          write('version.done', {
            gate: current,
            videoId,
            attempt: n,
            ok: v.status === 'ready',
            detail: { status: v.status, polls: i + 1 },
          })
          return v
        }
        await new Promise((r2) => setTimeout(r2, o.pollMs))
      }
      throw new GateError(`version ${n} didn't finish in ${o.waitMinutes} min`, { videoId })
    },
  }
  const cleanup = async () => {
    if (o.keep) {
      if (made.length) write('kept', { detail: { videos: made } })
      return
    }
    for (const id of made.splice(0)) {
      const r = await call('DELETE', `/api/v1/videos/${id}`).catch((e: unknown) => ({
        status: 0,
        text: String(e),
      }))
      write('deleted', {
        videoId: id,
        ok: r.status === 202 || r.status === 404,
        detail: { status: r.status },
      })
    }
  }
  const onSigint = () => {
    write('interrupted', { ok: false })
    void cleanup().finally(() => process.exit(130))
  }
  process.once('SIGINT', onSigint)
  try {
    for (const g of gates) {
      current = g.n
      const answer = await o.ask(
        `Run gate ${g.n}: ${g.what}, about ${g.credits} credits, ceiling ${o.ceiling}? [y/N] `,
      )
      if (answer === null) throw new Refused("needs the owner's answer at each gate")
      if (!/^y(es)?$/i.test(answer.trim())) {
        write('gate.skipped', { gate: g.n, detail: { answer: answer.trim().slice(0, 20) } })
        summary.push({ n: g.n, ran: false, ok: null, credits: 0 })
        continue
      }
      const before = used
      const t = Date.now()
      write('gate.start', { gate: g.n, detail: { what: g.what, projected: g.credits } })
      try {
        await g.run(ctx)
        write('gate.done', { gate: g.n, ok: true, ms: Date.now() - t, credits: used - before })
        summary.push({ n: g.n, ran: true, ok: true, credits: used - before })
      } catch (e) {
        if (!(e instanceof GateError)) throw e
        write('FAIL', { gate: g.n, ok: false, detail: { msg: e.message, ...e.detail } })
        summary.push({ n: g.n, ran: true, ok: false, credits: used - before })
        code = 1
        break
      }
    }
  } catch (e) {
    if (!(e instanceof Refused)) throw e
    write('gate.refused', { gate: current, ok: false, detail: e.message })
    code = 3
  } finally {
    await cleanup()
    process.removeListener('SIGINT', onSigint)
    write('summary', { ok: code === 0, credits: used, detail: { gates: summary, totalCredits: used } })
  }
  return code
}

/** The plan, with no network: env, ffprobe, each gate's steps and credits. 0 when the env is complete, else 2. */
export function dryPlan(
  o: Pick<Options, 'base' | 'key' | 'phase' | 'ceiling'>,
  out: (line: string) => void,
): number {
  const line = (step: string, f: Record<string, unknown>) => {
    out(JSON.stringify({ ts: new Date().toISOString(), step, ...f }))
  }
  const gates = GATES[o.phase]
  if (!gates || typeof gates === 'string') {
    line('mode', { ok: false, detail: gates ?? `unknown mode ${o.phase}` })
    return 2
  }
  const problems = [
    ...(!o.base
      ? ['VIDEO_AGENT_URL is not set']
      : /^https?:\/\/[^/]+/.test(o.base)
        ? []
        : ['VIDEO_AGENT_URL must be an http(s) URL']),
    ...(!o.key
      ? ['VIDEO_AGENT_KEY is not set']
      : o.key.startsWith('nva_')
        ? []
        : ["VIDEO_AGENT_KEY doesn't look like an API key (nva_…)"]),
    ...(spawnSync('ffprobe', ['-version'], { encoding: 'utf8' }).status === 0
      ? []
      : ['ffprobe is not installed']),
    ...(o.ceiling > 0 ? [] : ['CREDIT_CEILING must be a positive number']),
  ]
  line('dry_env', { url: o.base || null, key: o.key ? 'set' : null, ceiling: o.ceiling, problems })
  for (const g of gates) line('dry_gate', { gate: g.n, what: g.what, credits: g.credits, steps: g.steps })
  const projected = gates.reduce((s, g) => s + g.credits, 0)
  line('dry_credits', {
    projected,
    ceiling: o.ceiling,
    note:
      projected > o.ceiling
        ? 'over the ceiling: a step is refused once it would pass it'
        : 'within the ceiling',
  })
  line(problems.length ? 'DRY_INCOMPLETE' : 'DRY_OK', { network: 'none' })
  return problems.length ? 2 : 0
}

/** One line from stdin per gate: the TTY's answer or the next piped line; null once nothing more can answer. */
let stdinLines: AsyncIterator<string> | null = null
async function stdinAsk(question: string): Promise<string | null> {
  process.stderr.write(question)
  stdinLines ??= createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator]()
  const next = await stdinLines.next()
  return next.done ? null : next.value
}

// ───── --selftest: a local stand-in for the API ─────
export interface StandIn {
  base: string
  deleted: string[]
  close: () => Promise<void>
}
/** The routes gate 1 uses. `failAt: 'save'` answers the draft save with a 500; `credits` is each run's reported cost. */
export async function standIn(o: { failAt?: 'save'; credits?: number } = {}): Promise<StandIn> {
  const deleted: string[] = []
  const versions: Version[] = []
  const id = 'vid_selftest'
  const edited = { text: '' }
  const send = (res: ServerResponse, status: number, body?: unknown, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type })
    res.end(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body))
  }
  const read = async (req: IncomingMessage) => {
    let s = ''
    for await (const c of req) s += String(c)
    return s ? (JSON.parse(s) as Record<string, unknown>) : {}
  }
  const server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? ''
      const route = `${req.method ?? ''} ${url}`
      const video = (): Video => ({ id, latestVersion: versions.length, versions: [...versions].reverse() })
      const usage = { totalCreditsCost: o.credits ?? 0 }
      if (route === 'POST /api/v1/videos') {
        versions.push({
          n: 1,
          status: 'ready',
          editable: true,
          editing: { engine: 'hyperframes' },
          usage,
          output: { durationSec: 20 },
          links: { captions: '/files/1.vtt' },
        })
        return send(res, 202, video())
      }
      if (route === `GET /api/v1/videos/${id}`) return send(res, 200, video())
      if (route === `POST /api/v1/videos/${id}/versions/1/edits`)
        return send(res, 201, {
          id: 'edt_1',
          rev: 0,
          composition: {
            duration: 20,
            beats: [{ id: 'intro', duration: 5, texts: [{ id: 'intro-title', text: 'Org webhooks' }] }],
          },
        })
      if (route === 'PUT /api/v1/edits/edt_1') {
        if (o.failAt === 'save') return send(res, 500, { error: { message: 'boom' } })
        const ops = (await read(req)).ops as { op: string; text?: string }[]
        edited.text = ops.find((x) => x.op === 'text')?.text ?? ''
        return send(res, 200, { id: 'edt_1', rev: 1, composition: { duration: 21, beats: [] } })
      }
      if (route === 'POST /api/v1/edits/edt_1/render') {
        versions.push({
          n: 2,
          status: 'ready',
          mode: 'render_unchanged',
          editedFromN: 1,
          editable: true,
          editing: { engine: 'hyperframes' },
          usage,
          output: { durationSec: 21 },
          links: { captions: '/files/2.vtt' },
        })
        return send(res, 202, video())
      }
      if (route === 'GET /files/2.vtt')
        return send(res, 200, `WEBVTT\n\n00:00.000 --> 00:02.000\n${edited.text}\n`, 'text/vtt')
      if (route === `DELETE /api/v1/videos/${id}`) {
        deleted.push(id)
        return send(res, 202)
      }
      send(res, 404, { error: { message: `no stand-in for ${route}` } })
    })()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    base: `http://127.0.0.1:${port}`,
    deleted,
    close: () => new Promise((r) => server.close(() => r())),
  }
}

/** Runs gate 1 against the stand-in with each kind of answer, a low ceiling and a failure. Returns the problems. */
export async function selftest(): Promise<string[]> {
  const problems: string[] = []
  const FIELDS = ['ts', 'step', 'gate', 'videoId', 'attempt', 'ms', 'credits', 'renders', 'ok', 'detail']
  const once = async (
    answer: string | null,
    extra: { ceiling?: number; failAt?: 'save'; credits?: number } = {},
  ) => {
    const api = await standIn({
      ...(extra.failAt ? { failAt: extra.failAt } : {}),
      credits: extra.credits ?? 0,
    })
    const lines: Record<string, unknown>[] = []
    try {
      const code = await runGates({
        base: api.base,
        key: 'nva_selftest',
        phase: '1',
        ceiling: extra.ceiling ?? 400,
        keep: false,
        ask: () => Promise.resolve(answer),
        out: (l) => lines.push(JSON.parse(l) as Record<string, unknown>),
        pollMs: 1,
        waitMinutes: 1,
      })
      for (const l of lines)
        if (!FIELDS.every((f) => f in l)) problems.push(`a line is missing a field: ${JSON.stringify(l)}`)
      return { code, lines, deleted: api.deleted, steps: lines.map((l) => l.step) }
    } finally {
      await api.close()
    }
  }
  const ran = await once('y', { credits: 0 })
  if (ran.code !== 0 || !ran.steps.includes('gate.done') || ran.deleted.length !== 1)
    problems.push(`"y" should run gate 1 and delete its video: ${JSON.stringify(ran.steps)}`)
  const skipped = await once('n')
  if (skipped.code !== 0 || !skipped.steps.includes('gate.skipped') || skipped.steps.includes('created'))
    problems.push(`"n" should skip gate 1: ${JSON.stringify(skipped.steps)}`)
  const refused = await once(null)
  if (refused.code !== 3 || !refused.steps.includes('gate.refused') || refused.steps.includes('created'))
    problems.push(`no answer should refuse: ${JSON.stringify(refused.steps)}`)
  const guarded = await once('y', { ceiling: 270, credits: 250 })
  if (guarded.code !== 1 || !guarded.steps.includes('credits_guard') || guarded.deleted.length !== 1)
    problems.push(
      `a ceiling of 270 after 250 spent should stop the edit render: ${JSON.stringify(guarded.steps)}`,
    )
  const failed = await once('y', { failAt: 'save' })
  if (failed.code !== 1 || !failed.steps.includes('FAIL') || failed.deleted.length !== 1)
    problems.push(`a failure mid-gate should still delete the video: ${JSON.stringify(failed.steps)}`)
  return problems
}

async function main() {
  const argv = process.argv.slice(2)
  const flag = (f: string) => argv.includes(f)
  if (flag('--selftest')) {
    const problems = await selftest()
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        step: problems.length ? 'SELFTEST_FAIL' : 'SELFTEST_OK',
        problems,
      }),
    )
    process.exit(problems.length ? 1 : 0)
  }
  const phase = flag('--poc') ? 'poc' : (argv[argv.indexOf('--phase') + 1] ?? '')
  const env = process.env
  const ceiling = Number(env.CREDIT_CEILING ?? (phase === '1' ? 400 : 800))
  const base = (env.VIDEO_AGENT_URL ?? '').replace(/\/$/, '')
  const key = env.VIDEO_AGENT_KEY ?? ''
  const print = (l: string) => {
    console.log(l)
  }
  if (flag('--dry')) process.exit(dryPlan({ base, key, phase, ceiling }, print))
  if (GATES[phase] && typeof GATES[phase] !== 'string' && (!base || !key))
    throw new Error('Set VIDEO_AGENT_URL and VIDEO_AGENT_KEY (or pass --dry).')
  process.exit(
    await runGates({
      base,
      key,
      phase,
      ceiling,
      keep: flag('--keep'),
      ask: stdinAsk,
      out: print,
      pollMs: 10_000,
      waitMinutes: Number(env.WAIT_MINUTES ?? 30),
    }),
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
