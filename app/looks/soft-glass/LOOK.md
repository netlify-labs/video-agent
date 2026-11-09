# Soft glass

## In one line

A bright, soft launch film: the brand's accent as a haze behind frosted glass panels, a cursor that causes every
change, and motion that arrives already moving and settles gently.

## Layout

- Background: `bg` with two large, still pools of `haze` (radial gradients, each about 60 % of the frame wide, one
  upper-left, one lower-right). Never a flat frame, never more than two pools.
- Content lives on glass panels: fill `glass`, `backdrop-filter: blur(24px)`, a 1.5 px border of white at 0.7
  opacity, corner radius 3 % of the short side, and one wide soft shadow (`0 30px 80px` in `text` at 0.14 opacity,
  written as a literal `rgba(...)`). At most two panels on screen; a second panel overlaps the first by 10–20 %.
- 16:9: one panel centred (55–60 % of the width), or headline left (columns 1–5 of 12) and panel right. 9:16, 1:1 and
  4:5: headline above, panel below, both centred, 7 % margins; 9:16 keeps the bottom 15 % clear.
- Screen recordings and screenshots go inside a glass panel with 1.2 % inner padding, never full-bleed.
- A cursor (a small arrow in `text` with a white 2 px outline) is in every scene that has UI.

## Type

- The brand's sans (else `system-ui, sans-serif`). Headlines 7–8 % of the short side, weight 600, tracking -0.025em,
  line height 1.08, at most 7 words. Panel titles 4 %, weight 600. Body 3–3.3 %, weight 400, `muted`.
- Sentence case, no all-caps. Never below 28 px, never more than two lines of body in a panel.

## Colour use

- `text` for headlines and UI, `muted` for secondary lines, `accent` for one control per scene (a button, a
  highlight under a key phrase, a focused field's ring).
- Derived roles, written as literal colours: `haze` is `accent` mixed 72 % toward white (on a dark `bg`: `accent`
  mixed 55 % toward `bg`). `glass` is white at 0.55 opacity, `rgba(255, 255, 255, 0.55)` (on a dark `bg`: white at
  0.08). Never `color-mix(…)` or `var(…)` in a role's value.
- Label on an `accent` button: `bg` or `text`, whichever contrasts at least 4.5:1.

## Motion

- Everything enters already moving: from 5 % of the short side away, `expo.out`, 0.7–0.9 s, with
  `filter: blur(14px) → blur(0px)` over the first 0.45 s. The blur is on the moving element, never the whole frame.
- Panels spring out of the control that opened them: `scale: 0.9 → 1`, `back.out(1.3)`, 0.55 s, transform origin at
  that control.
- The cursor glides on `power3.inOut` (0.6–0.8 s), presses (`scale: 0.86`, 0.08 s) and the pressed control answers
  0.05 s later (`scale: 0.96 → 1`). Nothing in the UI changes without a press or a typed character.
- Typed text is revealed with `clipPath` on a `steps(n)` ease. A slow drift (`scale: 1 → 1.03`, `none`) on the main
  panel is allowed; nothing else moves once settled.
- Never bounce twice, spin, shake or flash.

## Transitions

- The incoming scene's panel arrives from the direction the cursor last moved, with the entrance blur. At most one
  "whip" per video: the incoming scene starts 12 % away with `blur(24px)` and lands in 0.4 s (`expo.out`), into the
  moment that matters most. No crossfades.

## Texture and effects

- Glass, haze, one shadow per panel, and a 1 px white inner highlight on a panel's top edge. No grain, no neon
  glow, no lens flares, no gradients on text.

## Pacing

- Scenes 2.5–4 s. 15 s: 4–5 scenes. 30 s: 8–9. 60 s: 14–16. The end card holds 2.5 s.

## Captions and text cues

- One caption cue per piece of text, from when it has settled to the end of its scene.

## Sound

- Music: airy melodic house, 120–124 bpm. Effects (only with sound effects on): a soft tap on each press, a light
  whoosh on the whip.

## Do / Don't

- Do: keep the haze still, let the cursor lead, put one thing in `accent`, end on the product's mark, name and one
  button.
- Don't: imitate a specific company's keynote or operating system; stack more than two panels; blur text that a
  viewer is meant to be reading; use purple-to-pink gradients the brand doesn't have.

## Building blocks

- Glass panel (written for this look):
  ```css
  .glass { background: var(--va-color-glass); backdrop-filter: blur(24px); border: 1.5px solid rgba(255, 255, 255, 0.7); border-radius: 32px; box-shadow: 0 30px 80px rgba(16, 24, 40, 0.14); }
  ```
- Entrance: `tl.fromTo(panel, { y: 54, filter: 'blur(14px)' }, { y: 0, filter: 'blur(0px)', duration: 0.8, ease: 'expo.out' }, 0)`.
- Cursor press: `tl.to(cursor, { x, y, duration: 0.7, ease: 'power3.inOut' }).to(cursor, { scale: 0.86, duration: 0.08 }).to(cursor, { scale: 1, duration: 0.15 })`,
  then the control: `tl.fromTo(button, { scale: 0.96 }, { scale: 1, duration: 0.3, ease: 'power2.out' })`.
- The cursor is an inline `<svg>` arrow in the scene's markup, placed with `x` / `y`.
- Create elements with `el.ownerDocument.createElement`: the contract refuses `document.` in a scene script.
