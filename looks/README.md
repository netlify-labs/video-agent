# Looks

A **look** is a named visual style: how a video moves and is laid out. Type scale, grid, pacing, motion, transitions,
textures, how the brand's colours are used, and which ready-made HyperFrames pieces suit it. People pick a look when
they make a video (or Restyle one into another look); the run reads that look's folder and follows it.

Each look is one folder here, `looks/<id>/`. Adding one is a good first pull request: no backend code, just rules, an
example and a check that tells you what's wrong.

## Who decides what

From strongest to weakest:

1. **The request** (and comments being incorporated): anything it explicitly asks for.
2. **The brand** (`context/`, `context/brand/`): colours, logo, fonts, wording, tone, claims.
3. **The plan's brief**, when there is one: story, scenes, length, message, call to action.
4. **The look**: layout and grid, type scale and weights, pacing, motion and easing, transitions, textures, how
   colour roles are used, caption style, music mood.
5. The defaults in `video/AGENTS.md` and the HyperFrames skill.

So a look never brings its own brand colours or logo:

- **Colours.** A look says how to use the brand's roles (`bg`, `text`, `muted`, `accent`, …): "one accent per frame;
  text never on accent". It may add roles derived from them, written as **literal colours** the agent computes
  (`--va-color-glow: #ffb38a;`, "the accent mixed 40 % toward white"), never `color-mix(…)` or `var(…)`, so the
  editor's colour picker works on them.
- **Fonts.** The brand's fonts win. In v1 a look ships no fonts; for a role the brand lacks it names a CSS font stack
  that starts with a family the renderer has (for monospace: `"JetBrains Mono", ui-monospace, Menlo, monospace`).
- **Type scale.** The look owns sizes and ratios unless the brand states hard sizes.
- **Sound.** The look suggests a music mood; it never turns sound on.

## What's in a look

```
looks/<id>/
  look.json        metadata (below)
  LOOK.md          the rules the agent follows, at most 12 KB
  preview.mp4      ≤ 6 s loop, muted, H.264, 540 px on the long side, at most 500 KB (the picker's hover clip)
  poster.webp      at most 60 KB (the picker's card)
  example/         a complete composition that follows editing contract v1 and passes hyperframes check
    index.html     at most 24 KB
    summary.json
    assets/…       placeholder media only
  registry/        vendored HyperFrames items (npm run look:vendor writes these and registry.lock.json)
  assets/          textures and sound effects the agent may copy into a video, at most 1 MB
    credits.json   every file in assets/ with its licence: [{ "file", "license", "credit"?, "source"? }]
```

Limits `look:check` enforces: the files a run gets (everything except `preview.*` and `poster.*`) total at most 3 MB,
no single file over 1 MB, and `assets/` at most 1 MB (whatever the agent copies lives in that video's every later
version). Only `.md .json .html .css .js .svg .png .webp .jpg .wav .mp3 .ogg`, and binary files must really be what
their extension says. SVGs must be free of scripts, event handlers and outside links. No symlinks, no dotfiles.
Asset licences: `CC0-1.0`, `CC-BY-3.0` or `CC-BY-4.0` (with a `credit`), `OFL-1.1`, `Apache-2.0`, `MIT`, `own-work`.

### look.json

```json
{
  "id": "kinetic",
  "name": "Kinetic type",
  "description": "Big words that move with the beat. Type is the picture.",
  "tags": ["type", "social", "energetic"],
  "bestFor": ["social", "launch"],
  "aspects": ["16:9", "9:16", "1:1", "4:5"],
  "engines": ["hyperframes"],
  "colors": { "roles": ["bg", "text", "accent"], "derived": [] },
  "sound": { "musicMood": "punchy electronic, 120 bpm" },
  "registry": ["bottom-up-letters"],
  "authors": ["Your name"],
  "license": "MIT",
  "since": "2026-11-05"
}
```

- `id` is the folder name: lowercase letters, digits and dashes, up to 40. `name` up to 40 characters,
  `description` up to 160, up to 8 lowercase `tags`.
- `bestFor` lists plan templates: `launch`, `tutorial`, `social`, `changelog`, `sales`, `other`.
- `aspects` are the shapes the rules cover. Built-in looks cover all four.
- `colors` lists the roles the example uses; `derived` the ones the look computes from them.
- `recording` (optional) frames screen recordings: `{ "frame": "wallpaper" | "browser" | "device" | "none",
  "padding", "radius", "shadow", "wallpaper", "cursor": { "shape", "scale", "color" }, "ripple", "callout",
  "zoomMax" }`, or `false` when the look doesn't suit demos.
- Unknown keys are refused.

### LOOK.md

Plain rules, not adjectives: "headlines 9 % of the frame's height, at most 5 words a line" beats "big, bold
headlines". These sections are required, as headings:

1. **In one line**: what it feels like.
2. **Layout**: grid, margins and safe areas for each shape (16:9, 9:16, 1:1, 4:5), where text sits, how media is framed.
3. **Type**: scale as fractions of the frame, weights, case, tracking, line length, words on screen. Never below
   28 px for anything a viewer reads.
4. **Colour use**: how the brand's roles are used; derived roles and how to compute their literal values.
5. **Motion**: easing curves (named GSAP eases), durations, how things enter and leave, what never moves.
6. **Transitions**: how scenes hand over. A transition belongs to the scene it leads into.
7. **Texture and effects**: grain, scanlines, shadows; which vendored items and how. Seek-safe only.
8. **Pacing**: typical scene length, and how many scenes for 15, 30 and 60 seconds.
9. **Captions and text cues**: how on-screen text maps to caption cues.
10. **Sound**: music mood, and which actions get effects (only when the run has sound).
11. **Do / Don't**: short lists.
12. **Building blocks**: the vendored items, components first, and exactly how to put each into a scene.

### The example

A 10–15 second, 3–5 scene composition about the fictional product **Orbit**, with placeholder words. Runs reuse its
structure and building blocks, never its words or media. It follows editing contract v1 (`video/AGENTS.md`): every
text has a `data-va-text`, colours are `--va-color-<role>` literals on `#root`, scenes animate only inside themselves.
It loads `vendor/gsap.min.js` and `vendor/va-contract.js` (look:check supplies them) and nothing from any other URL;
no `Date.now()` or `Math.random()`.

## Building blocks: HyperFrames registry items

List items in `look.json` `registry`, **components first** (they merge into a scene by design). Blocks are separate
compositions; a look never mounts them with `data-composition-src` (their text can't be edited and a retimed scene
doesn't stretch them). Put them into a scene by hand instead:

1. Markup inside the scene's `<section data-va-beat>`; ids become classes; every CSS selector scoped to
   `[data-va-beat="<id>"]`.
2. The block's timeline rewritten inside `vaBeat('<id>', (tl, el) => …)`, selecting only inside `el`. Initial states
   are `tl.set(…, 0)` or `tl.fromTo`, never `gsap.set` outside the timeline.
3. No `document.` anywhere in a scene script (the contract refuses it). Helper elements go in the scene's markup; to
   split text into spans, create them with `el.ownerDocument.createElement`.
4. Every visible text gets its own `data-va-text` and `data-va-label`; a `<br>` becomes one element per line; code gets
   one text per line. A script never writes the text of a `data-va-text` element: text a script draws (counters,
   values) starts empty and has no text id.
5. Anything that shows time or progress scales by `data-duration / data-va-authored-duration`, so a retimed scene
   stays right. Script-driven blocks animate a tweened value, which seeks.
6. Block variables become `data-*` attributes; upstream colours become the brand's roles; drop the block's CDN GSAP
   and Google Fonts links.

Write these steps for each block in LOOK.md's Building blocks section. `docs/spikes.md` (K1) has worked examples for
the registry blocks the built-in looks use, and `spikes/k1/cases/` their code.

## Adding a look

1. `npm run look:new <id>` copies `looks/_template/` and fills in `id`, `name` and `since`.
2. Write `LOOK.md`, build `example/`, and list registry items in `look.json`.
3. `npm run look:vendor <id>` vendors them into `registry/` with `registry.lock.json` (upstream path, tag, sha256 and
   licence of each file). An item with no known licence is refused; see `scripts/lib/registry-licences.json`.
4. `npm run look:check -- --static <id>` until it passes; then `npm run look:check <id>` (needs Chrome) to run the
   example through `hyperframes check` too.
5. Render the preview and poster (the commands are below).
6. Try it on real prompts: the three in `PROMPTS.md`, on a deployment of your own (or, once the CLI's local mode
   exists, `video-agent local --look ./looks/<id> "<prompt>"`). Attach a GIF of each to the pull request.
7. Open the pull request.

### Preview commands

From `looks/<id>/example/`, with `video/`'s vendor files and config copied next to it (or in a scratch copy):

```sh
cp -R ../../../video/vendor ../../../video/hyperframes.json ../../../video/package.json .
npx --yes hyperframes@0.8.222 render --quality standard --output /tmp/look.mp4
ffmpeg -i /tmp/look.mp4 -t 6 -an -vf "scale='if(gt(iw,ih),540,-2)':'if(gt(iw,ih),-2,540)'" \
  -c:v libx264 -crf 30 -preset slow -pix_fmt yuv420p -movflags +faststart ../preview.mp4
ffmpeg -ss 1.5 -i /tmp/look.mp4 -frames:v 1 -vf "scale='if(gt(iw,ih),540,-2)':'if(gt(iw,ih),-2,540)'" /tmp/poster.png
npx -y sharp-cli@5 -i /tmp/poster.png -o ../poster.webp -f webp -q 80
rm -rf vendor hyperframes.json package.json
```

Pick the poster's moment (`-ss`) so the card reads at a glance. Raise `-crf` if the clip is over 500 KB.

## The quality bar

Review checks that a look is:

- **Original**: no imitation of a specific company's, film's or show's identity. Genres are fine ("retro CRT"); a
  named brand's keynote style isn't.
- **Readable at phone size**, in all four shapes.
- **On-brand for any brand**: it works with an orange, a blue and a near-black accent.
- **Seek-safe**: every frame renders the same whenever it's sought to; no randomness, no clocks.
- **Licensed**: every asset in `credits.json`, every registry item in the lock with its licence.

CI runs `look:check` on the `pull_request` trigger only (never `pull_request_target`), so a contributed example runs
in CI's Chrome with no secrets.
