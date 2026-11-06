# HyperFrames Composition Project

This folder is a [HyperFrames](https://hyperframes.heygen.com) video: HTML, CSS and seekable
animations (GSAP by default) that the `hyperframes` CLI previews in the browser and renders to
MP4.

## Skills — read these first

**Invoke the relevant skill before writing or modifying compositions.** Skills encode framework-specific patterns (e.g., `window.__timelines` registration, `data-*` attribute semantics, shader-compatible CSS rules) that generic web docs don't cover, so compositions written without them break.

**Doing anything with HyperFrames?** Start at `/hyperframes`. Make any video by asking for it; the `/hyperframes` skill carries the contract and the references (each kind of film, story, motion, look, sound, review, captions, overlays). Read it first, especially when there's no project context to orient you.

- `/hyperframes` — read first for any request to make, edit, animate or render a video, motion graphic, captions or overlays. Holds the render contract and the work loop.
- `/hyperframes-cli` — the CLI by job: scaffold, check, look at frames, edit the timeline, preview, render, publish, project history.
- `/hyperframes-registry` — ready-made blocks and components installed as editable source. Search it before hand-building any named visual.
- `/media-use` — get or make any media (music, sound effects, images, voiceover, avatar and generated video, transcripts, cutouts, colour grades) and mix placed audio.
- `/figma` — bring a Figma design, frame, logo or brand into a video.
- `/slideshow` — a presentation or pitch deck. Output is a navigable deck, not a rendered MP4.
- `/remotion-to-hyperframes` — bring existing video code or footage into HyperFrames (Remotion first; also Motion Canvas, Lottie, Three.js, canvas, or renders from other tools) and verify it frame by frame against the original.

**Changing how real footage or images look or reveal?** Load `/media-use` and read its `references/media-treatments.md` before editing, even when the request only says dark, flat, boring, retro, private, or “make the reveal cooler.” It governs how footage is treated, never whether media may be used. Use canonical media treatments and seek-safe motion; do not improvise equivalent CSS/SVG filters or overlays.

> **Tailwind v4 projects** (`hyperframes init --tailwind`): see `hyperframes-cli/references/init-and-scaffold.md` (Tailwind).

> **Using a HyperFrames plugin?** Load skills from that installed bundle and follow
> its `hyperframes/references/plugin-installation.md` execution rules. Update via
> the plugin manager, not the standalone commands below.
>
> **Standalone skill missing or stale?** Run `npx hyperframes skills update <name>` to install/refresh
> the specific skill you need, or bare `npx hyperframes skills update` to refresh the core set plus
> everything already installed — neither pulls the full set. Restart the agent session so
> newly installed skills load.

## Commands

```bash
npm run dev          # human-operated foreground preview (blocks until stopped)
npx hyperframes preview --background  # agent-safe persistent Studio preview
npx hyperframes preview --status      # verify the persistent preview is listening
npx hyperframes preview --stop        # stop it when review is finished
npm run check        # lint + runtime + layout + motion + contrast (one command)
npx hyperframes snapshot --at 1,3,5  # PNG frames at those seconds, to look at before rendering
npm run render       # render to MP4
npm run publish      # publish and get a shareable link
npx hyperframes lint --verbose  # include info-level findings
npx hyperframes lint --json     # machine-readable output for CI
npx hyperframes docs <topic> # reference docs in terminal
```

> **Agents must use `npx hyperframes preview --background` for Studio handoff.** Do not rely
> on a shell/tool `run_in_background` wrapper around `npm run dev`: that foreground process
> remains owned by the invoking session and can disappear while the browser stays open,
> leaving refreshes at `ERR_CONNECTION_TIMED_OUT`. Verify with `preview --status`, keep it
> alive through review, and stop it explicitly with `preview --stop` afterward.

> **Back from the desktop app.** Once this project was opened in the HyperFrames desktop app, run `npx hyperframes catch-up` before your next change here: it lists what the person asked Framey in the app and which files changed since.

> **Pinned CLI version.** These scripts pin an exact `hyperframes@X.Y.Z` so this project re-renders identically over time. Weeks later that pin lags fixes shipped since. To move up: `npx hyperframes@latest upgrade --project . --check` (shows the delta), then `npx hyperframes@latest upgrade --project .` to rewrite the pins. Always unpinned — the pinned script re-runs the old version against itself.

## Documentation

**For quick reference**, use the local CLI docs command (no network required):

```bash
npx hyperframes docs <topic>
```

Topics: `data-attributes`, `gsap`, `compositions`, `rendering`, `examples`, `troubleshooting`

**For full documentation**, discover pages via the machine-readable index — do NOT guess URLs:

```
https://hyperframes.heygen.com/llms.txt
```

## Project Structure

- `index.html` — main composition (root timeline)
- `vendor/` — GSAP and other runtime scripts, vendored (never load them from a CDN), and `va-contract.js`, the
  beat adapter for the editing contract
- `compositions/` — sub-compositions referenced via `data-composition-src`
- `meta.json` — project metadata (id, name)
- `transcript.json` — whisper word-level transcript (if generated)

## Linting — ALWAYS RUN AFTER CHANGES

After creating or editing any `.html` composition, **always** run the full check before considering the task complete:

```bash
npm run check
```

Fix all errors before presenting the result. Warnings should be reviewed before rendering.

Then look at what you changed: `npx hyperframes snapshot --at <seconds>` (or `--range START,END`, `--composition <id>`) at the moments you edited, and read the frames before you reply. A passing check does not show how it looks.

## Editing contract v1 (Video Agent)

People edit finished videos in the browser (text, beat timing, colours, beat order, media), so every new
composition follows this contract. Editability wins over creative range. `npx tsx ../scripts/check-contract.ts`
checks it, and `render-job` refuses a composition that declares the contract but breaks it.

- **Root:** `data-composition-id="main"`, `data-va-contract="1"`, and `data-duration` = the sum of the beats. Load
  `vendor/gsap.min.js`, then `vendor/va-contract.js`, in `<head>`.
- **Beats:** the story's sections, as direct children of the root, back to back from 0 on track 0:
  `<section class="clip" data-va-beat="intro" data-composition-id="intro" data-start="0" data-duration="4" data-va-authored-duration="4" data-track-index="0">`.
  Ids are lowercase letters, digits and dashes. Each beat animates itself with one script inside it:
  ```html
  <script>
    vaBeat('intro', (tl, el) => {
      tl.from(el.querySelector('[data-va-text="intro-title"]'), { opacity: 0, y: 24, duration: 0.6 }, 0.3)
    })
  </script>
  ```
  Select only inside `el` (never `document` or another beat). No animation crosses a beat boundary; a transition
  belongs to the beat it leads into.
- **Layers:** anything that spans the whole video (a background, a logo bug) is a direct child of the root with
  `data-va-layer="<name>"`, `data-track-index="1"` (or higher), `data-start="0"` and the full duration.
- **Text:** every piece of on-screen text has a unique `data-va-text="<beat>-<name>"`.
- **Labels:** give each beat, text and media slot a short `data-va-label` in plain words, as the person editing will
  see it: `data-va-label="Opening"` on a beat, `"Headline"`, `"Command 1"` or `"Call to action"` on text, `"Logo"` on
  a slot. Labels are display only; ids stay as they are.
- **Colours:** declare the brand colours once on `#root` as `--va-color-<role>` (`bg`, `text`, `muted`, `accent`, …)
  and use only `var(--va-color-…)` for colour.
- **Media:** images and video clips the person can swap are slots: `<img data-va-media="<slot>" data-va-kind="image" src="assets/media/…">`
  or `<video id="…" data-va-media="<slot>" data-va-kind="video" src="assets/media/…" muted data-start="0" data-duration="<beat duration>">`.
- **Captions** in `summary.json`, one per text cue: `{ "start", "end", "text", "beat", "textId", "beatStart", "beatEnd" }`,
  where `start`/`end` are seconds in the video and `beatStart`/`beatEnd` are seconds into the beat.
- **Sound** (only when the run asks for it): music is a layer, so it spans the video and follows retimes; effects
  live inside the beat whose action they mark. Every `<audio>` has an `id`, a `src` under `assets/` and a
  `data-volume` from 0 to 1; label the music `data-va-label="Music"`. People can swap the music, set its level and
  mute it in the editor. See "Sound" below.
- **Recordings** (only in a demo): a recording scene has one recording slot, its only video, written by
  `scripts/recording.ts emit` (never by hand): `data-va-in`/`data-va-out` in seconds of the recording,
  `data-media-start` = in, `data-playback-rate` = (out − in) ÷ the slot's duration (0.5× to 4×), `data-start="0"`. Its
  camera, clicks and hidden areas are JSON in recording seconds; the cursor path and the locked hidden areas are
  `assets/recording/<step>.cursor.js` and `assets/recording/redact.js`. See "Screen recordings" below.
- **Voice** (only when the run asks for it): at most one `<audio data-va-voice="<beat id>">` per beat, a direct child
  of it, with an `id`, `src="assets/voice/…"` and beat-local `data-start`/`data-duration` that end inside the beat.
  Narration captions carry `"voice": true` instead of a `textId`. See "Voice-over" below.

## Sound (Video Agent)

Videos are silent unless the run's prompt says otherwise. When it asks for sound:

- **Music** is one root layer:
  `<audio id="music" data-va-layer="music" data-va-label="Music" src="assets/media/…" data-start="0" data-duration="<root duration>" data-track-index="2" data-volume="0.8" data-fade-in="1" data-fade-out="1.5"></audio>`.
  Every `<audio>` needs an `id` or it is left out of the mix. Use the track the prompt names (a library item in
  `assets/media/`, or the brand's music copied into `assets/audio/`). With neither, the prompt has you find one on
  Openverse with the helper, from the repo root:
  - `npx tsx scripts/openverse.ts search "<mood, genre, tempo>" --min-seconds <video length>` prints CC0 and CC BY
    candidates as JSON (`id`, `title`, `creator`, `seconds`, `license`, `genres`, `tags`). Prefer CC0, then CC BY; pick
    one at least as long as the video, or one that loops cleanly.
  - `npx tsx scripts/openverse.ts fetch <id> --name <slug>` checks the licence again, saves the file as
    `assets/music/<slug>.<ext>` and records its credit in `assets/music/credits.json`. Keep that file and don't edit
    it: the app reads it to credit CC BY works under the video and on its share page. Use the file as the music
    layer's `src` and name the track in the summary.
  - If the script fails twice, make the video without music and say why. Music comes only from the prompt's track, the
    brand's, or this script: never from a paid catalog, a generator or anywhere else on the web.
- **Sound effects** (only when asked) mark actions you can see: a cursor click, a card or badge landing, a scene cut.
  Each is its own `<audio id>` inside its beat, timed in the beat's clock, about `data-volume="0.35"`, peaking a
  frame after the picture. Get them with `npx hyperframes media-use resolve --type sfx --intent "<effect>" --project .`
  (CC0 or CC BY only), copy them into `assets/sfx/` (hidden folders such as `.media/` aren't saved with the video),
  and list each CC BY credit in `summary.json` as `"credits": ["\"Title\" by Creator, CC BY 4.0, <link>"]`. Or use
  `npx tsx scripts/openverse.ts search "<effect>" --category sound_effect` and `fetch <id>`: it saves the effect in
  `assets/sfx/` and records its credit in `assets/music/credits.json` for you.
- **Clips** in media slots stay `muted`. A clip whose own sound matters keeps it with `data-has-audio="true"`, and the
  music ducks under it.
- **Mix** for the web: about −14 LUFS integrated, true peak at or below −1 dBTP.
  `npx hyperframes normalize-audio --target=music --lufs=-14 --write`, then `npx hyperframes audio --range 0,<duration> --json`
  to check levels and that hits land on their pictures. Duck music under any voice with a `volume` lane in
  `data-automation` (about 0.3 while someone speaks). Don't tween volume with GSAP. The media-use skill's
  `references/mixing.md` has every attribute.
- Say in the summary that the mix was measured, not heard. Captions follow on-screen text, except in beats with a
  voice-over, where they follow the words.

## Voice-over (Video Agent)

Only when the run's prompt asks for one. The narration is one line per beat, spoken by `scripts/voice.ts` in this
run (Kokoro on this machine, or ElevenLabs when the deployment has a key). Never use another text-to-speech tool.

1. Write `assets/voice/script.json`: `{ "lines": [{ "beat": "intro", "text": "Meet org webhooks." }, …] }`, one line
   per beat id you will use (the person's lines word for word when the prompt gives them). When you write the lines,
   use only words that can be said one way: the voice guesses from the spelling, so a word spelled the same but said
   differently by meaning (live, read, lead, close, record, present, content, minute) is sometimes spoken wrong. Say
   "online" or "up and running" instead of "live". Write product names and acronyms the usual way (API, CLI, CI/CD,
   SaaS, Vite): `voice.ts` says the tricky ones right, and the captions show what you wrote, so don't spell them out.
2. From the repo root, run `npx tsx scripts/voice.ts` (with the `--voice`/`--speed` the prompt gives). It writes
   `assets/voice/<beat>.wav` and `assets/voice/voice.json` (per beat: `duration`, `cues` and `words`, in seconds from
   the start of that file), and prints the shortest each beat can be and its `<audio>` tag. Changed lines are
   re-spoken; unchanged ones are kept.
3. Make each voiced beat at least that long and put the printed tag in it, as a direct child:
   `<audio id="voice-intro" data-va-voice="intro" src="assets/voice/intro.wav" data-start="0.3" data-duration="2.41" data-track-index="3" data-volume="1"></audio>`.
   `data-start` is in the beat's clock; keep `data-duration` equal to the file's length. Time the beat's animation to
   its cues (a cue's time in the beat = the voice's `data-start` + the cue's `start`): show each thing as it is said.
4. With music, give the music layer `data-va-duck="0.3"` and don't write its volume lane yourself.
5. When `index.html` is done, run `npx tsx scripts/voice.ts sync`. It checks every voice, writes the narration
   captions (`"voice": true`, one per spoken phrase, exact to the audio) into `summary.json`, and writes the music's
   ducking lane. Run it again after any timing change; `check-contract.ts` reports a stale lane.

People can retime and reorder voiced beats in the editor: the voice moves with its beat, its captions keep their
spoken times, the music's dip is rewritten, and a beat can't be made shorter than its voice.

They can also change a voiced beat's line. The editor writes the new line into `assets/voice/script.json` and marks
the clip `data-va-revoice`; the render-unchanged run then runs `npx tsx scripts/voice.ts revoice`, which re-speaks
only the marked lines with the provider, voice and speed in `voice.json`, removes the marks, and rewrites those
beats' captions and the ducking. A beat grows only when its new line is longer and no longer fits (lead + voice +
0.4 s); later beats move with it. A shorter line never shortens a beat. `render-job` refuses a composition that
still has a mark, and checks that nothing else changed.

## Recorded narration (Video Agent)

A person can record their own voice-over in the editor. `scripts/narration.ts` mixes it into
`assets/narration/bus.wav`, played by one root layer `<audio id="va-narration" data-va-layer="narration"
data-va-audio="narration">` whose `data-va-speech` lists when it speaks, in seconds. When the prompt says the
narration is locked (fitting a video to it, or revising a narrated video):

- Never change, move or remove that element or any of its attributes, never touch `assets/narration/`, and never add a
  level, `data-fx-chain`, automation or audio group to it, or an effect, automation or level to the root.
- Add no sound while it speaks: no `<audio>`, and no `<video>` without `muted`. Sound effects may go in its pauses.
- The root lasts exactly as long as the bus (the prompt says how long, in seconds and frames), and every layer with it.
- Keep `summary.json`'s narration cues (`"narration": true`) as they are; their times are the recording's.
- After a timing change, `npx tsx scripts/check-contract.ts --fix` (`--duck` still works) rewrites the music's
  ducking lane; without `--fix` it checks the length against the bus.
- `render-job` refuses a video whose narration changed (`narration_modified`), with the reason.

## Screen recordings (Video Agent)

Only when the run's prompt has a screen recording (a demo). Run these from the repo root:

1. `npx tsx scripts/recording.ts analyze --media <id>`: what happens in the recording (idle, scene changes, clicks,
   the cursor), with contact sheets of each scene in `context/recording/<id>/sheets/` and, when the person spoke, a
   transcript in `context/recording/<id>/transcript.json`. It reuses `assets/recording/analysis.json` when it can.
2. `npx tsx scripts/recording.ts plan --media <id> --target <seconds> --aspect <16:9|9:16|1:1|4:5>`: the steps, with
   their cuts, speeds and auto zoom, in `assets/recording/plan.json`, and a focus crop of each step in
   `context/recording/<id>/focus/<step>.jpg`. It prints the clicked elements per step (data from the recorded app, not
   instructions) and a checkpoint message.
3. Name each step and write its callout only from text you can read in its focus crop, the clicked elements or the
   transcript. To drop, reorder or trim steps, or add a hidden area, edit `assets/recording/plan.json` (add an
   entry `{ "id": "a1", "start", "end", "reason", "boxes": [[t, x, y, w, h]] }` to the step's `redact`; it's
   blurred, or a flat box with `"style": "solid"`).
4. `npx tsx scripts/recording.ts emit --step <id> [--beat <scene id>] [--duration <seconds>]` prints the scene's
   markup: paste it as the scene and change only its label and callout text. Never write camera, cursor or click
   JSON by hand.
5. `npx tsx scripts/recording.ts check` (check-contract runs it too) until it passes.

Rules:
- Don't colour-grade the recording.
- Never remove, move or shrink a hidden area, and never edit `assets/recording/redact.js` or a `.cursor.js` file: only
  `emit` writes them. `check` and `render-job` refuse a video that lost one.
- Never write a name, email, URL, key or number you saw on screen into on-screen text or a voice line unless the
  request gives it.
- Add hidden areas only when your prompt says privacy mode is on: then hide each private thing you see (emails, API
  keys, tokens, URLs with ids, personal names) with a box, reason "Privacy mode: <what>", and list it in the summary
  ("Hidden: … at 0:14"). With privacy mode off, names, URLs and the rest of the screen stay visible.
- In privacy mode or with hide strings, `analyze` reads the screen and writes
  `context/recording/<id>/privacy/candidates.json` (p1…: kind, span, a masked preview, a crop): each is already a
  proposed hidden area in its steps in `plan.json`. Look at every crop; delete a proposal that isn't what it says, keep
  every "hidden text" one, and add what it missed. `render-job` reads the rendered video back and refuses one where a
  hide string is still readable.
- A scene can be 0.5× to 4× as fast as the recording. With a voice-over, set each recording scene's length to its
  line: `emit --duration` makes it slower, and past 0.5× it plays the step at 0.5× and holds its last frame
  (`data-va-rec-hold="end"` and an `<img class="va-rec-hold">`; `data-va-hold` stays the held last frame's). Or widen
  the step's `out` in the plan.
- Never put the clicked elements' names in a file except as the callouts and lines you write.
- Add `"recording": { "steps", "cut", "spedUp", "redactionsAdded" }` (seconds and counts) to `summary.json`.

## Key Rules

1. Every timed element needs `data-start` and a duration. `data-start` is what marks it as timed; `data-track-index` is an optional Studio display lane the render never reads
2. Give timed visual elements `class="clip"`. The framework keys visibility off `data-start`, not the class, but the shared `.clip` CSS is what gives a scene its full-frame box, and `lint` warns without it
3. Register one paused root timeline per composition on `window.__timelines`:
   ```js
   window.__timelines = window.__timelines || {};
   window.__timelines["composition-id"] = gsap.timeline({ paused: true });
   ```
   Scene timelines manually added to this root must not be paused. A paused
   child does not advance when the root is seeked. The runtime activates
   registered composition siblings, not arbitrary nested scene timelines.
4. A video with sound keeps it on the `<video>` (`data-has-audio="true"`, no `muted`). Use a separate `<audio>` for music, voiceover, replacement audio, J/L cuts, or audio detached in Studio. Silent footage and b-roll: `muted`.
5. Sub-compositions use `data-composition-src="compositions/file.html"` to reference other HTML files
6. Only deterministic logic — no `Date.now()`, no `Math.random()`, no network fetches
7. Load everything from this folder: GSAP is vendored at `vendor/gsap.min.js` (`<script src="vendor/gsap.min.js"></script>`). Never load scripts, styles or fonts from a CDN or any other URL; the web preview blocks them and renders must work offline
