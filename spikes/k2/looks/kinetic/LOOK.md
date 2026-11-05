# Kinetic type

## In one line

Type is the picture: one to four huge words at a time, cut to the beat, with a single accent word that hits.

## Layout

- Every shape: words fill the frame. The main word block spans 80–90 % of the frame's width; margins 6 % of the
  short side. Left-aligned on 16:9; centred on 9:16, 1:1 and 4:5.
- 9:16: stack one word per line, up to 4 lines, in the middle 70 % of the height (keep the bottom 15 % clear).
- No product UI, no photos, no cards, unless the request gives media: then media is a full-bleed background under a
  60 % `bg` overlay, and type stays on top.
- One thought per scene; a scene shows at most 4 words at once.

## Type

- Hero words: 18–24 % of the frame's short side (about 200–260 px at 1080), weight 800–900, uppercase, tracking
  -0.04em, line height 0.9.
- Support words (a small line under the hero, optional): 4 % of the short side (about 44 px), weight 600, uppercase,
  tracking 0.12em.
- Never below 28 px; never more than 4 words of hero type on screen.

## Colour use

- `bg` flat behind everything; `text` for hero words; exactly one accent word per scene in `accent` (the verb or the
  number). A scene may invert (`accent` background, `bg` words) once per video, for the strongest line.

## Motion

- Words enter letter by letter from below (Building blocks: letter rise): each letter 0.4–0.5 s, `back.out(1.7)`,
  staggered 0.02–0.03 s, starting at 0.05–0.15 s. The scene's first word block is on screen by 0.6 s.
- Accent words punch: scale 1.15 → 1, 0.25 s, `power4.out`, on the beat after they land.
- Hold still for at least 0.6 s once a line is complete; readable beats motion.
- Exits are cuts. Never fade type out slowly.

## Transitions

- Hard cuts on the beat (scene lengths are multiples of 0.5 s at 120 bpm). One flash cut per video at most: the
  incoming scene starts with a 2-frame `accent` full-frame flash (a div at opacity 1 → 0 over 0.08 s).

## Texture and effects

- None: flat colour only. No grain, no glow, no shadows on type.

## Pacing

- Scenes 1.5–3 s. 15 s: 6–8 scenes. 30 s: 12–14 scenes. 60 s: 20–24 scenes. The end card holds 2.5–3 s.

## Captions and text cues

- One caption cue per scene's full line (all its words together), from when the line completes to the scene's end.

## Sound

- Music: punchy electronic, 120 bpm; cut scenes on beats. Effects: a short low hit on each accent punch (only when the
  run has sound effects).

## Do / Don't

- Do: write short, strong lines (3–4 words); let one word per scene carry the accent; end on the product name, huge.
- Don't: use sentences; show more than one line of support words; use icons or illustrations; slow fades.

## Building blocks

- Letter rise (from the HyperFrames `bottom-up-letters` component, rewritten for the contract): the text element keeps
  its `data-va-text` and its plain text in the HTML (the editor edits that). Inside the scene's vaBeat, split it into
  spans first, then animate the spans:
  ```js
  vaBeat('hook', (tl, el) => {
    const word = el.querySelector('[data-va-text="hook-title"]')
    const chars = Array.from(word.textContent).map((c) => {
      const s = el.ownerDocument.createElement('span')
      s.textContent = c === ' ' ? ' ' : c
      s.style.display = 'inline-block'
      return s
    })
    word.replaceChildren(...chars)
    tl.fromTo(chars, { y: '0.85em', opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, ease: 'back.out(1.7)', stagger: 0.025 }, 0.1)
  })
  ```
  Create elements with `el.ownerDocument.createElement`: the contract refuses any `document.` in a scene script.
