// Spike B2 (redo a scene, docs/plans/2026-11-04-regenerate-beat.md §7): do frozen beats render the same after a
// scoped change? Builds a 4-beat contract-v1 composition with music per aspect ratio, renders it, replaces beat 2 and
// lengthens it by 1.37 s (snapped to whole frames, as the splice does), re-lays the later beats, renders again, and
// compares frames of every beat at matched beat-relative times with ffmpeg's ssim filter. No credits: local renders.
//   npx tsx docs/spikes/b2/b2.ts [--aspects 16:9,9:16,1:1] [--out docs/spikes/out/b2] [--skip-render] [--leak]
// --leak also changes one line of the (supposedly frozen) outro in the child: what a small out-of-scope change scores.
// Prints one JSON line per sampled frame { aspect, beat, frozen, tParent, tChild, ssim } and a summary table.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { sampleFrame, ssim } from '../../../scripts/e2e/lib/ssim.js'
import { FPS, validate } from '../../../app/server/lib/contract.js'

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}
const OUT = resolve(arg('out') ?? 'docs/spikes/out/b2')
const ASPECTS = (arg('aspects') ?? '16:9,9:16,1:1').split(',')
const SKIP_RENDER = process.argv.includes('--skip-render')
const LEAK = process.argv.includes('--leak')
const SIZES: Record<string, [number, number]> = {
  '16:9': [1920, 1080],
  '9:16': [1080, 1920],
  '1:1': [1080, 1080],
}

/** The parent: intro 3 s, features 3.85 s (115.5 frames, authored and never relaid), proof 3 s, outro 3 s. */
const PARENT = { intro: 3, features: 3.85, proof: 3, outro: 3 }
const DELTA = 1.37
const snap = (s: number) => Math.round(s * FPS) / FPS
const sec = (n: number) => String(Math.round(n * 1e6) / 1e6)

interface BeatSpec {
  id: string
  label: string
  duration: number
  body: string
  script: string
}

const frozenBeats = (): Record<string, Omit<BeatSpec, 'duration'>> => ({
  intro: {
    id: 'intro',
    label: 'Opening',
    body: `<div class="stack"><div class="kicker" data-va-text="intro-kicker">Netlify</div>
          <h1 class="title" data-va-text="intro-title">Org webhooks</h1>
          <div class="orb" data-va-label="Orb"></div></div>`,
    script: `tl.fromTo(el.querySelector('.kicker'), { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.6, ease: 'power3.out' }, 0.2)
              .fromTo(el.querySelector('.title'), { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.8, ease: 'power3.out' }, 0.4)
              .to(el.querySelector('.orb'), { rotation: 360, x: 120, duration: 3, ease: 'none' }, 0)`,
  },
  proof: {
    id: 'proof',
    label: 'Proof',
    body: `<div class="stack"><h2 class="title" data-va-text="proof-title">99.99% delivered</h2>
          <div class="bars"><i></i><i></i><i></i><i></i><i></i></div>
          <p class="sub" data-va-text="proof-sub">Retries with backoff, signed payloads</p></div>`,
    script: `tl.from(el.querySelectorAll('.bars i'), { scaleY: 0, transformOrigin: '50% 100%', stagger: 0.12, duration: 0.6 }, 0.1)
              .fromTo(el.querySelector('.title'), { opacity: 0, scale: 0.9 }, { opacity: 1, scale: 1, duration: 0.7 }, 0.3)
              .fromTo(el.querySelector('.sub'), { opacity: 0 }, { opacity: 1, duration: 0.5 }, 0.9)
              .to(el.querySelector('.bars'), { x: 60, duration: 3, ease: 'none' }, 0)`,
  },
  outro: {
    id: 'outro',
    label: 'Call to action',
    body: `<div class="stack"><h2 class="title" data-va-text="outro-cta">Read the docs</h2>
          <p class="sub" data-va-text="outro-url">docs.netlify.com/webhooks</p><div class="orb"></div></div>`,
    script: `tl.fromTo(el.querySelector('.title'), { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.7 }, 0.2)
              .fromTo(el.querySelector('.sub'), { opacity: 0 }, { opacity: 1, duration: 0.5 }, 0.6)
              .to(el.querySelector('.orb'), { rotation: -270, y: -60, duration: 3, ease: 'none' }, 0)`,
  },
})

const parentFeatures: Omit<BeatSpec, 'duration'> = {
  id: 'features',
  label: 'Features',
  body: `<div class="stack"><h2 class="title" data-va-text="features-title">Every event, one subscription</h2>
          <ul class="list"><li data-va-text="features-1">Deploys</li><li data-va-text="features-2">Forms</li><li data-va-text="features-3">Functions</li></ul></div>`,
  script: `tl.fromTo(el.querySelector('.title'), { opacity: 0, x: -60 }, { opacity: 1, x: 0, duration: 0.7 }, 0.1)
              .from(el.querySelectorAll('.list li'), { opacity: 0, y: 20, stagger: 0.25, duration: 0.5 }, 0.6)`,
}

/** The redone scene: new text, colours and animation, as an agent would write it, with its own @scope style. */
const childFeatures: Omit<BeatSpec, 'duration'> = {
  id: 'features',
  label: 'Features',
  body: `<style>
            @scope {
              .card { background: var(--va-color-accent); color: var(--va-color-bg); border-radius: 32px; padding: 64px 80px; }
              .card h2 { font-size: 88px; }
            }
          </style>
          <div class="stack"><div class="card"><h2 data-va-text="features-title">Ship on Friday</h2></div>
          <p class="sub" data-va-text="features-sub">Webhooks for every deploy, form and function</p></div>`,
  script: `tl.fromTo(el.querySelector('.card'), { opacity: 0, x: -400 }, { opacity: 1, x: 0, duration: 0.9, ease: 'power4.out' }, 0.1)
              .fromTo(el.querySelector('.sub'), { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.6 }, 0.8)`,
}

function compose(aspect: string, beats: BeatSpec[]): string {
  const [w, h] = SIZES[aspect] ?? [1920, 1080]
  const total = beats.reduce((t, b) => t + b.duration, 0)
  let t = 0
  const sections = beats.map((b) => {
    const s = `      <section id="${b.id}" class="clip beat" data-va-beat="${b.id}" data-va-label="${b.label}" data-composition-id="${b.id}" data-start="${sec(t)}" data-duration="${sec(b.duration)}" data-va-authored-duration="${sec(b.duration)}" data-track-index="0">
        ${b.body}
        <script>
          vaBeat('${b.id}', (tl, el) => {
            ${b.script}
          })
        </script>
      </section>`
    t += b.duration
    return s
  })
  const small = Math.min(w, h) / 1080
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${w}, height=${h}" />
    <script src="vendor/gsap.min.js"></script>
    <script src="vendor/va-contract.js"></script>
    <style>
      #root { --va-color-bg: #0b0d10; --va-color-text: #f4f5f7; --va-color-muted: #9aa3ad; --va-color-accent: #14b8a6; }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${w}px; height: ${h}px; overflow: hidden; background: #0b0d10; }
      #root { width: 100%; height: 100%; position: relative; font-family: system-ui, sans-serif; background: var(--va-color-bg); }
      #glow { position: absolute; inset: 0; background: radial-gradient(circle at 70% 30%, rgba(20, 184, 166, 0.25), transparent 60%); }
      .beat { position: absolute; inset: 0; display: grid; place-items: center; text-align: center; }
      .stack { display: grid; gap: ${Math.round(24 * small)}px; justify-items: center; }
      .kicker { color: var(--va-color-accent); font-size: ${Math.round(32 * small)}px; letter-spacing: 0.18em; text-transform: uppercase; }
      .title { color: var(--va-color-text); font-size: ${Math.round(104 * small)}px; font-weight: 700; }
      .sub { color: var(--va-color-muted); font-size: ${Math.round(40 * small)}px; }
      .list { list-style: none; color: var(--va-color-text); font-size: ${Math.round(56 * small)}px; display: grid; gap: 12px; }
      .orb { width: ${Math.round(160 * small)}px; height: ${Math.round(160 * small)}px; border-radius: 32px; background: linear-gradient(135deg, #14b8a6, #6366f1); }
      .bars { display: flex; gap: 16px; align-items: flex-end; height: ${Math.round(220 * small)}px; }
      .bars i { display: block; width: ${Math.round(48 * small)}px; background: var(--va-color-accent); }
      .bars i:nth-child(1) { height: 40%; } .bars i:nth-child(2) { height: 65%; } .bars i:nth-child(3) { height: 50%; }
      .bars i:nth-child(4) { height: 85%; } .bars i:nth-child(5) { height: 100%; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-va-contract="1" data-start="0" data-duration="${sec(total)}" data-width="${w}" data-height="${h}">
      <audio id="music" data-va-layer="music" data-va-label="Music" src="assets/music.mp3" data-start="0" data-duration="${sec(total)}" data-track-index="2" data-volume="0.8"></audio>
      <div id="glow" class="clip" data-va-layer="glow" data-start="0" data-duration="${sec(total)}" data-track-index="1"></div>
${sections.join('\n\n')}
    </div>
    <script>
      window.__timelines['main'] = gsap.timeline({ paused: true })
    </script>
  </body>
</html>
`
}

function project(dir: string, html: string) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'vendor'), { recursive: true })
  mkdirSync(join(dir, 'assets'), { recursive: true })
  for (const f of ['gsap.min.js', 'va-contract.js'])
    copyFileSync(join('video/vendor', f), join(dir, 'vendor', f))
  for (const f of ['hyperframes.json', 'package.json', 'meta.json'])
    copyFileSync(join('video', f), join(dir, f))
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=220:duration=30',
    '-c:a',
    'libmp3lame',
    join(dir, 'assets/music.mp3'),
  ])
  writeFileSync(join(dir, 'index.html'), html)
  const problems = validate(html)
  if (problems.length) throw new Error(`${dir}: not contract v1: ${problems.join(' ')}`)
}

function render(dir: string) {
  const out = join(dir, 'out.mp4')
  if (SKIP_RENDER && existsSync(out)) return out
  const started = Date.now()
  execFileSync('npx', ['-y', 'hyperframes', 'render', '--quality', 'standard', '--output', out], {
    cwd: dir,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  console.log(JSON.stringify({ step: 'rendered', dir, ms: Date.now() - started }))
  return out
}

const rows: { aspect: string; beat: string; frozen: boolean; values: number[] }[] = []
for (const aspect of ASPECTS) {
  const frozen = frozenBeats()
  const parentBeats: BeatSpec[] = [
    { ...frozen.intro!, duration: PARENT.intro },
    { ...parentFeatures, duration: PARENT.features },
    { ...frozen.proof!, duration: PARENT.proof },
    { ...frozen.outro!, duration: PARENT.outro },
  ]
  // The splice snaps the scoped beat to whole frames and keeps frozen durations verbatim (plan §4.5).
  const childBeats = parentBeats.map((b) =>
    b.id === 'features'
      ? { ...childFeatures, duration: snap(PARENT.features + DELTA) }
      : LEAK && b.id === 'outro'
        ? { ...b, body: b.body.replace('docs.netlify.com/webhooks', 'docs.netlify.com/hooks') }
        : b,
  )
  const slug = aspect.replace(':', 'x') + (LEAK ? '-leak' : '')
  const pDir = join(OUT, slug, 'parent')
  const cDir = join(OUT, slug, 'child')
  if (!SKIP_RENDER) {
    project(pDir, compose(aspect, parentBeats))
    project(cDir, compose(aspect, childBeats))
  }
  const pMp4 = render(pDir)
  const cMp4 = render(cDir)
  const frames = join(OUT, slug, 'frames')
  mkdirSync(frames, { recursive: true })
  let pStart = 0
  let cStart = 0
  for (const [i, pb] of parentBeats.entries()) {
    const cb = childBeats[i]!
    const values: number[] = []
    // Every 0.5 s inside the beat (beat-relative), both renders at the same moment of the beat.
    for (let t = 0.25; t < Math.min(pb.duration, cb.duration) - 0.05; t += 0.5) {
      const a = join(frames, `${pb.id}-${t.toFixed(2)}-p.png`)
      const b = join(frames, `${pb.id}-${t.toFixed(2)}-c.png`)
      sampleFrame(pMp4, pStart + t, a)
      sampleFrame(cMp4, cStart + t, b)
      const v = ssim(a, b)
      values.push(v)
      console.log(
        JSON.stringify({
          aspect,
          beat: pb.id,
          frozen: pb.id !== 'features',
          tParent: sec(pStart + t),
          tChild: sec(cStart + t),
          ssim: v,
        }),
      )
    }
    rows.push({ aspect, beat: pb.id, frozen: pb.id !== 'features', values })
    pStart += pb.duration
    cStart += cb.duration
  }
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b)
  return s.length ? (s[Math.floor((s.length - 1) / 2)]! + s[Math.ceil((s.length - 1) / 2)]!) / 2 : NaN
}
console.log('\n| Fixture | Aspect | Beat | Frozen | Frames | Min SSIM | Median SSIM |')
console.log('| --- | --- | --- | --- | --- | --- | --- |')
for (const r of rows)
  console.log(
    `| 4 beats + music | ${r.aspect} | ${r.beat} | ${r.frozen ? 'yes' : 'no (redone)'} | ${r.values.length} | ${Math.min(...r.values).toFixed(4)} | ${median(r.values).toFixed(4)} |`,
  )
