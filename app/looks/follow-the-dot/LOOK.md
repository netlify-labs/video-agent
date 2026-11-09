# Follow the dot

## In one line

One small dot in the brand's accent is on screen from the first frame to the last, and everything else happens
because the dot arrived: it flips a toggle, draws a chart line, floods the frame, and ends as the full stop after the
product's name.

## Layout

- Flat `bg`, a lot of empty space, at most one headline, one small UI part or chart, and the dot. Nothing decorative.
- The dot: a circle in `accent`, 2.6 % of the short side across (28 px at 1080) when it rests. Exactly one per frame.
- 16:9: 10 % side margins; text left-aligned in the left 70 %. 9:16, 1:1 and 4:5: 8 % margins, text stacked and
  left-aligned, the dot's path kept inside the middle 70 % of the height; 9:16 keeps the bottom 15 % clear.
- The dot always has a job. Pick one per scene: the knob of a toggle or slider, the dot on an "i" or a full stop, a
  bullet, a cursor, the tip of a line it is drawing, a flood of colour. Never a dot that just sits beside the text.
- This look doesn't frame screen recordings (`recording: false`); draw the one UI part the scene is about (a toggle,
  a search box, a slider) as flat shapes with a border of 0.4 % of the short side in `text`.

## Type

- The brand's sans (else `system-ui, sans-serif`). Headlines 9–10 % of the short side, weight 800, tracking -0.03em,
  line height 1.02, sentence case, at most 7 words. The product name on the end card: 20 %.
- Labels and callouts: 3.2–4 %, weight 600. Never below 28 px. No all-caps, no full stops except the dot itself.

## Colour use

- `bg` everywhere, `text` for type and thin lines, `accent` for the dot and whatever the dot has just touched (the
  line it drew, the toggle it switched on). Nothing is `accent` before the dot gets there.
- On a flood the whole frame is `accent` and type is `text` or `bg`, whichever contrasts at least 4.5:1.
- No derived roles, gradients, shadows or tints.

## Motion

- The dot moves first, then the scene answers. A hop: 0.45–0.6 s, x on `power1.inOut` and y on `power2.in` (or
  `power2.out` going up) so the path is an arc, never a straight slide. Landing on a control: `back.out(1.6)`, 0.35 s.
- Text rises out of a mask line (`yPercent: 110 → 0`, 0.5 s, `power3.out`) 0.1–0.2 s after the dot lands.
- Tracing: the dot runs along the points while the line's `stroke-dashoffset` runs to 0 over the same time, each
  segment's duration in proportion to its length, ease `none`.
- Flood: the dot scales until it covers the frame (0.55 s, `power3.in`) and back down (0.7 s, `power3.inOut`).
- Nothing loops, bounces twice, fades in from nothing or moves without the dot causing it.

## Transitions

- Cuts are hidden by the dot. Either the dot rests at the same point and size on both sides of the cut (the last
  frame of one scene and the first of the next), or the frame is fully `accent` on both sides (one scene ends flooded,
  the next starts flooded and shrinks the flood into its dot). No fades, wipes or pushes.

## Texture and effects

- None. Flat fills and hairlines only: no grain, glow, blur, shadow or particles.

## Pacing

- Scenes 2.5–4 s, one job for the dot in each. 15 s: 4–5 scenes. 30 s: 8–10. 60 s: 15–18, with a flood at most
  every third scene. The end card holds 2 s after the dot lands.

## Captions and text cues

- One caption cue per piece of text, from when it has risen to the end of its scene.

## Sound

- Music: tight minimal electronic, 120 bpm; the dot lands on beats. Effects (only with sound effects on): a soft
  click as the dot lands, a low swell on a flood.

## Do / Don't

- Do: decide the dot's job in each scene before writing anything else; end with the product name and the dot as
  its full stop; keep the first frame readable (the headline may already be there at 0 s).
- Don't: add a second dot, sparkles, trails or rings; colour anything `accent` that the dot hasn't touched; teleport
  the dot across a cut; put a full stop in a headline.

## Building blocks

- The dot is one absolutely placed element per scene, moved with `x` / `y` (its centre minus half its size):
  ```js
  vaBeat('hook', (tl, el) => {
    const dot = el.querySelector('.dot')
    tl.set(dot, { x: 212, y: 342 }, 0)
      .to(dot, { x: 264, duration: 0.35, ease: 'back.out(1.6)' }, 0.5) // flips the toggle
      .to(dot, { x: 346, duration: 0.55, ease: 'power1.inOut' }, 2.3) // hops to where the next scene starts
      .to(dot, { y: 786, duration: 0.55, ease: 'power2.in' }, 2.3)
  })
  ```
  The next scene's first line is `tl.set(dot, { x: 346, y: 786 }, 0)`: the same numbers.
- Mask rise: wrap the text in a `overflow: hidden` box and tween the text's `yPercent` from 110 to 0.
- Trace: an inline `<svg>` polyline with `stroke-dasharray` and `stroke-dashoffset` set to its length, tweened to 0
  while the dot's `x` / `y` keyframes visit the same points.
- Flood and back: `tl.to(dot, { scale: 170, duration: 0.55, ease: 'power3.in' })`; the next scene starts with its dot
  at that scale (`tl.fromTo(stop, { scale: 150 }, { scale: 1, … }, 0)`), above the text (`z-index`).
- Create elements with `el.ownerDocument.createElement`: the contract refuses `document.` in a scene script.
