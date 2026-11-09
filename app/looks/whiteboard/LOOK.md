# Whiteboard

## In one line

Someone explains it on a whiteboard: marker lines that draw themselves, handwritten labels, arrows between ideas and a
sticky note for the key point.

## Layout

- A clean board: `bg` (near white) edge to edge, 6 % margins. Ideas are laid out left to right on 16:9 (at most three
  per scene, joined by arrows) and top to bottom on 9:16, 1:1 and 4:5. 9:16 keeps the bottom 15 % clear.
- Drawings are simple line art: boxes, circles, arrows, underlines, checkmarks. Product UI, when needed, is a framed
  screenshot "taped" to the board (a slight rotation, ±2°, and two tape strips).
- The key point of a scene goes on a sticky note (a square in `note`, rotated ±3°, with a soft shadow).

## Type

- Handwriting: the brand's handwriting font if it has one; otherwise this look's font, Caveat Semibold, loaded with
  `@font-face` from `video/assets/look/fonts/caveat-semibold.woff2` (copy it there from `context/look/assets/fonts/`).
  Headlines 8–10 % of the short side; labels 4–5 %.
- Any typed text (rare: URLs, code) uses the brand's sans at 3 %. Never below 28 px.

## Colour use

- `bg` is the board; marker strokes and handwriting in `text`; `accent` for one marker colour (the arrow or underline
  that matters); `ink-2` for secondary strokes.
- Derived roles, written as literal colours: `note` is `accent` mixed 75 % toward white (the sticky note); `ink-2` is
  `text` mixed 45 % toward `bg`. Never `color-mix(…)` or `var(…)`.

## Motion

- Strokes draw on: SVG paths with `stroke-dasharray` equal to their length and `stroke-dashoffset` animating from that
  length to 0, 0.5–0.9 s, `power1.inOut`, in the order a person would draw them.
- Handwriting fades in left to right with a clip (`clip-path: inset(0 100% 0 0)` → `inset(0 0 0 0)`), 0.4–0.7 s,
  `none` ease, like writing.
- Sticky notes drop in: from 4 % above with a slight rotation change, 0.35 s, `back.out(1.4)`.

## Transitions

- The board wipes: a white panel sweeps across (0.4 s) like an eraser, revealing the next scene. Or a hard cut.

## Texture and effects

- A very faint board texture is optional; no grain on type. Strokes are 0.6–0.8 % of the short side, round caps and
  joins. Shadows only under sticky notes and taped screenshots.

## Pacing

- Scenes 3–5 s (drawing takes time; hold 1 s after the last stroke). 30 s: 6–8 scenes. 60 s: 12–15. End card 2.5 s.

## Captions and text cues

- One caption cue per handwritten line, from when its writing finishes to the scene's end.

## Sound

- Music: light acoustic (ukulele or guitar), 95–105 bpm. Effects (only with sound effects on): a marker squeak on
  long strokes, soft and short.

## Do / Don't

- Do: explain step by step, connect ideas with arrows, put the takeaway on a sticky note, draw checkmarks for done.
- Don't: draw detailed illustrations or faces, use more than two marker colours, or animate strokes faster than 0.4 s.

## Building blocks

- Draw-on stroke (written for this look; the length is measured once, so it's the same on every seek):
  ```js
  vaBeat('step', (tl, el) => {
    const path = el.querySelector('.stroke')
    const len = path.getTotalLength()
    tl.set(path, { opacity: 1 }, 0.2)
      .fromTo(path, { strokeDasharray: len, strokeDashoffset: len }, { strokeDashoffset: 0, duration: 0.7, ease: 'power1.inOut' }, 0.2)
  })
  ```
  Strokes start at `opacity: 0` in the CSS (a round cap would show a dot before the stroke draws); a `tl.set` at the
  draw's start shows them (not `fromTo`'s from-values, which apply at once).
  Give handwritten text a right padding of 0.3em, so the writing clip never cuts a letter's overhang.
- Writing: `tl.fromTo(label, { clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)', duration: 0.5, ease: 'none' }, 0.8)`.
- Create elements with `el.ownerDocument.createElement`: the contract refuses `document.` in a scene script.
