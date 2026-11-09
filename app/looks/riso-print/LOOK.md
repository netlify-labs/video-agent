# Riso print

## In one line

A poster run through a two-colour stencil printer and then set moving: grainy paper, two inks that darken where
they overlap, halftone dots, heavy type a few pixels off register, and motion that steps instead of glides.

## Layout

- Paper fills the frame. On it: one to three large flat shapes (circles, half circles, squares, thick stripes), each
  20–45 % of the short side, overlapping each other by 10–25 %, and one block of type. Shapes may run off the edge.
- 16:9: type on the left 55 %, shapes weighted right. 9:16, 1:1 and 4:5: shapes above or behind, type stacked below
  centre, 7 % margins; 9:16 keeps the bottom 15 % clear.
- One small label per scene (issue number, date, product name) in monospace in a corner, like a printer's mark.
- This look doesn't frame screen recordings (`recording: false`). A screenshot may appear as a flat "print": inside
  a square or circle, in one ink, under the grain.

## Type

- Headlines: the brand's sans at its heaviest (else `system-ui, sans-serif`, weight 900), 12–14 % of the short side,
  line height 0.95, tracking -0.03em, at most 5 words. The product name on the end card: 28–30 %.
- Words inside shapes: 7–8 %, weight 900. Labels: `"JetBrains Mono", ui-monospace, Menlo, monospace`, 2.8 %,
  uppercase, tracking 0.08em. Never below 28 px.
- Headlines carry a hard offset copy in the second ink: `text-shadow: -7px 6px 0 <accent>` (0.6 % of the short side,
  no blur), written with the literal accent colour.

## Colour use

- Two inks and paper, nothing else. Paper is the lighter of the brand's `bg` and `text`; the first ink is the darker
  one; the second ink is `accent`. In the example these are `bg`, `text` and `accent`.
- Shapes use `mix-blend-mode: multiply`, so overlaps print darker by themselves: no derived roles, no third colour,
  no gradients, no opacity tints. Halftone is the only way to make an ink lighter.
- Type is the first ink on paper or on `accent`; paper-coloured on the first ink.

## Motion

- Everything moves in steps, like frames of a print run: `steps(4)` or `steps(5)`, 0.3–0.4 s. Shapes step in from
  the nearest edge or step up from 0.6 scale; rotation only in jumps of 15°.
- "Register": the offset copy of a headline starts 3× too far out and snaps to its place in three steps (0.25 s).
  Once per scene at most, the shapes jolt 8 px sideways and back in two steps.
- Type inside a shape arrives with its shape. Nothing eases smoothly, fades, blurs or drifts.

## Transitions

- Hard cuts. The incoming scene's first move is its shapes stepping in; once per video the cut may be covered by a
  full-frame `accent` sheet that steps across in 4 steps (0.3 s) at the start of the incoming scene.

## Texture and effects

- Grain over everything: a still noise layer (`feTurbulence`, fixed `seed`, no animation) multiplied over the frame
  at about 0.2 opacity. Halftone: a dot pattern (`radial-gradient` dots on a 16 px grid) filling one shape per scene
  at most. Nothing else: no shadows, glows or paper-fold photos.

## Pacing

- Scenes 2.5–3.5 s. 15 s: 5 scenes. 30 s: 9–11. 60 s: 18–20. The end card holds 2.5 s.

## Captions and text cues

- One caption cue per block of type, from when its shape or line has landed to the end of its scene.

## Sound

- Music: loose lo-fi beat with tape hiss, 90–100 bpm. Effects (only with sound effects on): a dry paper thud as each
  shape lands.

## Do / Don't

- Do: let shapes overlap so the overprint shows; keep one word per shape; use the halftone once per scene; end with
  the product name huge and one shape behind it.
- Don't: use a third colour, smooth easing, soft shadows or rounded UI cards; animate the grain; put body text
  smaller than a label on a shape; pile up more than three shapes.

## Building blocks

- Grain (written for this look), one per scene with its own filter id, above everything:
  ```html
  <svg class="grain" viewBox="0 0 1920 1080" preserveAspectRatio="none"><filter id="grain-hook"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="4" /><feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.6 1.2" /></filter><rect width="1920" height="1080" filter="url(#grain-hook)" /></svg>
  ```
  with `.grain { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0.22; mix-blend-mode: multiply; pointer-events: none; }`.
- Halftone fill: `background-image: radial-gradient(circle, <ink> 42%, transparent 44%); background-size: 16px 16px;`
  with the ink written as a literal colour.
- Step in: `tl.fromTo(shape, { x: 700 }, { x: 0, duration: 0.4, ease: 'steps(5)' }, 0.1)`.
- Register: `tl.fromTo(head, { textShadow: '-21px 18px 0px #ff4f6e' }, { textShadow: '-7px 6px 0px #ff4f6e', duration: 0.25, ease: 'steps(3)' }, 0.5)`.
- Create elements with `el.ownerDocument.createElement`: the contract refuses `document.` in a scene script.
