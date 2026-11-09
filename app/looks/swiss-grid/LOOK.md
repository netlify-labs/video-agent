# Swiss grid

## In one line

A modernist poster that moves: the grid is drawn on screen, type hangs flush-left from its lines, a few circles and
squares in one accent do the counting and pointing, and everything travels along the grid, never across it.

## Layout

- A visible grid in every scene, in the same place all video: hairlines in `rule`, inside a 5 % margin. 16:9: 12
  columns by 8 rows. 1:1: 8 by 8. 4:5: 8 by 10. 9:16: 6 by 12, with the bottom two rows left empty.
- Everything snaps to it. Type is flush-left and hangs from a row line (its top edge on the line); shapes fill whole
  cells or sit centred on an intersection. Nothing is centred on the frame, nothing is rotated except by 90°.
- Each scene has: a small index label in the top-left cell (`01  Search`), one block of large type spanning 6–8
  columns, and one shape or group of shapes at least two columns away from the type. At least a third of the cells
  stay empty.
- Screen recordings and screenshots fill a rectangle of whole cells, square-cornered, with a hairline border in
  `text` and no shadow.

## Type

- One grotesque family: the brand's sans, else `"Helvetica Neue", Helvetica, Arial, sans-serif`. Two weights only:
  700 for headlines and figures, 500 for labels.
- Headlines 12–13 % of the short side, line height 0.95, tracking -0.04em, sentence case, at most 6 words. Figures
  (one per video at most) 32–36 %. Labels 2.8–3 %, tracking 0. Never below 28 px.
- No centred text, no italics, no all-caps headlines, no drop shadows.

## Colour use

- `bg` paper, `text` for type, `accent` for shapes and for one full-width bar per video. Type on `accent` is `bg` or
  `text`, whichever contrasts at least 4.5:1. Never two accent hues, never gradients.
- Derived role, written as a literal colour: `rule` is `text` at 0.14 opacity, e.g. `rgba(17, 17, 17, 0.14)`. Never
  `color-mix(…)` or `var(…)` in a role's value.

## Motion

- Movement is horizontal or vertical only, by whole cells, on `expo.out` (0.7–0.8 s) or `power4.inOut` (0.6 s).
- Type slides in from one cell to the left inside a mask (`x: -144 → 0`), line by line, 0.1 s apart.
- Shapes fill cell by cell (`scaleY: 0 → 1` from the cell's bottom edge, 0.3 s, `power2.out`, 0.05 s apart, in
  reading order), or slide along a row or column by whole cells.
- Bars and rules draw from the left (`scaleX: 0 → 1`, 0.6 s, `power4.inOut`).
- The grid itself never moves. Nothing moves diagonally, rotates freely, bounces, fades or blurs.

## Transitions

- Hard cuts on the grid: because the grid stays put, the cut reads as the cells being refilled. Once per video, a
  full-width `accent` bar one row high may sweep down the frame by whole rows (0.5 s, `power4.inOut`) at the start of
  the incoming scene.

## Texture and effects

- None: hairlines and flat fills. No grain, shadows, glows or rounded corners (circles are the only curves).

## Pacing

- Scenes 3–4 s. 15 s: 4–5 scenes. 30 s: 8–9. 60 s: 15–17. The end card holds 2.5 s.

## Captions and text cues

- One caption cue per block of type, from when its last line has slid in to the end of its scene.

## Sound

- Music: dry minimal techno with a steady click, 124 bpm. Effects (only with sound effects on): a short tick per
  cell as shapes fill.

## Do / Don't

- Do: number the scenes in the index label; let shapes mean something (twelve squares for twelve months, one circle
  for one answer); keep the left edge of all type on the same column; end with the product name hanging from a line
  and one accent bar.
- Don't: centre anything, tilt anything, hide the grid, or decorate with shapes that count nothing.

## Building blocks

- Grid (written for this look), the same element in every scene; for 1920×1080 the cells are 144 by 111 px:
  ```css
  .grid { position: absolute; left: 96px; top: 96px; width: 1728px; height: 888px; border: 2px solid var(--va-color-rule); background-image: linear-gradient(to right, var(--va-color-rule) 2px, transparent 2px), linear-gradient(to bottom, var(--va-color-rule) 2px, transparent 2px); background-size: 144px 111px; }
  ```
- Line slide: each headline line in its own `overflow: hidden` box, `tl.fromTo(lines, { x: -144 }, { x: 0, duration: 0.75, ease: 'expo.out', stagger: 0.1 }, 0)`;
  a `<br>` becomes one text element per line.
- Cell fill: `tl.fromTo(cells, { scaleY: 0 }, { scaleY: 1, duration: 0.3, ease: 'power2.out', stagger: 0.05 }, 0.4)`
  with `transform-origin: center bottom`.
- Place things by cell: `left = 96 + column × 144`, `top = 96 + row × 111`.
- Create elements with `el.ownerDocument.createElement`: the contract refuses `document.` in a scene script.
