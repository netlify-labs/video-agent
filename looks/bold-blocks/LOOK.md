# Bold blocks

## In one line

Thick black borders, hard offset shadows and flat colour fields that slam in on the beat: loud, friendly and readable
at phone size.

## Layout

- Everything is a block: a rectangle with a border of 0.8 % of the short side (about 8 px at 1080) in `text`, no
  radius, and a hard shadow offset down-right by 1.4 % of the short side, also in `text`, with no blur.
- 16:9: one or two blocks per scene, placed off-centre on a loose grid (6 % margins); a second block may overlap the
  first by up to 10 %. 9:16, 1:1 and 4:5: blocks stack, full width minus margins; 9:16 keeps the bottom 15 % clear.
- Product UI or media sits inside a block like a framed sticker. At most three blocks on screen.

## Type

- Headlines: the brand's sans (else `system-ui, sans-serif`), 9–12 % of the short side, weight 800, line height 1,
  tracking -0.02em, sentence case. Labels on tags: 2.6 %, weight 700, uppercase, tracking 0.06em.
- Body (rare): 3.4 %, weight 500. Never below 26 px, never more than 10 words in a block.

## Colour use

- `bg` behind everything. Blocks fill with `accent` (the one that matters), `field` (the others) or `bg`. Type is
  `text` on light fields and `bg` on dark ones; pick whichever contrasts at least 4.5:1.
- Derived role, written as a literal colour: `field` is `accent` mixed 70 % toward white (a pale tint of the accent).
  Never use `color-mix(…)` or `var(…)` for it.

## Motion

- Blocks slam in: from 6 % of the short side above and 1.04 scale to their place, 0.28 s, `back.out(2)`; the shadow
  lands with them. Stagger 0.1 s.
- On a beat, a block may "press": it moves by its shadow's offset and the shadow shrinks to 0 for 0.12 s, then springs
  back (`power2.out`). At most one press per scene.
- Text inside a block appears with the block; never type it out letter by letter.

## Transitions

- Hard cuts on the beat. Once per video at most, a full-frame `accent` block wipes across in 0.25 s and the next scene
  starts underneath it.

## Texture and effects

- None: flat fills, solid borders, solid shadows. No gradients, blur, glow or grain.

## Pacing

- Scenes 1.5–2.5 s, cut on beats (120–128 bpm). 15 s: 6–8 scenes. 30 s: 11–14. The end card holds 2.5 s.

## Captions and text cues

- One caption cue per block of text, from when it lands to the scene's end.

## Sound

- Music: upbeat indie pop, 120–128 bpm. Effects (only with sound effects on): a short thump as each block lands.

## Do / Don't

- Do: keep it to one idea per block, use the accent block for the claim, end with the product name in a big block.
- Don't: round corners, blur shadows, use gradients or thin type, or let blocks drift slowly.

## Building blocks

- Slam in (written for this look):
  ```js
  vaBeat('hook', (tl, el) => {
    tl.fromTo(el.querySelectorAll('.block'), { y: -60, scale: 1.04, opacity: 0 }, { y: 0, scale: 1, opacity: 1, duration: 0.28, ease: 'back.out(2)', stagger: 0.1 }, 0.05)
  })
  ```
- Press: `tl.to(block, { x: 14, y: 14, boxShadow: '0 0 0 #111111', duration: 0.12 }).to(block, { x: 0, y: 0, boxShadow: '14px 14px 0 #111111', duration: 0.2, ease: 'power2.out' })`
  (write the shadow colour as the literal `text` colour).
- Create elements with `el.ownerDocument.createElement`: the contract refuses `document.` in a scene script.
