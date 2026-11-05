// recording.ts compose (screen-recording plan §5.2 compose; va-rsk5.3.6): a complete demo composition from a plan with
// no agent: a brand intro, one recording scene per step (emit), a brand outro, captions. It's what makes the planner's
// golden tests, D6 and gate 2 free (render locally), and the engine of the API-only Quick demo.
// - Callouts: "Click <b>{focus.name}</b>" from the full plan's clicked element, or "Step N" without one. A name is
//   page text from the recorded app, so it's escaped and goes only into the callout's text.
// - Framing: the Look's recording.frame (browser renders as wallpaper until phase 5), else the plan's.
// - Intro and outro are neutral brand cards (--va-color-* roles, the brand's primary colour as the accent): looks
//   don't ship stock intro and outro beats yet.
// Writes index.html, summary.json and the kept plan (no names); the result is checked against the contract.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { validate, type Summary } from '../../src/lib/contract.js'
import { fmt } from '../../src/lib/contract-core.js'
import { keptPlan, type PlanV1 } from '../../src/lib/recording.js'
import type { Trace } from '../../src/lib/recording-trace.js'
import type { Analysis } from './recording-analyze.js'
import { emitStep } from './recording-emit.js'
import type { LookRecording } from './recording-plan.js'
import { stableJson } from './recording-plan.js'
import { log, StepError } from './run-tools.js'

const CARD_S = 3
const SIZES = {
  '16:9': [1920, 1080],
  '9:16': [1080, 1920],
  '1:1': [1080, 1080],
  '4:5': [1080, 1350],
} as const

export interface ComposeOptions {
  videoDir: string
  /** The full plan (with focus names, from .va-run). */
  plan: PlanV1
  analysis: Analysis
  trace: Trace | null
  look?: LookRecording | null
  title?: string | undefined
  brand?: { name?: string | undefined; primaryColor?: string | undefined } | null
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function composeDemo(o: ComposeOptions) {
  const started = Date.now()
  if (!o.plan.steps.length) throw new StepError('The plan has no steps to compose.')
  const look = o.look === false || !o.look ? null : o.look
  const frameStyle = look ? (look.frame === 'none' ? 'none' : 'wallpaper') : o.plan.frameStyle
  const plan: PlanV1 = { ...o.plan, frameStyle }
  const [width, height] = SIZES[plan.aspect]
  const accent = /^#[0-9a-f]{6}$/i.test(o.brand?.primaryColor ?? '')
    ? (o.brand?.primaryColor as string)
    : '#14b8a6'
  const brandName = esc((o.brand?.name ?? '').trim().slice(0, 60) || 'Product demo')
  const rawTitle = (o.title ?? '').trim().slice(0, 80) || 'See how it works'
  const title = esc(rawTitle)

  const captions: NonNullable<Summary['captions']> = []
  const sections: string[] = []
  let t = 0
  const caption = (beat: string, textId: string, text: string, start: number, end: number) =>
    captions.push({ start: t + start, end: t + end, text, beat, textId, beatStart: start, beatEnd: end })

  sections.push(`<section id="intro" class="clip beat" data-va-beat="intro" data-va-label="Intro" data-composition-id="intro" data-start="0" data-duration="${fmt(CARD_S)}" data-va-authored-duration="${fmt(CARD_S)}" data-track-index="0">
  <div>
    <div class="kicker" data-va-text="intro-kicker">${brandName}</div>
    <h1 class="title" data-va-text="intro-title">${title}</h1>
  </div>
  <script>
    vaBeat('intro', (tl, el) => {
      // The title is on screen from the first frame (the thumbnail); the kicker settles in above it.
      tl.fromTo(el.querySelector('[data-va-text="intro-kicker"]'), { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.5, ease: 'power3.out' }, 0.1)
        .fromTo(el.querySelector('[data-va-text="intro-title"]'), { scale: 0.98 }, { scale: 1, duration: 0.8, ease: 'power3.out' }, 0)
    })
  </script>
</section>`)
  caption('intro', 'intro-title', rawTitle, 0, CARD_S)
  t += CARD_S

  plan.steps.forEach((step, i) => {
    const name = step.focus?.name.trim()
    const r = emitStep({
      videoDir: o.videoDir,
      plan,
      step: step.id,
      analysis: o.analysis,
      trace: o.trace,
      label: `Step ${String(i + 1)}`,
      start: t,
    })
    const text = name ? `Click <b>${esc(name)}</b>` : `Step ${String(i + 1)}`
    sections.push(r.markup.replace('>Describe this step</p>', `>${text}</p>`))
    caption(step.id, `${step.id}-callout`, name ? `Click ${name}` : `Step ${String(i + 1)}`, 0.6, r.duration)
    t += r.duration
  })

  sections.push(`<section id="outro" class="clip beat" data-va-beat="outro" data-va-label="Outro" data-composition-id="outro" data-start="${fmt(t)}" data-duration="${fmt(CARD_S)}" data-va-authored-duration="${fmt(CARD_S)}" data-track-index="0">
  <div>
    <h2 class="title" data-va-text="outro-cta">Try it yourself</h2>
    <p class="sub" data-va-text="outro-brand">${brandName}</p>
  </div>
  <script>
    vaBeat('outro', (tl, el) => {
      tl.fromTo(el.querySelector('[data-va-text="outro-cta"]'), { opacity: 0, scale: 0.96 }, { opacity: 1, scale: 1, duration: 0.6, ease: 'power3.out' }, 0.2)
        .fromTo(el.querySelector('[data-va-text="outro-brand"]'), { opacity: 0 }, { opacity: 1, duration: 0.3 }, 0.3)
    })
  </script>
</section>`)
  caption('outro', 'outro-cta', 'Try it yourself', 0.2, CARD_S)
  t += CARD_S

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${String(width)}, height=${String(height)}" />
    <script src="vendor/gsap.min.js"></script>
    <script src="vendor/va-contract.js"></script>
    <script src="vendor/va-recording.js"></script>
    <style>
      /* A demo composed from a screen recording with no agent (scripts/recording.ts compose). */
      #root {
        --va-color-bg: #0b0d10;
        --va-color-text: #f4f5f7;
        --va-color-muted: #9aa3ad;
        --va-color-accent: ${accent};
        --font-display: 'Inter', system-ui, sans-serif;
      }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${String(width)}px; height: ${String(height)}px; overflow: hidden; background: #0b0d10; }
      #root { width: 100%; height: 100%; position: relative; font-family: var(--font-display); background: var(--va-color-bg); }
      .clip { position: absolute; inset: 0; }
      .beat { display: grid; place-items: center; text-align: center; }
      .kicker { color: var(--va-color-accent); font-size: 28px; letter-spacing: 0.18em; text-transform: uppercase; font-weight: 600; }
      .title { color: var(--va-color-text); font-size: 88px; font-weight: 700; letter-spacing: -0.03em; margin-top: 16px; }
      .sub { color: var(--va-color-muted); font-size: 36px; margin-top: 20px; }
      .va-callout { position: absolute; left: 50%; bottom: 4%; transform: translateX(-50%); z-index: 5; padding: 14px 28px; border-radius: 999px; background: var(--va-color-bg); color: var(--va-color-text); font-size: 34px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35); white-space: nowrap; }
      .va-callout b { color: var(--va-color-accent); }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-va-contract="1" data-start="0" data-duration="${fmt(t)}" data-width="${String(width)}" data-height="${String(height)}">
${sections.join('\n')}
    </div>
    <script>
      window.__timelines['main'] = gsap.timeline({ paused: true })
    </script>
  </body>
</html>
`
  const summary: Summary = {
    title: rawTitle,
    summary: `A demo composed from a screen recording: ${String(plan.steps.length)} ${plan.steps.length === 1 ? 'step' : 'steps'}.`,
    captions,
  }
  const violations = validate(html, summary)
  if (violations.length) throw new StepError(`The composed demo breaks the contract: ${violations.join(' ')}`)
  writeFileSync(join(o.videoDir, 'index.html'), html)
  writeFileSync(join(o.videoDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  mkdirSync(join(o.videoDir, 'assets', 'recording'), { recursive: true })
  writeFileSync(join(o.videoDir, 'assets', 'recording', 'plan.json'), stableJson(keptPlan(plan)))
  log('recording.compose', {
    steps: plan.steps.length,
    seconds: t,
    frame: frameStyle,
    aspect: plan.aspect,
    named: plan.steps.filter((s) => s.focus).length,
    ms: Date.now() - started,
  })
  return { html, summary, seconds: t }
}
