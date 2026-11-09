# Editorial

## In one line

A magazine spread that moves: a large serif headline on a column grid, a small-caps kicker, hairline rules, captions
under every picture, and slow, deliberate motion.

## Layout

- A 12-column grid with 6 % outer margins and gutters of 2 % of the width. Text sits in columns 1–7 on 16:9 (a
  picture or a pull quote in 8–12); on 9:16, 1:1 and 4:5 everything stacks in one column, picture above text.
- Every text scene has three tiers, top to bottom: a kicker (small caps), the headline, then a deck (one or two
  sentences) or a caption. A hairline rule separates the kicker from the headline.
- Generous whitespace: at least 35 % of the frame stays empty. Never centre body text; centre only the end card.
- Pictures (the request's media or product UI) sit in a frame with no radius and no shadow, with a caption under it
  in `muted`. 9:16 keeps the bottom 15 % clear.

## Type

- Headline: the brand's serif if it has one, else `Georgia, "Times New Roman", serif`. 9–11 % of the short side
  (about 100–120 px at 1080), weight 400, line height 1.05, tracking -0.01em; italic for one emphasised phrase.
- Kicker: the brand's sans (else `system-ui, sans-serif`), 2.2 % of the short side (about 24 px), weight 600,
  uppercase, tracking 0.18em.
- Deck and captions: the brand's sans, 3–3.4 % (about 34–36 px), weight 400, line height 1.35; captions 2.4 %.
- Never below 22 px. At most 14 words of deck per scene.

## Colour use

- `bg` behind everything (off-white or near-black, whichever the brand's `bg` is); `text` for headlines and deck;
  `muted` for kickers, captions and rules; `accent` only for the kicker's leading dot or rule, and one italic phrase
  per video at most. No accent backgrounds.

## Motion

- Slow and eased: `power2.out` or `power3.inOut`, 0.8–1.2 s. Nothing bounces.
- The rule draws from left to right (scaleX 0 → 1, 0.8 s, transform origin left) before the headline arrives.
- Headlines rise 3 % of the short side while fading in, line by line, 0.15 s apart. Deck and captions fade in after.
- Pictures pan slowly the whole scene (scale 1.04 → 1, or x by 2 % of the width), like a camera on a spread.

## Transitions

- Cross-dissolve between scenes, 0.5 s (the outgoing scene fades to `bg` over its last 0.5 s). No pushes, wipes or
  flashes.

## Texture and effects

- None by default. A hairline rule (1 px at 1080, in `muted`) is the only ornament. No grain, glow or gradients.

## Pacing

- Scenes 3–5 s; let the reader finish the deck. 15 s: 3–4 scenes. 30 s: 6–7. 60 s: 11–13. The end card holds 3 s.

## Captions and text cues

- One caption cue per scene: the headline, then the deck, from when the headline is in to the scene's end.

## Sound

- Music: warm piano and strings, 80–90 bpm. Effects (only with sound effects on): a soft paper slide on each scene
  change.

## Do / Don't

- Do: write headlines like a magazine (a claim, not a slogan), use one italic phrase for emphasis, caption pictures.
- Don't: use all caps for headlines, bold weights, icons, emoji, rounded corners, shadows or fast motion.

## Building blocks

- Rule and kicker (written for this look):
  ```js
  vaBeat('open', (tl, el) => {
    tl.fromTo(el.querySelector('.rule'), { scaleX: 0 }, { scaleX: 1, duration: 0.8, ease: 'power2.out', transformOrigin: '0% 50%' }, 0)
      .fromTo(el.querySelector('[data-va-text="open-kicker"]'), { opacity: 0 }, { opacity: 1, duration: 0.6 }, 0.2)
      .fromTo(el.querySelector('[data-va-text="open-title"]'), { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: 1, ease: 'power3.out' }, 0.5)
  })
  ```
- Create any element with `el.ownerDocument.createElement`: the contract refuses `document.` in a scene script.
