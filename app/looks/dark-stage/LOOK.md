# Dark stage

## In one line

Everything happens on one near-black, rounded stage that never moves, with the brand's accent glowing behind it like
a lit wall: compact type, a few precise UI parts, and a lot of dark, quiet space.

## Layout

- The surround: a still gradient, `accent` brightest in the upper-left corner, through `backdrop`, to near-black at
  the bottom. No text or UI ever sits on the surround.
- The stage: a rounded rectangle in `stage`, corner radius 4 % of the short side, centred horizontally and 1.5 % below
  the vertical centre. 16:9: 80 % of the width, 76 % of the height. 1:1 and 4:5: 86 % by 80 %. 9:16: 88 % by 70 %,
  clear of the bottom 15 %. It is in the same place in every scene of the video.
- Inside the stage, compositions are compact and centred (or centred left column plus one UI part on the right in
  16:9), using at most 60 % of the stage's width and leaving at least 12 % of the stage empty on every side.
- UI parts are `panel` rectangles with a radius of 1.6 % of the short side: a search field, a list of three rows, a
  player bar, one card. Screen recordings fill the stage's inside edge to edge, clipped by its radius, with no extra
  frame.

## Type

- The brand's sans (else `system-ui, sans-serif`), one family only. Headlines 6–7 % of the short side, weight 600,
  tracking -0.02em, line height 1.12, at most 6 words; the second line of a two-line headline may be `accent`.
- Secondary lines 3–3.3 %, weight 400, `muted`. UI labels 3 %, weight 500. A single big figure may be 16 %, weight
  600, in `accent`. Never below 28 px. This is product advertising, not slide headings: keep it small and exact.

## Colour use

- Inside the stage, type is the lighter of the brand's `bg` and `text` (called "light" below); secondary type is
  `muted`; `accent` is for one emphasised line or one control per scene, and for the surround.
- Derived roles, written as literal colours: `stage` is the darker of the brand's `bg` and `text` mixed 55 % toward
  black (never lighter than `#141416`). `backdrop` is `accent` mixed 62 % toward black. `panel` is white at 0.07
  opacity, `rgba(255, 255, 255, 0.07)`. Never `color-mix(…)` or `var(…)` in a role's value.
- Label on an `accent` control: the stage colour or light, whichever contrasts at least 4.5:1.

## Motion

- The stage and the surround never move, scale or fade. Only what is inside the stage does.
- Entrances: rise 3 % of the short side with opacity, 0.6 s, `power3.out`, staggered 0.1 s, starting 0.15 s into the
  scene. UI rows build top to bottom, 0.08 s apart.
- One "live" detail per scene: a progress bar filling (`scaleX`, ease `none`), a highlight sliding to the next row
  (`power3.inOut`, 0.45 s), a figure counting on a tweened value.
- Never bounce, spin, shake, or use camera moves; never animate the glow.

## Transitions

- The stage stays put across every cut, so only its contents change. The incoming contents rise as above; once per
  video the outgoing scene may end by sliding its contents up 4 % and out (0.3 s, `power2.in`) so the stage is empty
  on the cut. No wipes or crossfades of the whole frame.

## Texture and effects

- A 1 px inner highlight on the stage's top edge (white at 0.08), a soft glow under the one `accent` control
  (`0 0 48px` of `accent` at 0.35 opacity, written as a literal `rgba(...)`). No grain, scanlines or particles.

## Pacing

- Scenes 2.5–4 s. 15 s: 4–5 scenes. 30 s: 8–10. 60 s: 15–18. The end card holds 2.5 s.

## Captions and text cues

- One caption cue per piece of text, from when it has risen to the end of its scene.

## Sound

- Music: deep melodic electronic, 110–118 bpm. Effects (only with sound effects on): a soft tick as each row lands.

## Do / Don't

- Do: keep the stage identical in every scene; leave it mostly empty; use the accent line for the part of the
  sentence that matters; end on the mark, the name and one accent button.
- Don't: imitate a specific company's or app's identity; put text on the surround; fill the stage edge to edge with
  cards; add captions, watermarks, footers or progress counters outside it.

## Building blocks

- Stage and surround (written for this look), drawn in every scene with the same numbers:
  ```css
  .beat { background: radial-gradient(1500px 1100px at 8% 0%, var(--va-color-accent), var(--va-color-backdrop) 45%, #050506 100%); }
  .stage { position: absolute; left: 192px; top: 146px; width: 1536px; height: 820px; border-radius: 44px; background: var(--va-color-stage); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08); overflow: hidden; }
  ```
- Rise: `tl.fromTo(items, { y: 32, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: 'power3.out', stagger: 0.1 }, 0.15)`.
- Highlight moving down a list: one absolutely placed `accent` bar behind the rows, tweened in `y` by one row height.
- A counting figure starts empty with no text id; the script writes it from a tweened value scaled by
  `data-duration / data-va-authored-duration`.
- Create elements with `el.ownerDocument.createElement`: the contract refuses `document.` in a scene script.
