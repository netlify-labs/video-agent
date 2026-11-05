# Terminal

## In one line

A developer's screen, cleaned up: commands typed live, code that changes line by line, one cursor, monospace everything.

## Layout

- Every scene is a terminal or editor window: a `surface` card with a 64 px title bar (three 14 px dots in `muted`,
  the file or session name), 16 px corner radius, one deep shadow. Nothing floats outside a window except an end
  card.
- 16:9: the window is 1380×800, centred, margins at least 120 px. 9:16: 960 wide, top at 18 % of the height, code at
  most 30 characters a line. 1:1 and 4:5: 960 wide, centred.
- Text inside a window is left-aligned, 44 px from its left edge, on a 46 px line grid.
- At most 12 lines of code or output on screen; a headline outside the window only on the end card.

## Type

- Font stack: the brand's monospace if it has one, else `"JetBrains Mono", ui-monospace, Menlo, monospace` (the
  renderer has JetBrains Mono; a stack that starts with `ui-monospace` renders as a sans).
- Code and output: 30 px at 1080 (2.8 % of the short side), line height 46 px, ligatures off.
- Prompt and command: 34 px, weight 600. End card: the product name at 96 px, weight 700; the command or URL under it
  at 34 px.
- Never below 28 px. Sentence case; code is as written.

## Colour use

- `bg` behind the windows, `surface` for the windows, `text` for code, `muted` for comments, prompts' `$` and line
  signs, `accent` for the one thing that matters in a scene (the command's verb, a new flag, the cursor).
- Derived roles, written as literal colours: `surface` = `bg` mixed 6 % toward `text`; `added` = a green
  (`#3fb950`) unless the brand has one; `removed` = a red (`#f85149`) unless the brand has one. Added and removed
  lines get a 12 % tint of their role as background and a 3 px bar of it on the left.

## Motion

- Typing: characters appear one by one, 0.035 s apart, `none` ease; the cursor (a `accent` block 0.6 em wide)
  follows and blinks every 0.5 s while idle.
- Output lines appear whole, 0.12 s apart. Diffs: removed lines collapse (0.55 s, `power2.inOut`), then added lines
  open (0.6 s, `power2.out`), 0.12 s apart.
- Windows enter with a fade and scale from 0.985 (0.5 s, `power2.out`); nothing else moves the window.
- No bounces, no rotations, no camera moves.

## Transitions

- Hard cuts. A scene may open by clearing its window (old lines fade 0.2 s) before typing the next command.

## Texture and effects

- None but the window shadow. No scanlines, no glow (that's Retro CRT).

## Pacing

- Typed scenes last as long as the typing plus 1.2 s to read the result; diff scenes 4–6 s.
- 15 s: 3 scenes. 30 s: 5–6 scenes. 60 s: 9–11 scenes.

## Captions and text cues

- One cue per command (from when it's fully typed) and one per diff scene (its file name and the change in words).

## Sound

- Music: minimal electronic, steady 110 bpm, low. Effects: soft key clicks while typing, only when the run has
  effects.

## Do / Don't

- Do: show real-looking commands and code for the product; keep code short and readable; end on the command or URL.
- Don't: show more than one window at once; type faster than 0.03 s a character; use emoji or icons in code.

## Building blocks

- Typed command: the command is one text element with `data-va-text`, its plain text in the HTML. In the scene's
  vaBeat, split it into spans with `el.ownerDocument.createElement` (the contract refuses `document.`), then reveal
  them: `tl.fromTo(chars, { opacity: 0 }, { opacity: 1, duration: 0.01, stagger: 0.035 }, start)`. Move the cursor
  with the last character, and blink it with `tl.fromTo(cursor, { opacity: 1 }, { opacity: 0, duration: 0.01,
  repeat: n, yoyo: true, repeatDelay: 0.49 }, at)` (a whole number of blinks, so it seeks the same every time).
- Code diff (from the HyperFrames `code-diff` block, rewritten for the contract; docs/spikes.md K1): each code line
  is one `.diff-line` with a sign span and one `data-va-text` holding token spans (`.t-kw`, `.t-fn`, `.t-str`, …,
  coloured by roles through classes), so an edit keeps the token colours. Removed lines (`.diff-del`) collapse
  height 46 → 0, then added lines (`.diff-add`) open 0 → 46.
- Code hero (instead of the registry's WebGL `code-slice-hero`): one big line of code at 56 px whose characters flip
  in with a staggered `rotateX: -90 → 0` (0.4 s, `power3.out`, 0.02 s apart), split the same way as a typed command.
