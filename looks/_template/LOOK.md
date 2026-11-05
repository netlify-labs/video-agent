# My look

Rules the agent follows when a video uses this look. Write rules, not adjectives: "headlines 9 % of frame height, at
most 5 words a line" beats "big, bold headlines". The brand in context/ still decides colours, logo, fonts and
wording; the request wins over both. Keep this file under 12 KB.

## In one line

What it feels like, in one sentence.

## Layout

The grid, margins and safe areas for each shape (16:9, 9:16, 1:1, 4:5), where text sits, how media is framed.

## Type

The scale as fractions of frame height, weights, case, tracking, line length, and how many words are on screen.

## Colour use

How the brand's roles (bg, text, accent, …) are used. Any derived role, and how to compute its literal value from
the brand's hex ("the accent mixed 40 % toward white"). Never write color-mix() or var() in a role's value.

## Motion

Easing curves (named GSAP eases), durations, how things enter and leave, and what never moves. Seek-safe only.

## Transitions

How scenes hand over. A transition belongs to the scene it leads into.

## Texture and effects

Grain, scanlines, shadows; which vendored items to use and how. Copy any asset used into video/assets/look/.

## Pacing

Typical scene length, and how many scenes for 15, 30 and 60 seconds.

## Captions and text cues

How on-screen text maps to caption cues in this look.

## Sound

The music mood, and which actions get sound effects (only when the run has sound).

## Do / Don't

- Do: …
- Don't: …

## Building blocks

The vendored registry items (components first), and exactly how to inline each into a scene: markup into the scene,
CSS scoped to `[data-va-beat="…"]`, its timeline rewritten in the scene's vaBeat script, data-va-text on any text.
