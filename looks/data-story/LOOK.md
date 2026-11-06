# Data story

## In one line

Numbers carry the story: a big counter that runs up, charts that build bar by bar, and one short annotation per chart
that says why the number matters.

## Layout

- 16:9: the number or chart takes columns 1–8 of a 12-column grid (6 % margins); the headline and annotation sit in
  9–12, top-aligned with the chart. 9:16, 1:1 and 4:5: headline on top, chart below it at full width, annotation
  under the chart; 9:16 keeps the bottom 15 % clear.
- Charts: bars on a baseline with 3–4 faint gridlines, category labels under each bar, values above the bars that
  matter (not all of them). No 3D, no pies with more than 3 slices, no legends when labels can sit on the data.
- One chart or one big number per scene. Text scenes between charts are short (a headline only).

## Type

- Big numbers: the brand's sans (else `system-ui, sans-serif`), 26–32 % of the short side, weight 700, tabular
  figures (`font-variant-numeric: tabular-nums`), tracking -0.03em.
- Headlines: 6–7 % of the short side, weight 600, line height 1.1. Labels and values: 2.4–2.8 %, weight 500, tabular
  figures. Annotations: 3 %, weight 400, in `text`.
- Never below 24 px. Numbers are written with thousands separators and units ("4,812 pages", "+38 %").

## Colour use

- `bg` behind everything; `text` for headlines and numbers; `muted` for labels and axes; `accent` for the bar or
  number the scene is about (one per chart); every other bar in `chart-2`.
- Derived roles, written as literal colours: `chart-2` is `text` mixed 75 % toward `bg`; `grid` is `text` mixed 88 %
  toward `bg`. Compute them; never use `color-mix(…)` or `var(…)` for them.

## Motion

- Counters run up from 0 over 1.2–1.6 s with `power2.out`, updating the number's text each frame (deterministic: the
  value is a function of the timeline's time). They land on the exact figure the request gives.
- Bars grow from the baseline (scaleY 0 → 1, transform origin bottom), 0.5 s each, `power3.out`, staggered 0.12 s in
  reading order; values fade in as each bar lands. The accent bar lands last.
- The annotation draws a short leader line to its bar (scaleX 0 → 1, 0.4 s), then its text fades in.

## Transitions

- Hard cuts between scenes, or a 0.4 s slide up of the outgoing scene when the next one continues the same chart.

## Texture and effects

- None. Flat colour, hairline gridlines in `grid`. No gradients, glow or shadows on data.

## Pacing

- Chart scenes 4–6 s (the build plus at least 1.5 s of hold); counter scenes 2.5–3.5 s. 15 s: 3–4 scenes. 30 s: 6–7.
  The end card holds 2.5 s.

## Captions and text cues

- One caption cue per scene: the headline, then the key number with its unit, then the annotation.

## Sound

- Music: steady minimal electronic, 100–110 bpm. Effects (only with sound effects on): a soft tick as each bar lands.

## Do / Don't

- Do: use the request's real numbers exactly; round only for display when the request does; label units; start
  axes at zero.
- Don't: invent data, truncate axes, animate more than one chart at a time, or put more than 8 bars in a chart.

## Building blocks

- Counter (written for this look; the text element keeps its final value in the HTML for the editor):
  ```js
  vaBeat('hook', (tl, el) => {
    const n = el.querySelector('[data-va-text="hook-number"]')
    const target = Number(n.textContent.replace(/[^0-9]/g, ''))
    const fmt = (v) => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    const c = { v: 0 }
    tl.to(c, { v: target, duration: 1.4, ease: 'power2.out', onUpdate: () => { n.textContent = fmt(c.v) } }, 0.2)
  })
  ```
- Bar build: `tl.fromTo(bars, { scaleY: 0 }, { scaleY: 1, duration: 0.5, ease: 'power3.out', stagger: 0.12, transformOrigin: '50% 100%' }, 0.3)`.
- Create elements with `el.ownerDocument.createElement`: the contract refuses `document.` in a scene script.
