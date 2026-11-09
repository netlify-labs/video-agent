# One take

## In one line

The whole video feels like one unbroken shot: nothing fades, blurs or cuts, because every scene is built out of the
last thing that was on screen.

## Layout

- Warm, flat `bg`; UI drawn in `text` (solid buttons, bars and fields); one idea per scene, centred or left-aligned
  with 8 % margins, and at least 40 % of the frame empty.
- Every scene has a **carrier**: the one shape that is handed to the next scene (a pill button, a card, a bar, a
  circle, or a full-frame field of `text` or `accent`). Decide the carriers before the words.
- 16:9: text in the left or centre 70 %. 9:16, 1:1 and 4:5: stack text over UI, carriers centred horizontally;
  9:16 keeps the bottom 15 % clear.
- Screen recordings and screenshots sit in a browser frame that itself arrives as a carrier (a pill or card that
  grows into the frame); never dropped in from nowhere.

## Type

- The brand's sans (else `system-ui, sans-serif`). Headlines 8.5–10 % of the short side, weight 700, tracking
  -0.03em, line height 1.05, at most 8 words on two lines. UI labels 3.2–3.8 %, weight 600. Never below 28 px.
- One short line per scene. No full stops in on-screen text.

## Colour use

- `bg` is the canvas; `text` is both the type and the solid UI; `muted` for secondary lines; `accent` for one thing
  per scene (a highlight bar, a send button, a flood).
- Floods are full frames of `text` or `accent`. Type on a flood uses whichever of `bg` / `text` contrasts at least
  4.5:1. No gradients, no derived roles.

## Motion

- Four moves only, all `power3.inOut` or `power3.out`:
  1. **Rise**: text comes up out of a mask line (`yPercent: 110 → 0`, 0.5 s, `power3.out`).
  2. **Grow**: the carrier changes `left` / `top` / `width` / `height` / `borderRadius` into its next shape (0.6 s,
     `power3.inOut`): a button into a page, a page into a search field, a bar into a button.
  3. **Flood**: a shape grows until it covers the frame, or a full frame contracts into a shape (0.55–0.7 s).
  4. **Draw**: bars and underlines run across (`scaleX: 0 → 1` from the left, 0.45 s, `power2.out`).
- New small elements pop from zero on a short spring (`back.out(1.6)`, 0.35 s). A click is the carrier pressing
  (`scale: 0.96`, 0.08 s) just before it grows.
- At most one camera move per scene (the scene's wrapper scaling 1 → 1.04, ease `none`), and never a zoom in followed
  by a zoom out.
- Never: opacity fades, blur-ins, 3D flips, particles, glows, or a hold longer than 1 s with nothing moving.

## Transitions

- There are none to see. The last frame of a scene and the first frame of the next show the carrier at the same
  place, size, radius and colour, or the same full-frame flood. The incoming scene then changes it (the transition
  belongs to the scene it leads into). Write the carrier's numbers once and use them on both sides.

## Texture and effects

- None: flat fills, hairlines, at most one soft shadow under a browser frame. No grain, glass, glow or blur.

## Pacing

- Scenes 2.5–4 s, something changing at least every second. 15 s: 4–5 scenes. 30 s: 8–10. 60 s: 15–18, with a
  flood at most every third scene. The end card holds 2 s.

## Captions and text cues

- One caption cue per line of text, from when it has risen to the end of its scene.

## Sound

- Music: confident house with a clear drop, 120–124 bpm; the first flood lands on the drop. Effects (only with sound
  effects on): a soft tick on each press, a low whoosh under a flood.

## Do / Don't

- Do: list the carriers first ("pill → dark page → search field → accent flood → underline → button"); let the end
  card's button be the last carrier; keep UI drawn simply in `text`.
- Don't: cut, crossfade, or let a scene start from an empty frame; introduce a shape that isn't made from the
  carrier or risen from a mask; use more than one accent thing per scene.

## Building blocks

- Carrier hand-over (written for this look). The outgoing scene ends with the pill covering the frame; the incoming
  scene starts with the same full-frame box and turns it into a search field:
  ```js
  vaBeat('open', (tl, el) => {
    tl.to(el.querySelector('.carrier'), { left: 0, top: 0, width: 1920, height: 1080, borderRadius: 0, duration: 0.6, ease: 'power3.inOut' }, 2.3)
  })
  vaBeat('page', (tl, el) => {
    tl.fromTo(el.querySelector('.carrier'), { left: 0, top: 0, width: 1920, height: 1080, borderRadius: 0 }, { left: 410, top: 170, width: 1100, height: 112, borderRadius: 56, duration: 0.65, ease: 'power3.inOut' }, 0)
  })
  ```
- Mask rise: wrap the text in an `overflow: hidden` box and tween the text's `yPercent` from 110 to 0.
- Typed text: reveal it with `clipPath: 'inset(0 100% 0 0)' → 'inset(0 0% 0 0)'` on a `steps(n)` ease, one step per
  character; a script never writes the text itself.
- Create elements with `el.ownerDocument.createElement`: the contract refuses `document.` in a scene script.
