# This video is made with Remotion

Read this next to the remotion-best-practices skill. Where they differ, this file wins: this machine has no screen,
the run has a deadline, and the editor in the browser depends on the rules below.

## How to work

- **Don't start Remotion Studio or open a browser, and ignore the skill's advice not to render.** To see your work,
  run `npx tsx scripts/engine.ts snapshot --at <seconds>` with every moment you want in one call (each call costs time
  and counts as a render) and look at the PNGs. Run `npx tsx scripts/engine.ts check` until it reports 0 errors.
  render-job renders the video: never run `npx remotion render` or `npx remotion still`.
- **Use only files in video/.** Fonts come from `assets/fonts/`, loaded with `loadFont` from `@remotion/fonts` and
  `staticFile`. Never a URL, never Google Fonts, never `fetch`, `Math.random`, `Date.now` or `process.env`.
- **Don't install packages** and don't change the files the template owns: `package.json`, `package-lock.json`,
  `remotion.config.ts`, `tsconfig.json`, `src/index.ts`, `src/Root.tsx`, everything in `src/va/`, and this file.
  `engine.ts check` refuses a changed one, and any other file at the top of video/ or src/ (a `babel.config.js`, a
  `browserslist`, a second entry point).
- **Say in your summary that contrast was reviewed by eye, not measured.**

## Editing contract v1 (Remotion)

You write only `props.json`, `summary.json`, `src/beats/<id>.tsx`, `src/layers/<id>.tsx` and files under `assets/`.
`src/registry.ts` is generated from `props.json` by `engine.ts check`; don't edit it.

| The rule | How |
| --- | --- |
| One composition, `main`, at the size and 30 fps the prompt names | Set `width`, `height` in `props.json`; `fps` is 30 |
| `props.json` is the one source of truth | Every text, colour, media item and level lives there; components read it through `va/` |
| Beats play back to back, in `props.json` order | One entry in `beats` per beat (ids `[a-z0-9-]+`), each with `duration` and `authoredDuration` in seconds |
| One component per beat | `src/beats/<id>.tsx`, a default export that renders only its own beat |
| No animation crosses a beat boundary | A beat's component unmounts at its end; a transition belongs to the beat it leads into |
| Layers span the whole video | `layers` in props, one component each in `src/layers/<id>.tsx` (backgrounds, a logo bug) |
| Every on-screen text is a text field | A key in the beat's `texts`, rendered only through `<VaText id="…" />`, each id used exactly once |
| Colours are roles | `colors` in props (`bg`, `text`, `accent`, …); use them as `var(--va-color-<role>)` |
| Media goes in slots | The beat's `media` (`kind` image or video, `src` under `assets/media/`), rendered through `<VaImage slot>` or `<VaClip slot>` |
| Music is a layer | `audio.music` with `volume`, `muted`, `fadeIn`, `fadeOut`; no sound effects or voice yet |
| Captions follow the beats | `summary.json` captions with `beat`, `textId`, `beatStart` and `beatEnd` (seconds in the beat), one cue per on-screen text |

`voice` is `null` and `sfx` is `[]` on every beat for now.
