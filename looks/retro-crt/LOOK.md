# Retro CRT

## In one line

The video plays on an old monitor: monospace type in the brand's accent as phosphor, scanlines, a soft glow, a curved
vignette and a short, deliberate glitch on scene changes.

## Layout

- A screen inset: the content sits inside a rounded "tube" (radius 4 % of the short side) with 5 % margins, on `bg`.
  A vignette darkens the tube's edges.
- Text is left-aligned in a terminal-like column (columns 1–9 of 12 on 16:9; full width on 9:16, 1:1 and 4:5).
  9:16 keeps the bottom 15 % clear.
- This look doesn't frame screen recordings or product UI well (`recording: false`); describe the product in words,
  or show media small, inside a bordered box, under the scanlines.

## Type

- Monospace throughout: `"JetBrains Mono", ui-monospace, Menlo, monospace` unless the brand has a monospace font.
- Headlines 7–9 % of the short side, weight 700, uppercase, tracking 0.02em. Body 3.2–3.6 %, weight 500. A blinking
  block cursor (`█`) ends the current line. Never below 26 px.

## Colour use

- `bg` behind the tube (near black, whichever the brand's darkest role is); type in `accent` (the phosphor colour is
  the brand's accent; a person who wants green asks for it); `text` only for one emphasised word per scene.
- Derived roles, written as literal colours: `glow` is `accent` mixed 50 % toward white, used for the text glow
  (`text-shadow: 0 0 12px <glow>`); `scan` is black at 0.25 opacity written as a literal `rgba(0, 0, 0, 0.25)`.

## Motion

- Type appears line by line with a 0.06 s flicker (opacity 0 → 1 → 0.4 → 1), never letter-scrambles.
- The cursor blinks with a 1 s period (steps, not fades).
- Glitch: on a scene change only, 0.2 s of horizontal slices shifted by fixed offsets (±1–2 % of the width), then
  back. Offsets are written as constants: no `Math.random`, so every frame renders the same when sought.

## Transitions

- A glitch cut (above) or a "power-off" for the last scene: the tube squashes to a horizontal line (scaleY 1 → 0.01,
  0.25 s) then to a dot.

## Texture and effects

- Scanlines over everything: a repeating 4 px pattern (2 px `scan`, 2 px clear), static, not scrolling. A radial
  vignette at the tube's edge. A soft glow on text (`glow`). No chromatic aberration above 2 px.

## Pacing

- Scenes 2–3.5 s. 15 s: 5–6 scenes. 30 s: 9–11. The end card holds 3 s with the cursor blinking.

## Captions and text cues

- One caption cue per line of type, from when it's in to the scene's end.

## Sound

- Music: synthwave, 100–110 bpm. Effects (only with sound effects on): a short static burst on each glitch.

## Do / Don't

- Do: write short lines like a terminal prompt, keep one idea per screen, end on the product name and a cursor.
- Don't: imitate a specific game, film or computer brand's identity; use random flicker; use more than one glitch per
  scene change.

## Building blocks

- Line in, with a flicker (written for this look):
  ```js
  vaBeat('hook', (tl, el) => {
    tl.fromTo(el.querySelector('[data-va-text="hook-title"]'), { opacity: 0 }, { keyframes: [{ opacity: 1, duration: 0.03 }, { opacity: 0.4, duration: 0.03 }, { opacity: 1, duration: 0.03 }] }, 0.2)
  })
  ```
- Glitch slices: two copies of the scene's headline clipped to bands (`clip-path: inset(...)`), moved by constant x
  offsets for 0.2 s.
- Create elements with `el.ownerDocument.createElement`: the contract refuses `document.` in a scene script.
