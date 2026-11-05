# Clean product

## In one line

Calm and clear: one idea per scene, product UI on soft cards, gentle eases, lots of space.

## Layout

- 16:9 (1920×1080): margins at least 120 px left and right, 96 px top and bottom. Text sits left-aligned on a
  12-column grid, in columns 1–7; product media sits in columns 6–12, so they overlap by at most one column.
- 9:16 (1080×1920): margins 80 px. Stack: headline in the top third, media in the middle third, supporting line or
  call to action in the bottom third, above the bottom 15 % (captions and platform UI live there).
- 1:1 and 4:5: margins 96 px. Headline on top, media below; centre both.
- Product screenshots and clips go on a card: `--va-color-surface` background, 20–28 px corner radius, one soft
  shadow (`0 24px 60px rgba(0,0,0,0.28)`), 24 px inner padding. Never full-bleed UI.
- One idea per scene: a headline, at most one supporting line, at most one piece of media.

## Type

- Headline: 7 % of the frame's short side (about 76 px at 1080), weight 700, tracking -0.02em, sentence case, at
  most 6 words a line and 2 lines.
- Supporting line: 3.3 % of the short side (about 36 px), weight 400, `--va-color-muted`, at most 12 words.
- Kicker (optional, above the headline): 2.6 % (28 px minimum), weight 600, uppercase, tracking 0.16em,
  `--va-color-accent`.
- Never below 28 px for anything a viewer reads.

## Colour use

- Large flat fields of `bg`; `text` for headlines; `muted` for supporting lines; `accent` once per scene at most
  (the kicker, an underline, one highlighted word or one UI highlight).
- `surface` (derived): `bg` mixed 6 % toward `text` on dark brands, or 4 % toward black on light ones. Write the
  result as a hex literal, e.g. `--va-color-surface: #16191e;` for `bg` `#0b0d10`.
- Never put text on `accent`; never use gradients across the whole frame.

## Motion

- Entrances: fade plus a short rise (`y: 16–24 px`), 0.5–0.7 s, `power3.out`, staggered 0.1–0.15 s, starting
  0.2–0.35 s into the scene.
- Media cards: fade and scale from 0.96 to 1, 0.7 s, `power2.out`.
- Exits: none inside a scene; the next scene's entrance does the handover.
- A slow drift on media (scale 1 → 1.03 across the scene, `none` ease) is allowed; nothing else moves once settled.
- Never spin, bounce, flash or shake.

## Transitions

- Hard cuts between scenes, softened by the incoming scene's entrance. At most one crossfade (0.4 s) per video,
  into the end card. The transition belongs to the scene it leads into.

## Texture and effects

- None by default: flat colour, one soft shadow on cards. No grain, no glow, no blur except the media card shadow.

## Pacing

- Scenes 3–5 s; the opening and end card 2.5–3.5 s.
- 15 s: 4 scenes. 30 s: 6–7 scenes. 60 s: 10–12 scenes.

## Captions and text cues

- One caption cue per on-screen headline or supporting line, from when it's readable to the end of its scene.

## Sound

- Music: warm minimal electronic, 100–110 bpm, low in the mix. Effects: at most a soft click when UI is pressed.

## Do / Don't

- Do: leave space; show the product; finish on an end card with the product name and one call to action.
- Don't: stack more than two text elements; use more than one accent per scene; animate text letter by letter.

## Building blocks

- Lower thirds (a name and a role on a card): a card at the bottom left (left 120 px, bottom 110 px) with a 12 px
  accent tab on its left edge, `surface` body, name 52 px bold and role 28 px `muted`. In the scene's vaBeat: the card
  wipes in with `clipPath: 'inset(0 100% 0 0)' → 'inset(0 0% 0 0)'` (0.55 s, `power3.out`) at 0.1 s, the tab grows
  from `scaleY: 0` at 0.28 s, the name and role rise 22 px with opacity at 0.34 s and 0.44 s.
- Device frames: draw a browser window as a `surface` card with a 44 px top bar holding three 12 px dots
  (`muted`), the media slot inside it.
