// The GitHub Action's live-test scenarios (bead va-mg4i.2.16), written against a Driver so the same steps run live (a
// sandbox repo through gh, scripts/e2e/github-action.ts) and in-process (--selftest: the action's test harness, no
// credits). Each scenario says how many runs it may start; the runner stops before one that would pass the ceiling.

export interface VideoSummary {
  id: string
  title: string
  versions: {
    n: number
    prompt: string
    usage: { totalCreditsCost?: number } | null
    output: { title: string; summary: string } | null
  }[]
}

export interface Driver {
  readonly name: 'live' | 'selftest'
  /** Opens a PR with this description (and a screenshot when the driver can attach one); returns its number. */
  openPr(o: { title: string; body: string }): Promise<number>
  editPr(n: number, body: string): Promise<void>
  /** Adds the label and waits for the workflow run it starts. */
  label(n: number): Promise<void>
  unlabel(n: number): Promise<void>
  /** Posts a comment and waits for the workflow run it starts. */
  comment(n: number, body: string): Promise<void>
  /** Label and comment at once, then waits for both runs. */
  labelAndComment(n: number, body: string): Promise<void>
  /** Re-runs the last workflow run for this PR (same run id, next attempt). */
  rerun(n: number): Promise<void>
  /** Creates a release and runs the release step with target: release/<tag>. */
  release(tag: string, notes: string): Promise<void>
  /** The action's sticky comment on a PR, or null. */
  sticky(n: number): Promise<string | null>
  releaseBody(tag: string): Promise<string>
  /** The CI account's videos whose prompts carry this reference, oldest first. */
  videosFor(ref: string): Promise<VideoSummary[]>
  /** Library items whose captions start with this text. */
  library(captionPrefix: string): Promise<string[]>
}

export interface Scenario {
  name: string
  /** Runs it may start (each about PER_RUN credits). */
  runs: number
  what: string
  run(d: Driver, ctx: ScenarioContext): Promise<void>
}

export interface ScenarioContext {
  owner: string
  repo: string
  /** PR numbers the scenarios opened, for later steps and cleanup. */
  prs: Record<string, number>
  tag: string
}

export class ScenarioError extends Error {
  constructor(
    message: string,
    readonly fields: Record<string, unknown> = {},
  ) {
    super(message)
  }
}
export function expectThat(ok: unknown, message: string, fields: Record<string, unknown> = {}): asserts ok {
  if (!ok) throw new ScenarioError(message, fields)
}

const ref = (c: ScenarioContext, n: number) => `[va-ref github:${c.owner}/${c.repo}#pr-${n}]`
const SCREEN_LEAK = /va-ref|Tracking reference/

export const PHASE1: Scenario[] = [
  {
    name: 'label',
    runs: 1,
    what: 'open a PR with a description and a screenshot, add the video label → one sticky comment ending Ready with the app link',
    async run(d, c) {
      const n = await d.openPr({
        title: 'Webhooks: retry failed deliveries from the list',
        body: 'Adds a **Retry** button to each failed delivery in the webhook list.\n\nFailed deliveries used to need a support ticket.',
      })
      c.prs.main = n
      await d.label(n)
      const body = await d.sticky(n)
      expectThat(body?.includes('**Ready:**') || body?.includes('**[Watch]'), 'the comment says Ready', {
        body,
      })
      const vids = await d.videosFor(ref(c, n))
      expectThat(vids.length === 1, 'exactly one video for the PR', { count: vids.length })
    },
  },
  {
    name: 'rerun',
    runs: 0,
    what: 're-run the workflow → no second video',
    async run(d, c) {
      const n = c.prs.main as number
      await d.rerun(n)
      expectThat((await d.videosFor(ref(c, n))).length === 1, 'still one video after a re-run')
    },
  },
  {
    name: 'relabel',
    runs: 0,
    what: 'edit the description, remove and re-add the label → the same video (lookup), no 409',
    async run(d, c) {
      const n = c.prs.main as number
      const before = (await d.videosFor(ref(c, n)))[0]?.id
      await d.editPr(n, 'Adds a Retry button to each failed delivery. (edited)')
      await d.unlabel(n)
      await d.label(n)
      const after = await d.videosFor(ref(c, n))
      expectThat(after.length === 1 && after[0]?.id === before, 'the same video after a re-label', {
        before,
        after: after.map((v) => v.id),
      })
    },
  },
  {
    name: 'race',
    runs: 1,
    what: 'a second PR: add the label and post /video within seconds → one video survives (race check; a stopped duplicate may cost a little)',
    async run(d, c) {
      const n = await d.openPr({
        title: 'Org webhooks: one endpoint for every project',
        body: 'Subscribe once for the whole organization.',
      })
      c.prs.race = n
      await d.labelAndComment(n, '/video')
      const vids = await d.videosFor(ref(c, n))
      expectThat(vids.length === 1, 'one video survives the race', { count: vids.length })
    },
  },
  {
    name: 'revise',
    runs: 1,
    what: '/video revise make the end card orange → v2 in the same comment',
    async run(d, c) {
      const n = c.prs.main as number
      await d.comment(n, '/video revise make the end card orange')
      const vids = await d.videosFor(ref(c, n))
      expectThat(vids.length === 1 && vids[0]?.versions.some((v) => v.n === 2), 'v2 of the same video', {
        versions: vids[0]?.versions.map((v) => v.n),
      })
      expectThat((await d.sticky(n))?.includes('"made":2'), 'the same comment counts two versions')
    },
  },
  {
    name: 'cleanup-and-screen',
    runs: 0,
    what: "screenshots are gone from the library; no video's title, summary or captions show the reference line",
    async run(d, c) {
      expectThat(
        (await d.library(`PR #${c.prs.main} screenshot`)).length === 0,
        'the PR screenshots left the library',
      )
      for (const n of Object.values(c.prs))
        for (const v of await d.videosFor(ref(c, n)))
          for (const x of v.versions)
            expectThat(
              !SCREEN_LEAK.test(`${v.title} ${x.output?.title ?? ''} ${x.output?.summary ?? ''}`),
              'the reference line stays off screen',
              { video: v.id, n: x.n },
            )
    },
  },
  {
    name: 'release',
    runs: 1,
    what: 'a release made by a release tool, then the action as the next step with target: release/<tag> → a section in the notes',
    async run(d, c) {
      await d.release(
        c.tag,
        '## What changed\n- Retry failed webhook deliveries\n- One webhook for the whole organization',
      )
      const body = await d.releaseBody(c.tag)
      expectThat(
        body.includes('<!-- video-agent:start -->') && body.includes('<!-- video-agent:end -->'),
        'the release notes have the section',
        { body },
      )
    },
  },
]

export interface RunOptions {
  ceiling: number
  perRun: number
  /** Credits spent so far, read from the videos (at least). */
  spent: () => Promise<number>
  log: (step: string, f?: Record<string, unknown>) => void
}

/** Runs the scenarios in order; stops before one whose runs would pass the ceiling. Returns the scenarios it ran. */
export async function runScenarios(d: Driver, scenarios: Scenario[], ctx: ScenarioContext, o: RunOptions) {
  const done: string[] = []
  for (const s of scenarios) {
    const spent = await o.spent()
    if (s.runs > 0 && spent + s.runs * o.perRun > o.ceiling) {
      o.log('ceiling', {
        scenario: s.name,
        creditsSoFar: spent,
        wouldAdd: s.runs * o.perRun,
        ceiling: o.ceiling,
        outcome: 'stopped',
      })
      break
    }
    const t = Date.now()
    o.log('scenario', { scenario: s.name, what: s.what, creditsSoFar: spent })
    await s.run(d, ctx)
    done.push(s.name)
    o.log('scenario_ok', {
      scenario: s.name,
      ms: Date.now() - t,
      creditsSoFar: await o.spent(),
      outcome: 'ok',
    })
  }
  return done
}

export const projectedRuns = (scenarios: Scenario[]) => scenarios.reduce((n, s) => n + s.runs, 0)
