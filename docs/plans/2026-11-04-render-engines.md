# Pluggable render engines (HyperFrames by default, Remotion opt-in): plan

- **Status:** draft 4 (2026-11-04), with the owner's decisions applied. Three review rounds:
  1. an independent review by Fable 5.1 ("sound with changes");
  2. the cross-plan seam review of the six 2026-11-04 plans;
  3. a remote review by Fable 5.1 (high effort) in a Netlify Agent Run, at commit `19740d8` ("sound with changes").

  Every claim was checked against the code and Remotion's docs before being folded in, and the review log is §15. Not
  built yet, and no beads.
- **Owner decisions (2026-11-04) shape the plan:**
  - Build the engine, off and hidden by default.
  - Netlify runs **one proof of concept** (the POC, §1.1) and buys no license unless the videos are outstanding.
  - Deployers who turn Remotion on bring their own license.

  So the order is: Phase 1 (the seam, no Remotion), then Phase 2 (Remotion authoring, built off and hidden), then the
  POC, then a decision. Phases 3–4 (editing, sound) happen at Netlify only if the POC leads to a license (§11).
- **Ask (owner, 2026-11-04):** "see if we can use Remotion and Remotion skills to create different video styles",
  picked from the idea-wizard list as #3 ("love it, let's do it"). Make the engine that writes and renders a video
  pluggable. HyperFrames stays the default. Remotion is opt-in, never on by default, and gated on its license.
- **Owner, on Remotion (2026-11-04):** "We want to add this feature but probably won't use it ourselves. It's there
  for people who want that route. Maybe hidden for now. I want to build it and run it once to see how it works. We
  won't buy a license unless it makes incredibly amazing videos." 
- **Builds on:** the run (`src/domain/prompt.ts`, `scripts/prepare-run.ts`, `scripts/render-job.ts`), finalize and
  bundles (`src/domain/finalize.ts`, `src/domain/bundles.ts`), editing contract v1 (`src/lib/contract.ts`,
  `video/AGENTS.md`), the editor and its sandboxed preview (`src/domain/edits.ts`, `ui/src/pages/Edit.tsx`,
  `netlify/edge-functions/preview.ts`, `src/preview/bridge.js`), and runner setup through `netlify-agent-kit`
  (`package.json` → `netlifyAgent`).
- **Sibling plans (2026-11-04).** The roadmap's "Shared rules all six follow" (`docs/plans/2026-11-04-roadmap.md`,
  rules 1–10) apply, and this plan cites them by those numbers. This plan owns four seams:
  - the Engine interface and `EngineCapabilities`;
  - the name `src/lib/contract-core.ts`;
  - the `scopeCheck` hook;
  - the order of prepare-run's steps (§4.3).

  | Plan | How it touches this one |
  | --- | --- |
  | Looks (`2026-11-04-looks.md`) | Owns the engine choice rule (a look lists its engines). |
  | Regenerate a beat (`2026-11-04-regenerate-beat.md`) | Uses `scopedRevision` and implements the HyperFrames `scopeCheck`. |
  | Screen-recording demo (`2026-11-04-screen-recording-demo.md`) | Adds its edit ops and the `recording` capability; HyperFrames-only in v1. |
  | CLI and SDK (`2026-11-04-cli-and-sdk.md`) | Owns the `features` registry, the SDK and CLI surface, local mode and the `/docs` pages. |
  | GitHub Action (`2026-11-04-github-action.md`) | Has no `engine` input; the engine follows the look (engine choice rule, §4.2). |

---

## 1. What we're building and why

Today every video is a HyperFrames composition: HTML, CSS and GSAP timelines in `video/index.html`, rendered by
`npx hyperframes render`. That works well (docs/spikes.md S1: "quality is good", 3–8 minutes and 90–210 credits a
video) and it's Apache-2.0, so the template can be MIT and anyone can deploy it.

The owner wants more range in how videos look, and asked about Remotion specifically. Remotion is a React framework for
video with a large community, a maintained set of agent skills, and a React ecosystem behind it: `@remotion/three` for
3D, a maps skill, Lottie, chart libraries. Some looks are much easier to write in React than in hand-written HTML and
GSAP: 3D product shots, animated maps, data-heavy charts.

So the goal is:

1. **An Engine seam.** A video records its engine, and everything engine-specific (the prompt's steps, the project
   template, the skills, the check, the contract check, snapshots, the render, the editing surface, the browser
   preview) sits behind an interface. HyperFrames is the first implementation. **Phase 1 changes no behaviour**, and
   it refactors only what a second consumer (local mode, the regenerate-beat plan) needs right away.
2. **Remotion as a second engine, opt-in.** An admin turns it on deliberately and records the organisation's
   Remotion license tier. A video then records `engine: "remotion"`, and every run for it uses Remotion.
3. **Editing parity where it's cheap.** A Remotion video keeps editing contract v1's model (beats, text, colours,
   media, audio), so the browser editor works on it with no new UI. The Remotion form is easier to edit than ours: the
   editable values live in one `props.json` that the code reads, so an edit changes data, not markup.

What it isn't: a way to run arbitrary Remotion projects people upload (§10), a license workaround, or a change to the
default. A fork that never turns Remotion on never installs a Remotion package.

**Hidden by default.** With `ENGINES` unset, nothing about Remotion appears anywhere: the Admin switch, the engine
select, the `/setup` row, `GET /api/v1/engines` (which then lists only HyperFrames) and the `engines` feature string
are all absent. The README describes it under "Experimental: the Remotion engine (bring your own license)".

### Why Remotion has to be opt-in (the license, plainly)

Remotion is source-available, not open source. The license in force today is the 4.x `LICENSE.md` (in the npm
package `remotion@4.0.540`), which says it "will slightly change" in Remotion 5.0. It has two tiers:

- **Free License:** individuals, for-profit organisations with up to 3 employees, non-profits, and anyone
  "evaluating whether Remotion is a good fit, and … not yet using it in a commercial way".
- **Company License:** everyone else. remotion.pro and the Terms list:
  - **Remotion for Automators:** $0.01 a render, $100 monthly minimum.
  - **Remotion for Creators:** $25 a seat a month.
  - **Enterprise:** $500 monthly minimum.

**What counts as automation.** The Terms call code that calls the render functions an automation, and they name
"prompt-to-video tools, automated video pipelines, embedding the Remotion Player" as Automators use. That's this
app. Free License users may build automations without buying renders.

**What counts as a render.** "The successful generation of a video, audio, GIF, PDF or still image." Studio and
Player previews don't count. So every snapshot still the agent renders counts (§5.4).

**Two texts, and we follow the stricter.** The package we'd install (`remotion@4.0.540`) ships the v4 `LICENSE.md`
quoted above. remotion.dev also publishes **Terms and Conditions v5.0**, which the Company License is bound to and
which are stricter about evaluation:

- evaluation "is not intended for production use, long-term internal use, or ongoing business operations";
- "the decision to use the Remotion Software in one's technology setup marks the end of the evaluation phase";
- a license is needed once the personnel of all parties involved in operating Remotion reaches four or more;
- a service that lets end users upload their own Remotion code is not acceptable without Remotion's prior written
  approval.

Where the two differ, this plan follows the v5.0 Terms.

**Who must pay.** Eligibility depends on **total headcount**, not on how many people use Remotion (License FAQ).
**People you work with on the project count already:** the FAQ adds collaborating teams' headcount to yours for the
threshold. 5.0 writes contractors into the license text itself (v5.0 migration guide).

**Reporting.**
- **When it's required:** server-side renders send a telemetry event only when `licenseKey` is set. From 5.0 that's
  mandatory for Remotion for Automators: a real key for Company License holders, or the literal `"free-license"` to
  declare the free tier (remotion.dev/docs/licensing, /docs/5-0-migration).
- **What it sends:** the license key and the event type, and whether the render was production or development
  (`isProduction`).
- **What it doesn't send:** the host domain and the IP address are recorded only for `@remotion/web-renderer`
  (client-side rendering), which this plan doesn't use. It sends no video content.
- **Retention:** Remotion keeps the data indefinitely.
- **Never blocks a render:** a failed telemetry request doesn't fail the render.

Most companies that deploy this template, including Netlify, need a Company License to turn Remotion on for real
use (Netlify's one evaluation is §1.1). HyperFrames
(Apache-2.0) has no such condition, so it stays the default. The README, `/setup` and the Admin page say plainly who
must pay before anyone can turn Remotion on (§7).

**Package licenses** (npm `license` fields, checked 2026-11-04):

| License | Packages | Needed for |
| --- | --- | --- |
| Remotion License ("SEE LICENSE IN LICENSE.md") | `remotion`, `@remotion/cli`, `@remotion/renderer`, `@remotion/bundler`, `@remotion/player` | Rendering and the editor preview |
| MIT | `@remotion/captions`, `@remotion/zod-types`, `@remotion/licensing`, `@remotion/fonts`, `@remotion/media-utils` | Helpers |

The `remotion-dev/skills` repository has no license (GitHub reports `license: null`, there's no LICENSE file, and
its `package.json` is `private`). It mirrors `remotion-dev/remotion/packages/skills`, which is under the Remotion
License, so we don't vendor it (§8).

### 1.1 Netlify's one proof of concept: what the license allows, and what it doesn't

Netlify is a company far above the 3-person threshold. Under Remotion's terms, Netlify may use Remotion for free only
while **evaluating whether it's a good fit, not yet using it commercially**. Under the v5.0 Terms that excludes
"production use, long-term internal use, or ongoing business operations", and evaluation ends once Netlify decides to
use Remotion.

**What we read as covered: one bounded evaluation.**
- **A handful of developers** trying Remotion on their own machines (spikes E3–E5) to judge whether it's a good fit.
- **A single POC session:** spikes E1 and E2, run together once (§11). A small number of Agent Runner runs make test videos, on a scratch Netlify
  project that isn't our production deployment, with `ENGINES` set only there.
  - Every Remotion render is a **development render**: `licenseKey: "free-license"` plus `isProduction: false` where
    the API allows it. "free-license" declares Free License eligibility, and evaluation is one of its eligibility
    cases, so it's the accurate value. Remotion's docs say `isProduction` works only with a license key; if it's
    refused with `"free-license"`, the POC renders without it and says so.
  - The videos are for the owner to judge, and are never published or used commercially.
  - Then it stops.

**What isn't covered, so Netlify doesn't do it without a license:**
- turning Remotion on for our production deployment's users (`ENGINES` stays unset there);
- recurring Remotion renders at Netlify: CI jobs that render, repeated live tests in later phases, or keeping the scratch
  project around to make videos;
- any use of POC videos in marketing, sales or docs;
- building Phases 3–4 by rendering with Remotion again (§11).

**What's still uncertain, and why it's a question, not a decision.** Shipping a Remotion integration in an open-source
template Netlify publishes is arguably part of Netlify's business, even if Netlify never renders a video with it.
- The v4 text doesn't address that case.
- The v5.0 Terms' "technology setup" wording could be read to end evaluation as soon as the engine is merged.

We don't redistribute Remotion: runs install it from npm, and our `va/` runtime is our own code. But the FAQ says to
ask Remotion when in doubt, so **owner question 1 is to ask Remotion (hi@remotion.dev) for written OK** for a one-off
evaluation and for publishing the integration, before the POC session runs. If Remotion says no, the POC waits for a
license decision, and the code can still be built and unit-tested without rendering (§9).

**What deployers do.** Each deployer who turns Remotion on decides their own license status and records it in the
Admin dialog (§7). Video Agent never buys or checks a license for anyone.

---

## 2. Facts this plan relies on (checked 2026-11-04)

**How a run works today**

- **The prompt names HyperFrames throughout:**
  - "Read the hyperframes skill and follow its work loop" and "Run `npx hyperframes check` in video/ until it reports
    0 errors" (`src/domain/prompt.ts:230`, `:234`);
  - the GSAP and no-CDN rule (`:232`);
  - the sound rules (`:264–335`, `npx hyperframes audio`, `normalize-audio`, `media-use`);
  - the render-unchanged steps (`:398`, `:451`) and fit-to-narration (`:579–584`).

  `PROMPT_TEMPLATE_VERSION = 16` (`src/domain/prompt.ts:8`) isn't in the prompt text. It's recorded on the attempt
  (`src/domain/reconciler.ts:457`), and `test/remix-run.test.ts:176` pins the literal `16`.
- **The repo-level run rules say the same:** "Read the hyperframes skill … Run `npx hyperframes check` in `video/`"
  (`AGENTS.md:8`) and "Keep the editing contract ("Editing contract v1" in `video/AGENTS.md`)" (`AGENTS.md:12`).
- **Runner setup is `netlify-agent-kit@0.4.0`**, configured in `package.json` under `netlifyAgent`:
  `{ "hyperframes": { "version": "0.8.222", "dir": "video" }, "files": [BRAND_ZIP_URL → context/brand] }`.
  - Its `hyperframes` preset installs FFmpeg/FFprobe, the `hyperframes`, `hyperframes-cli` and `media-use` skills,
    and HyperFrames' headless Chrome.
  - It can install skills from `github:<owner>/<repo>#<sha>`, unpack `files`, and run extra commands (`run`) after
    everything else (`node_modules/netlify-agent-kit/README.md`).
  - `files` entries can be skipped when an env var is unset (`optional: true`). Skill sources can't be gated. A `run`
    command can gate itself by reading env.
- **`scripts/prepare-run.ts`:**
  - restores what the run manifest names: a parent's source archive for revisions, a frozen bundle for
    render-unchanged and fit runs;
  - downloads library media into `video/assets/media/` (`scripts/prepare-run.ts:438`);
  - writes `.render/run-manifest.json` for render-job.
- **The run manifest:** run kinds are `author | revision | render_unchanged | author_from_frozen`
  (`src/lib/run-manifest.ts:25`). The manifest is version 1 (`RUN_MANIFEST_VERSION`, `:19`). `verifyRunManifest`
  (`:295`) rejects any `v !== 1` and unknown kinds (`:307`), checks the fields it knows and ignores unknown ones, so
  optional new fields need no version bump.
- **`scripts/render-job.ts`:**
  - checks the contract when the composition declares it (`:85–97`) and verifies frozen bundles and narration;
  - renders with `npx -y hyperframes render --quality <q> --output <mp4>` (`:202`);
  - makes the poster (`:275`), GIF, captions VTT, narration outputs and preview variants (`:344`) **with ffmpeg on
    the MP4**, then uploads;
  - reports a manifest that names the HyperFrames version (`:410`).

  Everything after the render is engine-independent. `runStreaming` (`scripts/lib/run-tools.ts:138`) spawns the
  command and keeps an 8,000-character tail of its output for errors.
- **Archives leave out** `node_modules`, dot-folders, `renders/` and stray top-level MP4s
  (`src/lib/bundle-manifest.ts:32–40`, used by `videoTarArgs` in `scripts/lib/run-tools.ts:25`).

**Editing**

- **Editing contract v1 is `src/lib/contract.ts`**, parsed with parse5 (inert: nothing executes) and shared by the
  browser and the server.
  - The editor's model is `Composition` (`:140`): `duration`, `colors`, `beats`, `layers`, `audio`, `narration`.
  - Edits are a closed union of 8 `EditOp`s (`:1003–1016`).
  - `applyEdits` (`:1087`) re-applies them on the server before a render-unchanged run.
  - The private helpers `relayout` (`:1026`) and `syncCaptions` (`:1060`) keep durations and captions in step. They
    work on the parse5 `Doc` and aren't exported.
  - The contract is fixed at 30 fps (`FPS = 30`, `:66`).
- **Contract detection:** finalize stores `contract: 1 | null` from the bundle's check (`src/domain/finalize.ts:281–284`).
  `contractOf` (`src/domain/bundles.ts:79`) reads `index.html` and `summary.json`. It has two callers:
  `ensureBundle` (`bundles.ts:136`, the call at `:179`) and edit saves (`src/domain/edits.ts:409`). The DTO's
  `editable` is `status === 'ready' && contract === 1` (`src/domain/videos.ts:898`).
- **Drafts:** `openEdit` returns `readComposition(load(html), narration)` (`src/domain/edits.ts:320`), and the editor
  holds that `composition` (`ui/src/pages/Edit.tsx:68`, `:524`). A draft render is a `render_unchanged` run (S4:
  about 34 credits and 2–3 minutes, flat).
- **The preview:**
  - It is the composition itself, served by `/preview/{jobId}/v{n}/{cap}/{path}` with a CSP that allows only the
    capability path, `sandbox allow-scripts` and `default-src 'none'`.
  - The CSP (`previewCsp`, `src/lib/preview.ts:57–71`) also allows `'unsafe-inline'` scripts and styles, and has no
    `worker-src`, so workers fall back to `default-src 'none'`.
  - The edge function injects the vendored HyperFrames runtime first and `src/preview/bridge.js` last
    (`scripts/build.ts:157–169` copies the runtime from the pinned package).
  - The bridge sends `ready`, `time`, `click`, `error`, `edits-applied` and `mix-applied`, and accepts `play`,
    `pause`, `seek`, `apply-edits` and `mix` (`src/preview/bridge.js:1–5`).

**Data and settings**

- **No engine column yet:** `versions` has `contract`, `mode` and `sound` (`db/schema.ts:91–115`; `VersionRow` in
  `src/domain/types.ts:263–290`).
- **Admin settings** carry feature switches without a redeploy, such as `remixEnabled` (`db/schema.ts:34`) and the
  narration settings (`src/domain/types.ts:113–131`).
- **The deadline:** `AUTHORING_DEADLINE_MIN` (default 22, `src/deps.ts:92`). The runner gets
  `deadlineMs = (authoringDeadlineMin + 3) * MIN` (`src/domain/reconciler.ts:174`). Runner setup (the `npm install`
  that triggers `netlify-agent-kit`) happens inside the same run, before the agent starts. E1 measures whether it
  counts against `deadlineMs`.

**Remotion (web and npm, 2026-11-04; Sources at the end)**

- **Version:** `remotion@4.0.540`, with `@remotion/cli`, `@remotion/renderer`, `@remotion/bundler` and
  `@remotion/player` at the same version.
- **Native compositor:** `@remotion/renderer` pulls a native compositor as an optional dependency. The Linux x64
  glibc build unpacks to 27,216,746 bytes (`npm view @remotion/compositor-linux-x64-gnu dist.unpackedSize`).
- **FFmpeg and Chrome:**
  - Since v4.0.0 Remotion ships its own FFmpeg.
  - It renders with **Chrome Headless Shell**, which `npx remotion browser ensure` downloads ahead of time. That
    download isn't hash-pinned by Remotion.
  - On Linux the browser needs shared libraries: libnss3, libdbus-1-3, libatk1.0-0, libgbm-dev, libasound2,
    libxrandr2, libxkbcommon-dev, libxfixes3, libxcomposite1, libxdamage1, libpango-1.0-0, libcairo2, libcups2 and
    libatk-bridge2.0-0. Alpine isn't supported (Linux dependencies page).
  - From v4.0.208 it doesn't pick up an externally installed browser.
- **Compositions:** `<Composition>` takes a zod `schema` and `defaultProps`; Studio builds a form from the schema.
  `calculateMetadata` runs before rendering and can set `durationInFrames`, size and fps from props.
- **Sequencing:** `<Series>` / `<Series.Sequence durationInFrames>` lay sequences back to back. Remotion is
  frame-based: a component renders from `useCurrentFrame()`, so seeking is deterministic by design.
- **Rendering APIs:** `selectComposition()`, `renderMedia()`, `renderStill()` and `renderFrames()` in
  `@remotion/renderer`, with `bundle()` in `@remotion/bundler`. The CLI has `npx remotion render <id> <dir>
  --frames=0,30,90 --image-format=png` for several frames in one call.
- **`licenseKey` / `--license-key`:**
  - **Where it works:** documented for `renderMedia()`, `renderStill()`, the web renderers and Lambda, and available
    from v4.0.409 (license-key docs page). **`renderFrames()` isn't listed**, so an image sequence rendered with it
    wouldn't be reported.
  - **`--is-production`** marks a render as development so it isn't billed, and works only together with a license
    key.
  - **Thresholds below our 4.0.540 pin** (the reviewer's figures, which I couldn't confirm): `@remotion/licensing`
    from 4.0.237 and the CLI flag from 4.0.539.
- **One browser, many stills:** `openBrowser()` opens a browser once. Passing it as `puppeteerInstance` to each
  `renderStill()` call, with the same `serveUrl`, reuses it ("can speed up the rendering process"). We close it
  ourselves.
- **Environment variables:**
  - **The CLI passes env vars prefixed `REMOTION_` into the webpack bundle**, where composition code reads them as
    `process.env.REMOTION_…`. It also auto-loads `.env` and `.env.local` from the Remotion root.
  - The Node APIs don't pick variables up by themselves: `renderMedia()` takes them through `envVariables`
    (env-variables docs page).
- **5.0 changes output bytes too:** the default `colorSpace` becomes `bt709` (from the bt601-equivalent `"default"`),
  and the default GL renderer becomes ANGLE with a SwiftShader fallback (v5.0 migration guide, v4.0.498 release
  notes). Both affect E2's CRF and size calibration.
- **Agent skills:** `remotion-dev/skills` (latest commit `c7cb2fd`, 2026-11-02; skills versioned `4.0.540`).
  - `remotion-best-practices` is the router.
  - The others are `remotion-create`, `remotion-markup`, `remotion-render`, `remotion-captions`,
    `remotion-multimedia`, `remotion-maps`, `remotion-interactivity`, `remotion-studio`, `remotion-docs`,
    `remotion-upgrade`, `remotion-saas` and `remotion-license`.
  - The README installs them with `npx skills add remotion-dev/skills` or `gh skill install remotion-dev/skills`.
    There's also `npx remotion skills add`.
  - **The router tells the agent to start Studio and open a browser preview, and "Don't render the video by default"**,
    which is wrong for a headless runner with a deadline (§5.3).
- **Remotion import into HyperFrames:** HyperFrames has a `/remotion-to-hyperframes` skill (`video/AGENTS.md`, Skills
  list). It isn't among the three skills `netlify-agent-kit`'s preset installs
  (`node_modules/hyperframes/dist/skills/` has `hyperframes`, `hyperframes-cli`, `media-use`).

---

## 3. Gotchas the design has to handle

1. **HyperFrames is assumed everywhere text tells the agent what to do:** the prompt, the root `AGENTS.md` and
   `video/AGENTS.md`. Every engine-specific line moves behind the engine when the Remotion prompt arrives (Phase 2).
   The root `AGENTS.md` keeps its explicit HyperFrames line and adds "unless your prompt names another engine".
2. **Remotion's skill says "open Studio" and "don't render by default".** The override goes in two places: the prompt
   and the Remotion `video/AGENTS.md`. Don't start Studio, don't open a browser, look at stills from
   `scripts/engine.ts snapshot`, and render with render-job.
3. **Network during the render.** Remotion downloads Chrome Headless Shell on first use, and its Google Fonts helper
   fetches fonts. Today's rule is "never load scripts, styles or fonts from a CDN or any other URL"
   (`src/domain/prompt.ts:232`). The browser is installed (and checked) during setup, and fonts come only from local
   files (`@remotion/fonts` `loadFont` with `staticFile`). The renderer's own license reporting to remotion.pro is the
   one allowed connection, and it's disclosed (§7).
4. **Where files live.** Remotion serves assets from a public folder through `staticFile()`, while the contract and
   prepare-run put library media at `video/assets/media/…`. The template sets the public dir to `video/assets`, and the
   contract runtime maps `assets/media/x.png` to `staticFile('media/x.png')`, so props keep the same `src` strings as
   HyperFrames slots.
5. **Install time counts.** Installing Remotion and its browser could take a minute or more per run. E1 measures it
   before we choose between installing per run and a cached tarball (§8).
6. **A version's engine never changes.** Revisions, remixes, edits, re-voices and retries restore engine-specific
   source. The engine is fixed when the video's first version is created, and two checks refuse any change: one at
   creation (inherit) and one at finalize (bundle shape, §4.2).
7. **Contract detection is per engine.** `contractOf` looks for `data-va-contract="1"` in `index.html`, and a Remotion
   bundle has no root `index.html`. Phase 1 adds one switch at each caller.
8. **Recorded narration is deeply HTML-shaped:** the bus layer, `data-va-speech`, the hold-frame beat, and the guards
   in render-job (`checkNarration`, `checkNarrationModified`). Remotion versions don't get recorded narration in v1
   (§6).
9. **The license applies to us too.** Netlify has more than 3 people, so the only free use open to it is one bounded
   evaluation (§1.1): local spikes and a single POC session of development renders on a scratch project. CI that
   renders, repeated live tests, our production deployment, and any commercial use of the results all need a license.
   The v5.0 Terms' "technology setup" wording makes even publishing the integration uncertain, so owner question 1 asks
   Remotion for written OK first.
   - **Correction:** draft 3 said this wording "wasn't on remotion.dev". It is, in the published Terms v5.0, and the
     plan now follows it.
10. **Automated QA is thinner for Remotion.** `hyperframes check` covers lint, runtime, layout, motion and contrast.
    Remotion has TypeScript, `selectComposition`, the contract check and a render smoke test. §5.4 says what v1 ships
    and §12 lists the risk.
11. **Restored archives can carry a supply-chain attack.** Revisions, retries and render-unchanged runs restore a
    parent's `video/`. Hydrating runs `npm ci` on whatever `package.json` and lockfile it holds. A previous run (or a
    prompt injection) could add a `postinstall` script, or a `remotion.config.ts` that overrides webpack or sets a
    browser executable, and that code would run with the deployment's env vars. The config files must match the
    template byte for byte (§5.1).
12. **The license key must never appear on a command line or in a log.** Render through the Node API with the key
    read from env, never through `--license-key` (§5.5).
13. **Every still counts as a render, and must be reported.** Snapshot rounds aren't free, either for Automators
    billing or in time (each round is a webpack bundle plus a Chrome launch). `renderFrames()` isn't documented as
    taking `licenseKey`, so a sequence rendered with it would go unreported, which 5.0 forbids for Automators. §5.4
    renders stills with `renderStill()` on one shared browser and a cached bundle, and E2 measures "rounds × seconds".
14. **`REMOTION_`-prefixed env vars reach composition code.** The CLI inlines them into the webpack bundle, so a key
    named `REMOTION_LICENSE_KEY` would be readable by any `process.env` reference in agent-written code, and the CLI
    also reads `.env` files. The key is named `VIDEO_AGENT_REMOTION_KEY` (§5.5), and `process.env` is banned in `src/`
    (§5.2).
15. **Other config files Remotion's toolchain may load** from `video/` aren't covered by the locked set:
    `babel.config.*`, `postcss.config.*`, `browserslist`. Dot-files (`.babelrc`, `.env*`) can't survive an archive
    (`src/lib/bundle-manifest.ts:34`), but these can. Only the template's files plus the agent's allowed paths may
    exist (§5.1), and E5 lists what the toolchain actually reads.

---

## 4. Design: the Engine seam

Two halves, because a run and the service run in different places with different dependencies. Each is built only
when something consumes it.

### 4.1 Service side: `src/domain/engines.ts`

Pure TypeScript: no Remotion or HyperFrames imports, so the app's build and Functions never depend on either package.

**Phase 1** holds only what the data and the API need:

```ts
export type EngineId = 'hyperframes' | 'remotion'

export interface EngineInfo {
  id: EngineId
  name: string                       // "HyperFrames", "Remotion"
  license: { kind: 'open'; spdx: 'Apache-2.0' } | { kind: 'remotion'; url: string }
  capabilities: EngineCapabilities
}

/** Op names: the contract's EditOp union plus ops other plans add (screen-recording's span, camera, cursor, redact). */
export type EditOpName = EditOp['op'] | 'span' | 'camera' | 'cursor' | 'redact'

export interface EngineCapabilities {
  editOps: EditOpName[]             // ops the editor may offer on this engine
  liveDraftPreview: boolean         // the editor's sandboxed preview plays drafts
  sound: 'none' | 'music' | 'all'   // what Sound may be (music = a bed only; all = music_sfx too)
  voiceover: boolean                // scripts/voice.ts per-beat lines
  revoice: boolean                  // change a voiced line in the editor
  recordedNarration: boolean        // Edit → Narration, fit to narration
  scopedRevision: boolean           // redo a scene (regenerate-beat plan)
  recording: boolean                // screen-recording demos (screen-recording plan)
}

export function engineInfo(id: EngineId): EngineInfo
/** Enabled for new videos here: in ENGINES and, for Remotion, acknowledged by an admin (§7). */
export async function enabledEngines(deps: Deps): Promise<EngineInfo[]>
```

| Capability | HyperFrames | Remotion, Phase 2 | Remotion, Phase 3 | Remotion, Phase 4 |
| --- | --- | --- | --- | --- |
| `editOps` | The 8 contract ops, plus screen-recording's 4 once that plan lands | none | text, retime, reorder, delete, color, media | adds audio and voice |
| `liveDraftPreview` | true | false | true if E4 passes | unchanged |
| `sound` | `all` | `music` | `music` | `all` |
| `voiceover` | true | false | false | true |
| `revoice` | true | false | false | true |
| `recordedNarration` | true | false | false | false |
| `scopedRevision` | true once regenerate-beat lands | false | true | true |
| `recording` | true once screen-recording lands | false | false | false |

**Phase 3** adds the editing half to the same module when the Remotion contract arrives. That's when a second
consumer exists:

```ts
export interface EngineEditing {
  contractOf(files: Map<string, Uint8Array>): { version: 1 | null; violations: string[] }
  read(files: Map<string, Uint8Array>, narration?: Record<string, string>): Composition
  applyEdits(files: Map<string, Uint8Array>, ops: EditOp[], opts: EditOptions): Map<string, Uint8Array>
  preview: PreviewSpec              // §4.4
}
export function engineEditing(id: EngineId): EngineEditing
```

Until then, Phase 1 changes `contractOf`'s two callers (`bundles.ts:179`, `edits.ts:409`) to one switch on the
version's engine. HyperFrames calls today's function, and any other engine returns
`{ version: null, violations: ['Editing isn't available for <engine> videos yet.'] }`.

**The `scopeCheck` hook (named now, built by regenerate-beat).** Redoing a scene needs a per-engine check that
everything outside the scope is unchanged. The interface lives here so every plan uses one name:

```ts
/**
 * A scoped revision's check and splice in one: the problems (anything outside `beats` that changed) and, when there
 * are none, the spliced files (the parent's, with the scoped beats' parts taken from the agent's result). render-job
 * and finalize both use these bytes, so they can't splice differently.
 */
export type ScopeCheck = (
  parent: Map<string, Uint8Array>,
  agent: Map<string, Uint8Array>,
  beats: string[],
) => { problems: string[]; files: Map<string, Uint8Array> | null }
export function scopeCheckFor(id: EngineId): ScopeCheck | null
```

- `scopeCheckFor('hyperframes')` returns the regenerate-beat plan's module when it lands. Until then it returns
  `null`, and HyperFrames' `scopedRevision` capability stays false.
- `scopeCheckFor('remotion')` returns `null` until Phase 3 (§11). Its freeze mirrors regenerate-beat's §4.4 rule for
  HyperFrames:
  - **Files:** every file in `video/` stays byte-identical and present, except `src/beats/<X>.tsx` and
    `assets/beats/<X>/**` for the scoped beats `X` and the generated `src/registry.ts` (§5.1). New files may appear
    only under `assets/`.
  - **`props.json`:** only the scoped beats' entries may differ. Every other beat entry, `colors`, `layers` and
    `audio` are equal, and the beat order is unchanged.
  - **`summary.json`:** only the scoped beats' cues are the agent's. Every other cue is recomputed from the parent's.
  - **Locked files:** their hashes (§5.1) are checked as well.
  - **The splice:** the parent's files, with the scoped beats' files and props entries taken from the agent's result,
    the scoped beats' caption cues taken from the agent's, and `src/registry.ts` regenerated.
- `reviseVideo` refuses a `scope` when the version's engine lacks `capabilities.scopedRevision`. It uses the
  regenerate-beat plan's `409 not_editable`, naming the engine, so there's no new error code.
- The run side has the same hook as an optional `RunEngine.scopeCheck` (§4.3) for render-job's guard.

**`src/lib/contract-core.ts` (named now, built by its first real consumer).** The `Composition`-level frame math,
relayout and caption sync, shared by every engine's contract:

- Whichever lands first builds it under this name: regenerate-beat's splice, screen-recording's `relayout` change, or
  this plan's Phase 3 (the Remotion contract). Phase 3 is the latest it can wait.
- `contract.ts` then imports from it and doesn't re-export it.
- **Phase 1 doesn't refactor `contract.ts`.** It's more than 1,200 lines (`relayout` `:1026`, `applyEdits` `:1087`,
  `applyRevoice` `:1244`). Moving it with no second consumer is where Phase 1 could break the editor for nothing.

### 4.2 Data

- **`versions.engine`:** `text not null default 'hyperframes'` (migration in `netlify/database/migrations/`, Drizzle
  in `db/schema.ts`, `VersionRow.engine` in `src/domain/types.ts`). Every row written before this is HyperFrames,
  which is true. This is the first migration in the roadmap's migration order (engines phase 1).
- **One engine per video:** `reviseVideo`, `remixVideo`, edit renders, retries and incorporate-feedback copy the
  engine from the parent. A domain check refuses a version whose engine differs from its parent's
  (`409 engine_mismatch`), which only a bug could trigger, never a request.
- **The engine for a new video** follows the looks plan's rule:
  1. `request.engine` if given, checked against the look's `engines` (else `400 engine_not_supported_by_look`) and
     against the enabled engines (else `409 engine_disabled`);
  2. otherwise the look's first listed engine that's enabled (with a look listing `["remotion", "hyperframes"]` and
     Remotion off, that's HyperFrames, not a 409);
  3. otherwise `hyperframes`.

  A request for a capability the engine lacks gets `409 engine_unsupported`, naming the capability. Examples: Sound
  "Music + effects" or a voice-over on Remotion before Phase 4, or a `recording` on Remotion.
- **Settings** (`db/schema.ts` `settings`, the engines phase 2 migration):
  - `remotion_enabled boolean not null default false`;
  - `remotion_license_ack jsonb null` = `{ by: userId, email, at, tier: 'free' | 'company', note }`.

  No key or secret goes in the database (§7).
- **Run manifest:** an optional `engine` field. Absent means `hyperframes`, so manifests already written stay valid.
  `verifyRunManifest` accepts only known ids, and `v` stays 1 (roadmap shared rule 4).
- **render-job's manifest:** gains `engine: { id, version, renders? }` next to the existing `hyperframes` version
  string, which stays for older readers. `renders` is Remotion's count, `{ video, stills, audio }` (§5.4), every one of them
  reported with `licenseKey`.
- **Finalize checks the engine twice:**
  1. `engine.id` matches the version's engine.
  2. The bundle's shape matches it. HyperFrames means `index.html` at the root. Remotion means `props.json` plus
     `src/Root.tsx` and no root `index.html`, the locked files byte-identical to the template, `src/registry.ts`
     equal to what `props.json` generates, and no file outside the allowed set (§5.1). This runs where `ensureBundle`
     builds the bundle index (`bundles.ts:136–195`).

  Either mismatch fails the attempt with `engine_mismatch`, so a run that ignored its prompt and wrote the wrong kind
  of project is caught before it becomes a version. Finalize also adds the run's `engine.renders` to the deployment's
  monthly Remotion count (§7).
- **The video DTO:** keeps `editable` (`videos.ts:898`) as it is, and adds
  `editing: { engine, capabilities: EngineCapabilities }` next to it.

### 4.3 Run side: `scripts/lib/engines/`, `scripts/engine.ts`, and prepare-run's order

The run side is built only as far as its consumers need it:

- **Phase 1:** the `RunEngine` type, `scripts/lib/engines/hyperframes.ts` (the `render`, `contract` and `version` that
  render-job calls), and prepare-run's step order, which other wave-1 plans need. `scaffold` and `hydrate` are optional
  hook points in prepare-run's step 1, and HyperFrames doesn't implement them, so the order is fixed now with no
  behaviour change.
- **Phase 2:** `check`, `snapshot`, `scripts/engine.ts`, and Remotion's `scaffold` and `hydrate` arrive with their
  first consumer, the Remotion prompt.
- **Local mode** (CLI plan, roadmap wave 4) bundles whatever exists by then.

```ts
// scripts/lib/engines/types.ts
export interface RunEngine {
  id: EngineId
  /** Seed video/ for an author run (Remotion: copy engines/remotion/template/, install, ensure the browser). Phase 2. */
  scaffold?(videoDir: string): Promise<void>
  /** Install what a restored source needs, after checking its files are allowed (Remotion: engine_tampered). Phase 2. */
  hydrate?(videoDir: string): Promise<void>
  /** The engine's own checks; 0 errors means ready to render. Phase 2. */
  check?(videoDir: string): Promise<{ errors: string[]; warnings: string[] }>
  /** The editing contract for this engine. */
  contract(videoDir: string): string[]
  /** PNG stills at these seconds into .render/snapshots/, in one call (Remotion: stills on one browser, §5.4). Phase 2. */
  snapshot?(videoDir: string, atSec: number[]): Promise<string[]>
  /** The MP4 at the given quality. */
  render(videoDir: string, out: string, quality: string, onProgress: (pct: number) => void): Promise<RenderReport>
  /** The editor's preview bundle (Remotion, Phase 3: esbuild of the Player host, §4.4). */
  previewBundle?(videoDir: string): Promise<void>
  /** Render-job's guard and splice for a scoped revision (regenerate-beat): the same result shape as ScopeCheck. */
  scopeCheck?(frozenDir: string, videoDir: string, beats: string[]): { problems: string[]; files: Map<string, Uint8Array> | null }
  version(videoDir: string): string
}
```

- **Phase 1's HyperFrames engine** is thin wrappers over today's commands. `render-job.ts` calls `engine.render(...)`
  where it ran `npx -y hyperframes render` (`:202`), and `engine.contract(videoDir)` where it checks the contract
  (`:85`). Everything after the render stays as it is.
- **`scripts/engine.ts check | snapshot --at 1,3,5 | render | mix`** (Phase 2) is one CLI over the run engine named in
  `.render/run-manifest.json` (or `--engine` in local mode). The Remotion prompt uses it. The HyperFrames prompt keeps
  `npx hyperframes check` and `snapshot`, which its skill's work loop already teaches.
- **prepare-run's step order** (owned here, roadmap shared rule 4; each step skips when the manifest doesn't ask for
  it):
  1. **Source:** `scaffold` for `author` runs, or restore the source/bundle and then `hydrate` for every other kind.
     Revision, render-unchanged and author_from_frozen keep today's restore code.
  2. Library media into `video/assets/media/` (today's step).
  3. The look (looks plan).
  4. Recording files (screen-recording plan), then scope files (regenerate-beat plan).
  5. **Feedback and scope stills, last.** `feedbackStills` empties `video/feedback/` before writing, so it must run
     after everything else that touches `video/`, as it does today (it's the last step of `prepare()`). The
     regenerate-beat plan's scope stills join it here.
  6. `.render/run-manifest.json` for render-job (today's step).

  For HyperFrames, step 1's `scaffold`/`hydrate` do nothing, so behaviour is unchanged.

### 4.4 Browser preview (Phase 3)

The editor and live progress play a version's composition in the sandboxed `/preview` document.

- **HyperFrames:** unchanged. The edge function injects the runtime and `bridge.js` into `index.html`.
- **Remotion:** the run builds a small static preview at render time (`previewBundle`): `preview/index.html` and one
  `preview/player.js`, made with esbuild from a host page that mounts `@remotion/player` with the composition and
  speaks the same bridge messages.
  - A draft edit is `apply-edits` carrying the new props, and the Player re-renders from them. That's simpler and more
    faithful than patching a live DOM.
  - `preview/` is part of the bundle. The edge function serves `preview/index.html` instead of injecting into
    `index.html` when `PreviewSpec.entry` says so, and the CSP stays as it is.
  - E4 checks whether the Player needs anything the CSP forbids (blob workers, `eval`).
- **MP4 fallback:** a Remotion version with no preview bundle has `liveDraftPreview: false`. The editor shows the last
  render and says "Preview isn't available for this video; render to see changes."
- **License:** `@remotion/player` ships only inside a Remotion version's bundle (built in the run), never in the app's
  `ui/` build.
  - Player previews aren't renders.
  - Free License users may embed the Player.
  - For Company License users, embedding the Player is Automators use. The same admin acknowledgment (§7) covers it,
    and the dialog says so.

---

## 5. Design: Remotion as an engine

### 5.1 The project template (`engines/remotion/template/`)

`scaffold` copies the template into `video/` for an author run, after clearing the HyperFrames template files:

```
video/
  AGENTS.md                 # Remotion version of video/AGENTS.md: contract, sound, rules, the Studio override
  package.json              # pinned remotion, @remotion/cli, @remotion/renderer, @remotion/bundler, react, react-dom, zod
  package-lock.json         # committed, with integrity hashes; installed with npm ci --ignore-scripts only
  remotion.config.ts        # publicDir = ./assets, codec h264; no webpack override, no browser executable
  tsconfig.json             # resolveJsonModule on
  props.json                # THE editable data (§5.2): the agent writes it, the editor edits it
  summary.json              # same shape as today (captions keyed by beat and textId)
  src/
    index.ts                # registerRoot(Root). LOCKED
    Root.tsx                # import props from '../props.json'; one <Composition id="main" schema={vaSchema} defaultProps={props}
                            # calculateMetadata={vaMetadata} fps={30} …> rendering <VaVideo>. LOCKED
    registry.ts             # GENERATED from props.json: `import Intro from './beats/intro'` … `export const beats = { intro: Intro, … }`,
                            # and the same for layers. engine.ts check rewrites it; a stale one is an error
    va/                     # the contract runtime: ours, MIT, read-only for the agent (hash-checked)
      schema.ts             # zod schema of props.json
      Video.tsx             # <VaVideo>: colours as --va-color-* on the root, layers, <Series> of beats in props order
      Text.tsx              # <VaText id="intro-title" as="h1" …> renders that beat's text from props
      Media.tsx             # <VaImage slot="…"> / <VaClip slot="…"> from props media, through staticFile()
      Audio.tsx             # music layer (Phase 2); per-beat sfx and voice, ducking (Phase 4)
      metadata.ts           # durationInFrames = the sum of beat durations in frames
    beats/
      intro.tsx             # one component per beat id
    layers/                 # whole-video layers (background, logo bug)
  assets/
    fonts/  media/  music/  sfx/  voice/
```

Why this shape:

- **One composition, id `main`,** like `data-composition-id="main"` today, so render-job, the CLI and snapshots never
  have to discover anything.
- **`props.json` is the one source of truth.** `Root.tsx` imports it, so `selectComposition`, the render and the
  Player can't disagree, and render-job never passes props. The beat components read text, colour, media and audio
  only through the `va/` runtime. An edit is a change to the file, and a render-unchanged run renders exactly the file
  the server wrote.
- **Beats are files, found through a generated registry.** Webpack can't import a component by a runtime string, so
  the locked `va/Video.tsx` can't find `beats/intro.tsx` by itself.
  - `src/registry.ts` maps each beat id (and layer id) in `props.json` to a static import of its file.
  - `engine.ts check` rewrites it from `props.json` before every check and render, and the server does the same after
    an edit.
  - A registry that doesn't equal its regenerated form is an error, so the only way to add a beat is to add it to
    props and write its file.
  - Static imports, not lazy ones, so nothing loads asynchronously during a render.
  - Remotion's `scopeCheck` freezes every other beat's file and props entry (§4.1).
- **The `va/` runtime is ours** (MIT, in this repo, versioned with the contract). It imports Remotion as a dependency.
  It doesn't copy or modify Remotion code, so it isn't a derivative of Remotion, which is what the license's
  "Disallowed use cases" are about.
- **The config, the wiring and the runtime are locked (supply chain and "one source of truth", gotchas 11 and 15).**
  `package.json`, `package-lock.json`, `remotion.config.ts`, `tsconfig.json`, `src/index.ts`, `src/Root.tsx` and every
  file under `src/va/` must be byte-identical to the template's.
  - Without `Root.tsx` in the set, an agent could hard-code `defaultProps`, drop `calculateMetadata` or render its own
    tree. It would pass `selectComposition`, and the editor's edits would change nothing on screen.
  - The sha256s are kept in `scripts/lib/engines/remotion.ts`.
- **Only allowed paths may exist.** Besides the locked files, the agent writes only `props.json`, `summary.json`,
  `src/beats/*`, `src/layers/*` and `assets/**`. `src/registry.ts` is generated, `AGENTS.md` comes from the template,
  and `node_modules` is installed. Any other file at the top of `video/` or `src/` (a `babel.config.js`,
  `postcss.config.js`, `browserslist`, a second entry point) is refused.
- **Where it's checked:** `hydrate` checks the locked hashes and the allowed paths before any `npm ci`, and refuses
  with `engine_tampered` if one fails. `check` checks them again, and finalize checks the bundle (§4.2).
  - `npm ci` always runs with `--ignore-scripts`.
  - The agent can't add dependencies in v1. A look that needs one (say `@remotion/three`) ships it in the template
    lockfile, so every Remotion run installs the same set.

### 5.2 Editing contract v1 on Remotion (Phase 3)

Same model, different carrier. `src/lib/contract-remotion.ts` validates `props.json` + `summary.json` and implements
`read` and `applyEdits` over `src/lib/contract-core.ts`. It produces the same `Composition` and accepts the same
`EditOp`s as `src/lib/contract.ts`.

```jsonc
// video/props.json
{
  "contract": 1,
  "width": 1920, "height": 1080, "fps": 30,
  "colors": { "bg": "#0b0d10", "text": "#ffffff", "accent": "#ff5a1f" },
  "layers": [{ "id": "background", "label": "Background" }],
  "beats": [
    {
      "id": "intro", "label": "Opening", "duration": 4, "authoredDuration": 4,
      "texts": { "intro-title": { "text": "Meet org webhooks", "label": "Headline" } },
      "media": { "logo": { "kind": "image", "src": "assets/media/logo.svg", "fit": "contain", "label": "Logo" } },
      "voice": null,
      "sfx": []
    }
  ],
  "audio": {
    "music": { "id": "music", "src": "assets/music/bed.mp3", "volume": 0.8, "muted": false, "fadeIn": 1, "fadeOut": 1.5, "duck": 0.3 }
  }
}
```

| Contract v1 rule (HyperFrames)                                            | On Remotion                                                                                                                                        |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root `data-composition-id="main"`, `data-va-contract="1"`                 | `<Composition id="main">` in `Root.tsx`; `"contract": 1` in props                                                                                  |
| `data-duration` = sum of beats                                            | `calculateMetadata` sums `beats[].duration` in whole frames, so there's no stored total to drift                                                   |
| Beats: back to back from 0, track 0                                       | `<Series>` of `beats` in props order; `beats/<id>.tsx` for each id; ids `[a-z0-9-]+`                                                              |
| One `vaBeat` script per beat; select only inside the beat                 | One component per beat; it gets only its own beat's props and frame                                                                               |
| No animation crosses a beat boundary                                      | Holds by construction: a `Series.Sequence` unmounts at its end. Transitions belong to the beat they lead into (no `TransitionSeries` overlap in v1) |
| Layers: `data-va-layer`, full duration, track ≥ 1                         | `layers/<id>.tsx`, rendered under or over the `Series` for the whole duration                                                                      |
| Text: unique `data-va-text`                                               | Unique keys in `beats[].texts`, rendered only through `<VaText id>`                                                                                |
| Labels: `data-va-label`                                                   | `label` fields in props                                                                                                                            |
| Colours: `--va-color-<role>` on `#root`                                   | `colors` in props → `--va-color-<role>` CSS variables on the root element                                                                          |
| Media slots: `data-va-media`, `data-va-kind`, `src` under `assets/media/` | `beats[].media` entries, rendered through `<VaImage>` / `<VaClip>` (an `OffthreadVideo`, muted unless `hasAudio`)                                 |
| Captions in `summary.json` with `beat`, `textId`, `beatStart`, `beatEnd`  | Identical file and rules                                                                                                                           |
| Music layer, effects inside beats, `<audio id>` with `data-volume`        | `audio.music` (Phase 2), `beats[].sfx` (Phase 4), rendered by `<VaAudio>` with the same volume range                                              |
| One voice per beat, beat-local timing                                     | `beats[].voice = { id, src, start, duration }` (Phase 4), same rules                                                                              |

**What the check enforces (v1).** `contract-remotion.ts`, called by `engine.ts check`:

1. `props.json` parses against the contract schema. The template's zod schema is exported as a JSON Schema, generated
   at build, so the service doesn't depend on zod tooling.
2. Every beat id (and layer id) has its file in `src/beats/` (`src/layers/`), every such file has an entry in props,
   and `src/registry.ts` equals what `props.json` generates.
3. A static scan of `src/**/*.tsx` with the TypeScript compiler API (installed in `video/node_modules`):
   - every `<VaText id>`, `<VaImage slot>` and `<VaClip slot>` is a string literal that exists in that beat's props;
   - every text and slot in props is used exactly once;
   - no `@remotion/google-fonts` import, no `http://` or `https://` string, and no `process.env` in `src/`. A remote
     font or image breaks an offline render, `process.env` is how a composition would read the deployment's env
     (gotcha 14), and the grep is cheap.
4. The locked files match their hashes, and nothing outside the allowed paths exists (§5.1).
5. `selectComposition()` (from `@remotion/renderer`, with `inputProps: {}` since 5.0 makes it required) returns `main`
   with the expected width, height, fps and `durationInFrames`. `npx remotion compositions` isn't used because it has
   no documented JSON output.
6. `npx tsc --noEmit` passes.

Three more scan rules wait for E2's evidence about what agents actually get wrong. They're in "Not in v1" (§13) with
their design:

- no JSX text literal outside `<VaText>`;
- no colour literals outside `src/va/`;
- no `fetch`, `Math.random` or `Date.now`.

`applyEdits` on Remotion uses `contract-core.ts`'s relayout and caption sync, the same code the HyperFrames contract
uses by then. It also keeps the files consistent with props, so check rule 2 holds on the render-unchanged run the
server's own draft produces:

- **`delete`** removes `src/beats/<id>.tsx` and its `assets/beats/<id>/` folder from the returned file map, and
  regenerates `src/registry.ts`.
- **`reorder`** changes only props, since `<Series>` follows props order. The registry is keyed by id, not order.
- **`media` with a library `src`** adds nothing under `src/`. The file arrives in `assets/media/` through the library
  download step.

A **conformance suite** (§9) applies the same op sequences to paired HyperFrames and Remotion fixtures and
asserts that the same `Composition` and captions come out. It skips ops an engine doesn't list in `editOps`, so
screen-recording's ops are tested on HyperFrames only. The suite keeps the two engines meaning the same thing by
"retime" or "reorder".

### 5.3 The prompt (Phase 2)

`src/domain/prompt.ts` keeps everything that isn't about the engine: the brief, brand, look, plan, feedback, media,
length, sound choice and voice settings. When the Remotion prompt arrives, the engine-specific lines move into an
`EnginePrompt`:

```ts
export interface EnginePrompt {
  /** Steps 1–3 of the author list: skill, write, check. */
  authorSteps(p: { width: number; height: number; voice: boolean }): string[]
  soundLines(…): string[]          // today's soundLines() for HyperFrames
  voiceLines(…): string[]
  renderUnchangedSteps(…): string[]
  /** Rule lines every prompt carries (no CDN, no network…). */
  rules(): string[]
}
```

The HyperFrames implementation returns today's lines word for word. A test asserts the HyperFrames prompt is
byte-identical to today's for the same `PromptInput`, with no exceptions. `PROMPT_TEMPLATE_VERSION` follows roadmap
shared rule 3: the Phase 2 PR adds 1 to the constant in merge order, because it adds a new template branch. Phase 1
doesn't touch the prompt. The HyperFrames
bytes don't change, so the PR moves `test/remix-run.test.ts:176` to import the constant if no earlier PR has.

The Remotion author steps (draft wording):

1. "Read the remotion-best-practices skill and the markup and render rules it routes to. **Don't start Remotion Studio
   or open a browser, and ignore the skill's advice not to render**: this machine has no screen and a deadline, and
   render-job renders the video. To see your work, run `npx tsx scripts/engine.ts snapshot --at <seconds>` (all the
   moments you want in one call; each call costs time and counts as a render) and look at the PNGs. The project is
   video/, set up with its dependencies installed."
2. "Follow the editing contract in video/AGENTS.md ("Editing contract v1 (Remotion)"). Write video/props.json first,
   then one component per beat in video/src/beats/, reading every text, colour and media item through the va/
   components. Write only props.json, summary.json, src/beats/, src/layers/ and assets/. Don't change video/src/va/,
   src/Root.tsx, src/index.ts, src/registry.ts, package.json, the lockfile, remotion.config.ts or tsconfig.json, don't
   add other config files, and don't install packages or read process.env. `engine.ts check` regenerates the
   registry for you. Set the composition to {w}x{h}, 30 fps."
3. "Use only files in video/: fonts from video/assets/fonts with loadFont from @remotion/fonts, never Google Fonts or
   any URL. No fetch, no random numbers, no clock."
4. "Run `npx tsx scripts/engine.ts check` until it reports 0 errors." That covers tsc, the contract,
   `selectComposition` and the render smoke.
5–6. summary.json and render-job, unchanged.

The Remotion `video/AGENTS.md` repeats the Studio and render override, since the agent reads it next to the skill.

The root `AGENTS.md` keeps line 8 as it is and adds "unless your prompt names another engine; then read the skill and
run the check it names". Line 12 becomes "Keep the editing contract (in `video/AGENTS.md` for your engine)".

### 5.4 Checks, snapshots and render counts

- **Render smoke:** `engine.ts check` renders the first frame, each beat's midpoint (up to 4) and the last frame.
  - **How:** `renderStill()` on one browser. `openBrowser()` runs once, and the browser (`puppeteerInstance`) and the
    cached `serveUrl` are passed to each call, each with `licenseKey`. One Chrome launch and one bundle per round.
  - **Reported:** each still is one reported render.
  - **Bundle cache:** `.render/bundle-<hash>`, keyed by the source hash, so a snapshot and a check on the same source
    don't bundle twice.
  - **Why not one sequence:** `renderFrames()` (one image sequence) isn't used, because Remotion's docs don't list it as
    taking `licenseKey`, and its output would go unreported. E2 confirms `renderStill` takes `licenseKey` at 4.0.540.
- **Snapshots** for the agent work the same way: stills on one browser per call.
- **Agent review:** the prompt has the agent look at snapshots at each beat before rendering, as HyperFrames' work
  loop does.
- **Contrast:** v1 ships without an automated contrast check for Remotion. The design (read `<VaText>` colours from
  the bundle's DOM in the renderer's browser and compute WCAG contrast) is in §13. The version's summary says
  "contrast was reviewed by eye, not measured", like today's "mix measured, not heard" note.
- **Render counts:** every Remotion render the run makes (the video, each snapshot or smoke still, any audio render
  in Phase 4) is tallied by `scripts/lib/engines/remotion.ts` into render-job's manifest as
  `engine.renders = { video, stills, audio }` (`audio` stays 0 until Phase 4). Finalize adds them to the monthly
  count (§7). We don't claim how Remotion bills them: the count is for
  reconciling against remotion.pro.

### 5.5 Rendering and outputs

- **`render`** calls `renderMedia()` from `@remotion/renderer` (loaded from `video/node_modules`) on the cached
  bundle, with codec h264 and a CRF from the quality map. E2 picks CRFs so file sizes land near today's 1–1.5 MB a
  minute at 1080p.
- **The key:** `licenseKey` is read from env inside the Node process: `VIDEO_AGENT_REMOTION_KEY` for a Company License,
  or `"free-license"` for the Free License tier recorded in settings (passed in the run manifest as
  `engine: { id: 'remotion', tier }`).
  - The name deliberately has no `REMOTION_` prefix, because Remotion's CLI inlines `REMOTION_*` variables into the
    composition's bundle (gotcha 14). The render passes no `envVariables` to the composition at all.
  - The key never appears on a command line, so nothing shows in a process list or in `runStreaming`'s output tail.
  - **If it leaks anyway**, someone else could have renders reported against the deployer's remotion.pro account. Runs
    can read env vars (the README's trust model), so a brief or comment could ask an agent to print it. The README and
    the dialog tell admins to rotate the key on remotion.pro if a run's output ever shows it.
  - `scripts/lib/run-tools.ts`'s logger also masks anything shaped like a Remotion secret key (`rm_sec_…`) in every
    log line as a second guard.
  - Spikes, CI and live tests pass `isProduction: false`, which needs a license key, so free-license renders there
    stay at the default.
- **Progress** comes from `onProgress` and feeds `RenderProgressReporter`.
- **After the render** everything is today's code: ffprobe checks, poster, GIF, captions VTT, preview variants, the
  source archive (`video/` minus `node_modules`, which `excluded()` already drops), the bundle, upload and callback.
  Mastering of a narrated mix doesn't apply in v1.

### 5.6 Sound and voice on Remotion

**Phase 2: music only** (bed, fades, level):

- `<VaAudio>` renders `audio.music` with fades and its level.
- `engine.ts mix` sets the music level with no render at all. With one bed and no other audio, the output's loudness
  is the source segment's loudness plus the gain.
  - It measures the music file itself with an ffmpeg `loudnorm` first pass over the first `duration` seconds of
    `audio.music.src`.
  - It sets `audio.music.volume = 10^((−14 − LUFS_src) / 20)`, clamped to the contract's range, the same target as
    today (about −14 LUFS integrated).
  - It checks the true peak at that gain (≤ −1 dBTP) and lowers the gain if needed.
  - Fades make the result a little quieter, which is inside the Phase 2 live test's ±1.5 LU tolerance.
- Phase 4 adds an audio-only render of the full mix (it counts as a render) once effects and voice can change the
  result.
- Each look's `sound.musicMood` (looks plan) feeds the server's music pick as it does for HyperFrames.

**Phase 4: effects, voice-over and re-voicing:**

- **Effects:** each beat's `sfx` plays at its beat-local time.
- **Ducking:** `<VaAudio>` computes the duck from the voice spans in props (`volume={(f) => …}`: 0.3 while someone
  speaks, the same release as `DUCK_RELEASE_MS`), so it follows every retime and reorder with nothing to rewrite.
- **Voice-over (`scripts/voice.ts`):**
  - Speaking the lines (Kokoro or ElevenLabs) and writing `assets/voice/*.wav` and `voice.json` is
    engine-independent.
  - Two places are HyperFrames-specific and go behind the engine: the `<audio>` tag it prints, and `voice.ts sync`
    writing the ducking lane.
  - On Remotion, sync writes `beats[].voice` entries into `props.json`, and the narration captions into
    `summary.json` as today.
- **Re-voicing a line in the editor:** a props equivalent of `applyRevoice` (`src/lib/contract.ts:1244`).

---

## 6. What works on a Remotion video, by phase

| Feature                                                      | HyperFrames  | Remotion, Phase 2          | Remotion, Phase 3–4                        | Why                                                                                         |
| ------------------------------------------------------------ | ------------ | -------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Create, revise, remix (same engine), plan, retry, cancel     | ✓            | ✓                          | ✓                                          | Engine-specific source in, MP4 out; revisions restore and hydrate the parent's archive      |
| Comments at a moment, verdicts, incorporate feedback         | ✓            | ✓                          | ✓                                          | Built on the MP4 (stills via ffmpeg in prepare-run)                                         |
| Poster, GIF, hover clip, captions VTT, share page, embed     | ✓            | ✓                          | ✓                                          | ffmpeg on the MP4; captions from `summary.json`                                             |
| Library media (images, clips, fonts)                         | ✓            | ✓                          | ✓                                          | Same download step; `staticFile` mapping                                                    |
| Looks                                                        | ✓            | Looks that list `remotion` | ✓                                          | Looks plan; a Remotion look's `registry` must be empty (HyperFrames blocks don't apply)     |
| Music (bed, fades, level)                                    | ✓            | ✓                          | ✓; editor `audio` op in Phase 4            | §5.6                                                                                        |
| Sound effects, AI voice-over, re-voice a line                | ✓            | ✗ (`409 engine_unsupported`) | ✓ Phase 4                                | §5.6                                                                                        |
| Live progress (watch it being written)                       | ✓            | Messages only              | Messages only                              | Checkpoint preview bundles are in "Not in v1" (§13)                                         |
| Browser editor: text, retime, reorder, delete, colour, media | ✓            | ✗ (contract null)          | ✓ Phase 3                                  | Props ops + Player preview                                                                  |
| Recorded narration, fit to narration, hold frame             | ✓            | ✗                          | ✗ (not planned)                            | Gotcha 8; the UI hides Narration on Remotion videos                                         |
| Redo a scene (scoped revision)                               | Once regenerate-beat lands | ✗ (`409 not_editable`)   | ✓ Phase 3                     | `scopeCheckFor('remotion')` freezes everything outside the scoped beats (§4.1)                              |
| Screen-recording demos                                       | Once screen-recording lands | ✗ (`409 engine_unsupported`) | ✗ (not in v1)            | Screen-recording plan is HyperFrames-only in v1; `recording: false`                         |
| Remix or restyle across engines                              | n/a          | ✗                          | ✗ (not in v1)                              | Source is engine-specific                                                                   |

---

## 7. Gating, permissions, credits

**Two locks, both required before anyone can create a Remotion video:**

1. **The `ENGINES` env var** (comma-separated, default `hyperframes`). Only a deployer who sets
   `ENGINES=hyperframes,remotion` gets Remotion installed on runs and offered in the app. It's a deploy-level decision
   because it changes what runs install. It's in the README's configuration table, not in the Deploy button's
   `[template.environment]`, so the button never asks for it.
2. **An admin's license choice** on the Admin page: **"Use Remotion (a license is required for most companies)"**.
   Turning it on opens a dialog:

   > Remotion isn't open source. It's free for individuals, non-profits and companies of up to 3 people, counting the
   > people from other teams or contractors you work with on it. Every other company needs a Remotion Company License
   > before using it here. For this app that's usually "Remotion for Automators" ($0.01 a render, $100 a month minimum,
   > at remotion.pro), and it also covers the Remotion Player the editor uses. Video Agent doesn't buy or check this
   > for you. Each render tells Remotion which license key was used, what kind of event it was, and whether it was
   > production or development, never what's in the video. If a key ever shows up in a run's output, rotate it on
   > remotion.pro.
   >
   > ( ) My organisation qualifies for the Free License: renders are reported as "free-license"
   > ( ) My organisation has a Remotion Company License: renders are reported with `VIDEO_AGENT_REMOTION_KEY`
   > Note (optional): license reference or who approved it

**What saving the dialog does:**
- It records `remotion_license_ack` (who, when, which tier, note) and sets `remotion_enabled`.
- "Company License" can't be saved unless `VIDEO_AGENT_REMOTION_KEY` is set on the project, refused with
  `409 remotion_key_missing`. The server reads only whether it's present, never its value. This closes the case where a
  Company License deployer renders without a key, which from 5.0 is a breach our defaults would have caused.
- Turning Remotion off stops new Remotion videos at once. Existing Remotion videos keep playing, and their revisions
  and edits keep working, so disabling never strands a video.
- If `ENGINES` no longer includes Remotion, runs can't install it, and new runs for those videos fail with
  `engine_unavailable`.

**Other surfaces:**
- **`/setup`** gains an Engines row:
  - "HyperFrames ✓; Remotion: off";
  - or "on, Company License recorded by ana@acme.com on 2026-11-20; renders are reported to remotion.pro";
  - or "in ENGINES but not set up: see Admin";
  - or "last Remotion install failed: `engine_install_failed`", from the latest Remotion attempt's error code, with no
    link (nothing else tracks install failures).
- **Admin-only details:** the license record (who, email, note) shows only on the Admin page and on `/setup` (which is
  admin-only). `GET /api/v1/engines` never returns it.
- **`VIDEO_AGENT_REMOTION_KEY`** (optional; mark it secret; scopes: builds and functions). Functions need it only to see
  that it's there. The README's trust model already says runs can read env vars, and that applies here too. It's
  not `REMOTION_LICENSE_KEY`, because Remotion's CLI exposes `REMOTION_*` variables to composition code.
- **Telemetry:** "no network during the render" means the composition never fetches. The renderer's license reporting
  to remotion.pro is the one exception, allowed and disclosed in the dialog, the README's trust model and `/setup`.
- **Who can choose an engine:** anyone who can create, but only among enabled engines, through the look (looks' engine
  choice rule) or an explicit `engine` (REST, MCP `create_video`, SDK, CLI `--engine`). Reviewers and Viewers never
  spend credits, as today.
- **Credits:** a Remotion run costs whatever its agent and runner time cost; E2 measures it against S1. If install adds
  a fixed overhead, the New video page shows "Remotion videos take about N more credits" once it's measured.
- **Remotion's own charges** are between the deployer and Remotion. The Admin usage page shows "Remotion renders this
  month: N (M videos, K stills)" from finalize's tally, so they can reconcile it with remotion.pro.
- **Discovery:**
  - The `engines` feature string goes in `GET /api/v1/config`'s `features` (cli-and-sdk's registry) once Phase 2
    ships.
  - `GET /api/v1/engines` (operationId `listEngines`) is the detail call: id, name, license kind, capabilities,
    enabled, and the license notice text. The SDK's `engines.list()` and the CLI's `--engine` help use it.
- **README wording** (a new "Render engines" section):
  - what each engine is, and the license table;
  - "Remotion is off unless you turn it on, and most companies need a Company License";
  - "this template is MIT and doesn't include Remotion; runs install it from npm only when `ENGINES` includes it";
  - what Remotion's license reporting sends;
  - how to turn it on and off.

---

## 8. Installing Remotion on the runner

| Option                        | How                                                                                                                                                                                                                                                                                                                      | Cost                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| B. Install per run            | `scaffold` / `hydrate` run `npm ci --ignore-scripts` in `video/` from the template lockfile, then `npx remotion browser ensure`, only for Remotion runs. Each step has a timeout through `runStreaming`'s `timeoutMs` (`scripts/lib/run-tools.ts:141`). E1 sets it to about 3× the measured median. On expiry the run stops with `engine_install_failed`, so a stuck registry or download ends the attempt in minutes, not at the deadline (`(22 + 3)` minutes, `reconciler.ts:174`) | Only Remotion runs pay; it counts against the deadline                                  |
| C. Cached tarball (B, faster) | An admin starts a "prime" run from the Admin page. It installs once and uploads `node_modules` plus the browser as a tarball to the `internal` Blobs store, keyed by the lockfile hash. The server records the tarball's sha256 from that run's report after the admin confirms it. Every later run downloads it, checks that sha256 (pinned in the server-written run manifest), and unpacks it | One prime per lockfile change. Faster if Blobs beats npm. Pins the browser download    |

**Recommendation: lean C, with B as the fallback** when no tarball is primed yet (the first Remotion run on a
deployment, or right after a lockfile change). C is better even if E1 shows B's install is quick:
- it pins the browser archive and the whole `node_modules` tree to a hash the server chose;
- it takes npm's and Google's download servers off the run's critical path;
- a Blobs overwrite fails closed.

C's Admin "prime" button and `engine_cache_mismatch` are beaded only once E1 confirms the Blobs download and unpack
work and are timed. The download and unpack have the same timeout rule as B.

**Two Chrome installs per Remotion run.** The `hyperframes` preset installs HyperFrames' Chrome in setup for every run,
and Remotion adds Chrome Headless Shell. E1 records the time and size of both, so the "about N more credits" note (§7)
is honest.

- **The browser hash:** C also fixes the unpinned Chrome Headless Shell download, because the browser arrives inside a
  tarball whose hash the server chose. With B, `scripts/lib/engines/remotion.ts` pins the browser archive's sha256 per
  Remotion version (recorded in E1) and checks it after `browser ensure`.
- **If a run overwrites the tarball:** runs can write to Blobs (render-job uploads there), so one could replace it. The
  next run then fails closed with `engine_cache_mismatch`, and an admin re-primes.
- **Installing in setup (option A, considered and dropped):** a `netlify-agent-kit` `run` step could gate itself on
  `ENGINES`. But every run on a Remotion-enabled deployment would pay for the install, HyperFrames runs included, since
  setup can't know the run's engine. It's kept in §13 in case E1 shows setup time is free.

**Skills.** The skills can't be vendored (no license, §1), and `npx remotion skills add` tracks the head of the repo,
so neither goes into runs. `scaffold` instead:
- downloads the pinned commit's tarball (`https://codeload.github.com/remotion-dev/skills/tar.gz/c7cb2fd…`);
- checks it against a sha256 kept in `scripts/lib/engines/remotion.ts`;
- installs only `remotion-best-practices`, `remotion-markup`, `remotion-render` and `remotion-captions` into
  `.agents/skills` and `.claude/skills`, which git doesn't track. `remotion-maps` is added when the look asks for it.
- skips `remotion-studio` and `remotion-interactivity` (Studio-centred), `remotion-docs` (it fetches the web),
  `remotion-upgrade`, `remotion-saas` and `remotion-license`.

A failed download or hash mismatch stops the run with `engine_skills_unavailable`.

---

## 9. Tests

All new tests follow the repo's habits: unit and integration tests in `test/` (in-memory store and PGlite), UI tests in
Playwright, and live tests as `scripts/e2e/*.ts` with `--dry`, a credit ceiling, JSON-line logs and cleanup even on
failure. A **live test** is a script that makes real videos on a deployed site and checks them, so it costs credits.

**No test in Netlify's CI installs or renders with Remotion** (§1.1). Every test in CI runs without Remotion installed:
- the service-side tests use pure JSON;
- the run-side tests use a stub renderer.

That keeps CI free of Remotion use, and keeps the plan's tests runnable by anyone.

**Unit (vitest)**

- `test/engines.test.ts`:
  - the registry and `enabledEngines` (env × enabled × tier, 8 cases);
  - capabilities per phase;
  - the engine choice rule (request, the look's first *enabled* engine, default), including a look listing
    `["remotion", "hyperframes"]` with Remotion off picking HyperFrames;
  - `409 engine_disabled`, `400 engine_not_supported_by_look` and `409 engine_unsupported` at create (REST and MCP);
  - `scopeCheckFor` returns null where the capability is false.
- `test/prompt.test.ts`: the HyperFrames prompt is byte-identical to today's for the same `PromptInput`. The Remotion
  prompt contains no `hyperframes` string, and does contain the Studio override, the check command, the
  no-network rule and "don't install packages".
- `test/run-manifest.test.ts`: the `engine` field (absent → hyperframes; unknown → rejected; tier only with remotion).
- `test/finalize.test.ts`:
  - engine id mismatch and bundle-shape mismatch fail with `engine_mismatch`;
  - a Remotion bundle with a changed lockfile, `src/Root.tsx`, `src/index.ts` or `src/va/` file, a stale
    `src/registry.ts`, or an extra file such as `babel.config.js` fails;
  - `engine.renders` adds to the monthly count.
- `test/lifecycle.test.ts`: revisions, remixes, edits and retries inherit the engine, and a forced mismatch is refused.
- `test/settings.test.ts`:
  - only admins can save the license choice;
  - "Company License" without `VIDEO_AGENT_REMOTION_KEY` returns `remotion_key_missing`;
  - the record keeps who and when;
  - turning it off keeps existing videos editable.
- `test/run-tools.test.ts`: the logger masks `rm_sec_…` strings.
- **Phase 3:**
  - `test/contract-remotion.test.ts`:
    - every v1 check in §5.2, one fixture per violation and its message;
    - `applyEdits` with `delete` removes the beat's file and folder and regenerates the registry, and the result
      passes check rule 2;
    - `reorder` leaves the registry unchanged.
  - `test/scope-remotion.test.ts`: the Remotion `scopeCheck` refuses each change outside the scope (a layer file, a
    shared helper, the music file, a frozen beat's props entry, `colors`, the beat order, a frozen beat's caption cue),
    and returns the spliced files when it passes.
  - `test/contract-conformance.test.ts`: paired fixtures (a HyperFrames `index.html` and a Remotion `props.json`
    describing the same video). A table of named op sequences: each op alone, then text+retime, retime+reorder,
    delete+reorder, colour+media, retime to the minimum, delete all but one. Both engines must give the same
    `Composition`, captions and frame totals. Ops an engine doesn't list are skipped. Every edit bug found in either
    engine becomes a row. (Seeded random sequences are in §13.)

**Run side (`scripts/lib/engines/remotion.test.ts`)**

- `hydrate` refuses each tampered locked file and each file outside the allowed paths with `engine_tampered`.
- An install step past its timeout fails with `engine_install_failed`, using a stub that never exits.
- The skills tarball's hash check, and that only the four named skills are installed.
- The render-count tally, and that every still is rendered with `licenseKey` set (a stub renderer records the options).
- The key never appears in a spawned command's arguments or in the log, and the render passes no `envVariables`.
- `engine.ts mix` computes the gain from a fixture track's measured loudness and lowers it for true peak.

**Template tests** (`engines/remotion/template`, own lockfile, `npm run test:remotion`). These render with Remotion,
so they're **never in Netlify's CI**. Two cases run them:
- a contributor on their own machine, under their own license status;
- at Netlify, the POC session, and later only if Netlify buys a license.

- `renderStill` of fixture props at fixed frames gives the same PNG hash twice (determinism).
- A props edit (retime, reorder) renders the expected frames at beat boundaries.
- The static scan catches each pattern in §5.2's check 3, including `process.env`.
- `renderStill` accepts `licenseKey` at the pinned version (a render with a bad key still completes, since telemetry
  never blocks a render).
- Every render passes `isProduction: false`.

**Playwright**

- Admin:
  - the Remotion switch is hidden without `ENGINES`;
  - the dialog needs a tier, and "Company License" without the key shows the `remotion_key_missing` message;
  - saving shows the record on `/setup`.
- New video (with the looks plan):
  - a look whose engines are all disabled shows greyed ("needs Remotion (off)");
  - the Engine select under Advanced appears only when the chosen look lists more than one enabled engine.
- Editor on a Remotion fixture:
  - unsupported controls are hidden (Narration; audio and re-voice before Phase 4);
  - in Phase 3, `apply-edits` round-trips through a stub Player page and the bridge.

**Live tests (`scripts/e2e/engines.ts`)**

- **Inputs:** `VIDEO_AGENT_URL`, `VIDEO_AGENT_KEY`, `CREDIT_CEILING` (default 800), `--dry` and `--keep`.
- **How each one runs:** first `--dry`, which prints the steps and the projected credits and spends nothing. Then the
  script **asks the owner before each gate** ("Run gate 2: 3 videos, about 450 credits, ceiling 800? [y/N]"). There's
  no blanket approval, and it stops at the ceiling.
- **Logging:** one JSON line per step, `{ step, videoId, attempt, ms, credits, renders, ok, detail }`.
- **Remotion renders** in tests are development renders (`"free-license"`, plus `isProduction: false` where the API
  accepts it).
- **The POC is the only Remotion live test Netlify runs without a license.** Gates 3 and 4 run at Netlify only after
  a license, or by a contributor against their own deployment.

| Phase | What the gate does | Checks |
| --- | --- | --- |
| 1 (optional) | One HyperFrames create and one browser edit render, ~290 credits. Phase 1's real gate is the unit suite plus the prompt test, since nothing should change. | Status, `engine: hyperframes`, contract 1, edit ops applied, captions synced |
| POC (E1 + E2, once) | On a scratch project (not production): the install timing run, then S1's three briefs, one with music, and one revision; ~760 credits, ceiling 800 | `engine: remotion`; MP4 probe; poster, GIF and captions present; captions match `summary.json`; integrated loudness within ±1.5 LU of −14 for the music video; render counts recorded; time and credits logged next to S1's numbers |
| 3 | A Remotion edit (text, retime, reorder, colour) rendered unchanged, ~40 credits | Contract 1; the edited text appears in the captions; beat order in the frames (stills at beat midpoints compared with the draft preview's stills, SSIM ≥ 0.97); a redo of one scene leaves the other beats' files unchanged |
| 4 | A Remotion video with effects and voice-over, ~250 credits | Voice captions present; music ducked (RMS of the music lower during voice spans) |

---

## 10. Separate, cheaper path: importing Remotion code into HyperFrames

HyperFrames' `/remotion-to-hyperframes` skill turns an existing Remotion project into a normal HyperFrames video,
editable in the browser, with nothing Remotion-licensed afterwards. It's a different feature from this engine and is
listed in §13 (with its license caveat) so nobody builds the engine to get it. See the HyperFrames skill docs
(`npx hyperframes docs`, `hyperframes.heygen.com/llms.txt`).

---

## 11. Build order

Each phase ends with a gate. Live tests spend credits, so each runs `--dry` first, asks the owner before each gate, and
has a ceiling (§9). The order follows the owner's decision (2026-11-04): build the engine, run one POC, then decide.

| Step | Roadmap wave | What | Depends on |
| --- | --- | --- | --- |
| E6 | 0 | Ask Remotion for written OK (owner question 1) | Nothing; first |
| E3–E5 | 0 | Local spikes: contract, Player sandbox, determinism | E6's answer, or the owner's call to proceed under §1.1's reading |
| Phase 1 | 1 | The seam, HyperFrames only; no Remotion code | Nothing; blocks regenerate-beat phase 1, screen-recording phase 2, looks phase 5 |
| Phase 2 | 3 | Remotion authoring, built **off and hidden**; music allowed | Phase 1, looks phase 2, E3–E5 |
| POC (E1 + E2) | 3 | One session of development renders on a scratch project | Phase 2, E6's answer (or the owner's call), and the owner's yes at each gate |
| Decision | — | Buy a license, or stop at Phase 2 (owner question 2, decided) | The POC's videos |
| Phase 3 | 4 | Editing Remotion videos; redo a scene | A license (at Netlify), or a contributor; regenerate-beat phase 1 |
| Phase 4 | 5 | Effects and voice | Phase 3, same condition |
| Phase 5 | 5 | Docs (bring your own license); Remotion looks only with a license | cli-and-sdk phase 6 |

### Phase 0: local spikes and the license question (a new "Engine spikes" section in `docs/spikes.md`, labels E1–E6)

| Spike  | Question | How | Cost |
| ------ | -------- | --- | ---- |
| **E6** | Licensing (start first): email Remotion (hi@remotion.dev) asking for written OK for Netlify's one-off evaluation as §1.1 bounds it (local spikes plus one POC session of development renders) and for publishing the integration in an MIT template. Also ask them to confirm that a deployer's use is Automators and that the Player is covered; when 5.0 ships and what else it changes; does `/remotion-to-hyperframes` render the original with Remotion? The key's format and the free-license value are already answered (§1) | Read the repos, docs and Terms; email Remotion | 0 |
| **E3** | Does the props-driven contract hold up? Hand-build a contract project, apply every edit op as props, render, compare frames and captions; write the conformance suite's first fixtures | Local (`spikes/e3`) | 0 credits |
| **E4** | Can `@remotion/player` run in our `/preview` sandbox (CSP `default-src 'none'`, scripts only from the capability path, `sandbox allow-scripts`)? Which of the CSP's allowances the Player relies on (`'unsafe-inline'` scripts and styles; workers, which fall back to `default-src 'none'` with no `worker-src`, `src/lib/preview.ts:57–71`). Bundle size, cold start, seek accuracy vs the MP4 (SSIM, as in S7), bridge round trip | Local Playwright spike modelled on `spikes/s2` | 0 credits |
| **E5** | Determinism and offline: are the same props rendered twice identical? Do fonts load through `@remotion/fonts` and `staticFile` with the network blocked? Does `OffthreadVideo` work with library clips? Which config files does Remotion's webpack setup read from `video/` (babel, postcss, browserslist, `.env`), so the allowed-paths list (§5.1) is complete? Is a `REMOTION_` variable inlined into the bundle through the Node `bundle()` API too, or only through the CLI? | Local | 0 credits |

E6 goes first: it's an email, and it costs nothing.
- **If Remotion gives written OK**, E3–E5 go ahead.
- **Until it answers**, the owner can choose to go ahead with E3–E5 under §1.1's reading. They're a few developers'
  local evaluation, produce no commercial output, and are never published.

Gate: the spikes are written up.

### Phase 1: the engine seam, HyperFrames only (no behaviour change)

1. `src/domain/engines.ts` with `EngineId`, `EngineInfo`, `EngineCapabilities`, `enabledEngines`, and the named
   `ScopeCheck` / `scopeCheckFor` hook (returning null until regenerate-beat registers HyperFrames').
2. `contractOf`'s two callers (`bundles.ts:179`, `edits.ts:409`) switch on the version's engine. Non-HyperFrames
   returns `contract: null`.
3. The `versions.engine` column (default `hyperframes`, the first migration in the roadmap's order), the run manifest
   field, render-job's `engine` manifest field, and finalize's two engine checks.
4. `scripts/lib/engines/types.ts` and `hyperframes.ts` (`render`, `contract`, `version`). render-job calls the run
   engine, and prepare-run follows the step order in §4.3, with the `scaffold`/`hydrate` hook points in step 1.
   `scripts/engine.ts` waits for Phase 2.
5. The DTO's `editing: { engine, capabilities }` next to `editable`.

Gate: every existing test passes untouched, and the HyperFrames prompt is byte-identical (Phase 1 doesn't touch the
prompt). The live test is optional.

### Phase 2: Remotion authoring, not yet editable (music allowed)

1. `ENGINES`, the settings columns (the engines phase 2 migration), the Admin dialog with the tier radio and
   `remotion_key_missing`, the `/setup` row, `GET /api/v1/engines`, the `engines` feature string, `engine` on create
   (REST, MCP `create_video`, OpenAPI regenerated so the SDK and CLI get it), and the monthly render count on the Admin
   usage page.
2. `engines/remotion/template/` with the `va/` runtime (music path only), its AGENTS.md and the locked-file hashes.
   It includes the generated `src/registry.ts` and the allowed-paths list.
   `scripts/lib/engines/remotion.ts` (scaffold, hydrate, check, snapshot, render, mix, render tally, key handling,
   install timeouts) and `scripts/engine.ts`. The install option from E1, and the pinned skills download.
3. `EnginePrompt`: HyperFrames' lines moved word for word, plus the Remotion author and revision steps.
   `PROMPT_TEMPLATE_VERSION` +1 in merge order. The root `AGENTS.md` line added.
4. UI:
   - engine choice through the look (looks plan), with the Advanced select when the look lists two enabled engines;
   - a small "Remotion" tag in the video page details;
   - the editor's "not editable yet" state;
   - Narration hidden;
   - Sound limited to Silent or Music.
5. The README "Render engines" section, the trust-model line about license reporting, and the configuration table
   rows (`ENGINES`, `VIDEO_AGENT_REMOTION_KEY`).

Gate: the unit, run-side and Playwright suites pass **with no Remotion installed in CI** (§9). A Netlify developer
may render locally while building it, inside §1.1's evaluation. Phase 2 merges with `ENGINES` unset everywhere
Netlify runs, so the engine ships off and hidden.

### The POC: one session, then stop (spikes E1 and E2)

| Spike  | Question | How | Cost |
| ------ | -------- | --- | ---- |
| **E1** | On the runner: first, does `ldd` on Chrome Headless Shell find every shared library (§2)? Then, how long do `npm ci --ignore-scripts` of the template and `npx remotion browser ensure` take, how big are they, and what do they cost? Does the renderer work after `--ignore-scripts`? Does setup time fall inside `deadlineMs = (authoringDeadlineMin + 3) * MIN` (`reconciler.ts:174`), and is it billed? What's the browser archive's sha256? Also time option C (download and unpack from Blobs), and record the time and size of both Chrome installs (HyperFrames' in setup and Chrome Headless Shell) and the median of each install step, which sets the timeouts (§8). | Part of the POC session: one run with a script-only prompt (install, ensure, render a fixture, time each step), then the same from a Blobs tarball. Results go in `docs/spikes.md` next to S1 | 1–2 runs, ~60 credits |
| **E2** | Authoring quality and cost from scratch with the four skills and our template, on S1's three briefs (launch 16:9, sales 9:16 15 s, tutorial 1:1 60 s). Check rounds × seconds per round (bundle + Chrome launch), renders per video, CRF vs file size (and a note that 5.0's `bt709` default colour space and ANGLE GL renderer will need the calibration redone), whether `renderStill` accepts `licenseKey` at 4.0.540, and which static-scan rules agents actually break | Part of the POC session: three create runs and one revision on the scratch project, same rubric as S1. The owner judges whether the videos are "incredibly amazing" (owner question 2) | 4 runs, ~700 credits |

- **Where:** a scratch Netlify project in our team, deployed from the Phase 2 code, with
  `ENGINES=hyperframes,remotion` set there only and the admin dialog on "Free License" (evaluation). Our production
  deployment keeps `ENGINES` unset.
- **How:** `scripts/e2e/engines.ts --poc`, `--dry` first. The owner says yes before each gate (install timing, the
  three briefs, the revision). The ceiling is 800 credits.
- **Renders:** development renders only (`"free-license"`, plus `isProduction: false` where accepted).
- **The videos:** for the owner to judge, never published or used.
- **Afterwards:** the results go in `docs/spikes.md`. The scratch project's `ENGINES` is removed, or the project is
  deleted, the same day.
- **Gate:** the owner decides (owner question 2).
  - **"Incredibly amazing" → buy Remotion for Automators.** Then Phases 3–4 and Remotion looks go ahead with
    licensed live tests.
  - **Otherwise → stop at Phase 2.** The engine stays in the template, off and hidden, as "bring your own license".
    Phases 3–4 stay in this plan for a contributor with their own license status, who brings their own live-test
    evidence with the PR. Netlify makes no more Remotion renders.


### Phase 3: editing Remotion videos, and redoing a scene

1. `src/lib/contract-core.ts`, if regenerate-beat or screen-recording hasn't built it yet. `contract.ts` moves to
   import it, guarded by today's contract tests.
2. `src/lib/contract-remotion.ts` (validate, read, applyEdits), the `EngineEditing` interface, and the conformance
   suite.
3. Render-unchanged runs on Remotion render the frozen `props.json`.
4. The Player preview bundle, built in render-job and served by `/preview` through `PreviewSpec`, with the bridge
   inside it.
5. `scopeCheckFor('remotion')` and `RunEngine.scopeCheck` for Remotion, so `scopedRevision` is true.

Gate: the Phase 3 live test (a licensed Netlify run, or a contributor's evidence), plus a Playwright run of the editor
against a real Remotion bundle, from the same source.

### Phase 4: effects and voice on Remotion

1. Per-beat `sfx` and ducking from voice spans in `<VaAudio>`, and the editor's `audio` op.
2. `scripts/voice.ts` behind the engine (the tag and sync), and re-voicing in the editor.
3. Lift `409 engine_unsupported` for Music + effects and voice-over.

Gate: the Phase 4 live test, under the same condition as Phase 3.

### Phase 5: docs and looks

1. The engine docs on cli-and-sdk's `/docs` pages: "Engines" in the API page, and `engine` and `--engine` in the SDK
   and CLI references.
2. Remotion-only looks (3D product, map story, data charts) in the Looks catalogue, only with a license or a
   contributor (making them takes renders). Their template dependencies are added to the lockfile.
3. A "Making an engine" contributor doc: the interfaces, the conformance suite, the locked-file rule, and what a third
   engine needs.

**Local mode** (cli-and-sdk plan): `video-agent local --engine remotion` needs `--accept-remotion-license`, and prints
this plan's license notice once. The CLI runtime bundle carries `engines/remotion/template/` (the lockfile, not
`node_modules`) and runs `npm ci --ignore-scripts` on first use. On someone's own machine an individual is on the Free
License, so local mode passes `"free-license"` unless they set `VIDEO_AGENT_REMOTION_KEY`. It's the cheapest way to try
the engine: make one locally, then deploy it for your team (with your own license). The license notice says that the
Free License covers individuals and organisations of up to 3 people, and that anyone else needs their own license
beyond evaluation.

---

## 12. Risks

- **License misunderstanding is the biggest risk.** A company turns Remotion on without a license and blames the
  template. Mitigations:
  - off by default, behind two locks;
  - plain wording in four places;
  - a recorded tier, and a key required for "Company License";
  - per-render reporting to Remotion, and a monthly render count shown to the admin;
  - no Remotion package in the app's own dependencies.
- **Netlify's own evaluation overstepping.** A second "quick look", a scratch project left on, or a POC video used in
  a deck would turn evaluation into use. Mitigations:
  - one session, with the owner's yes at each gate;
  - `ENGINES` removed from the scratch project the same day;
  - no Remotion in Netlify's CI;
  - Remotion's written OK asked for first (owner question 1).
- **Authoring quality may start below HyperFrames'.** HyperFrames' skill and our contract evolved together over 16
  prompt versions. E2 measures it. If it's clearly worse, Remotion ships only with the looks it's best at, not as a
  general choice.
- **Thinner QA:** no layout, motion or contrast checks. Mitigated by the render smoke test, the contract scan, agent
  review of stills, and a plain note in the summary.
- **Install time and cost** could make every Remotion video slower and pricier. E1 decides, and option C exists.
- **Supply chain:**
  - Runs install from npm: lockfile integrity hashes, `npm ci --ignore-scripts`, exact versions.
  - Restored archives carry config: the locked-file hashes and the allowed-paths list (§5.1).
  - Installs that hang: a timeout per step and `engine_install_failed`, so they don't burn credits to the deadline.
  - The browser download isn't pinned by Remotion: option C, or our own pinned hash.
  - Skills come from GitHub at scaffold time: a pinned commit and a checked hash.
- **The key leaking:**
  - never on a command line, read from env inside the renderer process, masked in logs;
  - not `REMOTION_`-prefixed, so Remotion's CLI doesn't inline it into composition code, and `process.env` is banned
    in `src/`.
  - A leaked key lets someone have renders reported against the deployer's remotion.pro account. Admins are told to
    rotate it on remotion.pro.
- **Telemetry egress:** Remotion learns which license key rendered, how often, and whether it was production or
  development (server-side renders don't send the domain or IP), and keeps it indefinitely. That's disclosed, and
  inherent in using Remotion at all from 5.0.
- **Snapshot rounds** cost time and renders. Each call renders its stills on one browser, the bundle is cached, every
  still is reported, and the prompt says each call costs.
- **Remotion 5.0** changes the license (contractors written in, reporting mandatory), APIs (`inputProps` required)
  and output bytes (`bt709`, ANGLE). We pin 4.0.x and
  plan the move as its own change (owner question 8). Our gate already sends a key or `"free-license"`, so the
  reporting rule needs no redesign.
- **No transitions across beats (`TransitionSeries`)** in v1, because they overlap two sequences. That's a creative
  loss on Remotion. A later contract version could allow a declared transition owned by the next beat.
- **Two edit implementations can drift.** The conformance suite guards it, and it runs in CI on every change to either.

## 13. Not in v1

Kept with their design, so nothing is lost:

- **Recorded narration, fit to narration and the hold frame on Remotion.** They'd need props equivalents of the
  narration bus layer and guards.
- **Remix or restyle across engines** (a HyperFrames video re-made in Remotion or back): a new video from the old one's
  script and props, with no shared source.
- **`TransitionSeries`** and other overlapping sequences.
- **Remotion Lambda**, or any render outside the Agent Runner. **Client-side rendering** with `@remotion/web-renderer`.
- **Checkpoint preview bundles** for live progress on Remotion. Build the Player bundle at each `checkpoint.ts --bundle`
  call so people can watch a Remotion video take shape. Measure the build time in E4 first.
- **Three more static-scan rules**, added if E2 shows agents break them:
  - no JSX text literal longer than two words outside `<VaText>`, so on-screen copy can't hide from the editor;
  - no hex, `rgb()` or named colours outside `src/va/`;
  - no `fetch`, `XMLHttpRequest`, `Math.random` or `Date.now` in `src/`.
- **An automated contrast check:** `<VaText>` writes `data-va-text` onto its element. A check opens each snapshot
  frame's page in the renderer's browser, reads each text element's computed colour and the colour behind it, and
  reports WCAG contrast, mirroring HyperFrames' check.
- **Seeded random op sequences** in the conformance suite (200 per run), after the named sequences are stable.
- **Installing in setup (option A):** a gated `run` step in `netlify-agent-kit` (`node scripts/engines-setup.mjs`, a
  no-op unless `ENGINES` includes `remotion`). Revisit only if E1 shows setup time is free.
- **A third engine.** Motion Canvas is MIT, and would mean "pluggable" isn't only "pluggable into a paid one". The
  interface, locked-file rule and conformance suite are meant to make it possible (owner question 9).
- **Importing a Remotion project into HyperFrames** (§10): an **Import** entry on New video takes a zip of a Remotion
  project. A run installs `/remotion-to-hyperframes` (a pinned skill source from the HyperFrames repo, or
  `npx hyperframes skills update remotion-to-hyperframes` in setup), converts it, and keeps the contract. **License
  caveat:** if the skill renders the original with Remotion to compare frames, that step uses Remotion, and the
  deploying company's license status applies. E6 finds out. If it does, the import needs the same gate as the engine,
  or skips the comparison and says so.

## 14. Owner questions

1. **Ask Remotion for written OK first?** The request covers Netlify's one-off evaluation as §1.1 bounds it (local
   spikes plus one POC session of development renders on a scratch project) and publishing the integration in an MIT
   template. *Recommended:* yes, send the email now (spike E6), and run the POC only after an OK.
   - If Remotion is slow to answer, the owner can let E3–E5 (local only) go ahead under §1.1's reading.
   - If Remotion says the POC needs a license, the choice is between buying one month of Automators ($100 minimum)
     for the POC and stopping at Phase 2 unrendered at Netlify.
2. **Decided (2026-11-04): license only if the POC is outstanding.** Netlify runs one POC and buys Remotion for
   Automators only if it "makes incredibly amazing videos". The owner judges the E2 videos against S1's.
   - Without a license, Netlify stops at Phase 2. Phases 3–4 stay open to contributors.
   - Deployers bring their own license.
3. **Decided (2026-11-04): off and hidden by default, behind an env var and a database setting.** That's `ENGINES` plus
   the admin's license choice, both required. With `ENGINES` unset, nothing about Remotion shows (§1).
4. **Decided (2026-11-04): Remotion stays off on our own production deployment.** "We probably won't use it
   ourselves." Revisit only after a license.
5. **Live preview of Remotion edits with `@remotion/player` (Phase 3), or MP4-only editing?** This only matters if
   Phase 3 happens. *Recommended:* the Player, if E4 passes; MP4-only otherwise.
6. **Install strategy: per run (B) or a primed, hash-checked tarball (C)?** *Recommended:* C, with B as the fallback
   before a tarball is primed. C pins the browser and `node_modules` to a hash the server chose, even if B is fast.
   The POC (E1) confirms the Blobs download works and is timed.
7. **`VIDEO_AGENT_REMOTION_KEY` scopes "builds and functions"**, so the server can see it's set (never its value)?
   *Recommended:* yes, marked secret. The name avoids the `REMOTION_` prefix on purpose.
8. **Remotion version:** pin 4.0.540 and plan 5.0 as its own change? *Recommended:* yes.
   - Pin the `@remotion/compositor-*` packages explicitly in the template lockfile.
   - Our key handling already meets 5.0's reporting rule.
   - The move redoes E2's CRF and size calibration for `bt709` and ANGLE.
9. **A fully open second engine (Motion Canvas, MIT): now or later?** *Recommended:* later. Ship the interface and
   conformance suite and invite one from the community. Given the decisions above, an MIT engine is the only kind
   Netlify could test freely.
10. **Import a Remotion project into HyperFrames as its own small plan?** *Recommended:* not now. The v5.0 Terms say a
    service letting end users upload their own Remotion code needs Remotion's written approval, and an import with a
    frame-by-frame comparison renders uploaded Remotion code. Raise it in the E6 email if we ever want it.
11. **Is per-render license reporting to remotion.pro (license key, event type, production or development; kept
    indefinitely) acceptable for the POC?** *Recommended:* yes. Server-side renders send no domain, IP or content, and
    it's the same for every deployer who turns Remotion on.

---

## 15. Review log

### Draft 1 → 2

The cross-plan seam review's rule numbers below are that review's numbering. The plan body now cites the roadmap's
shared rules 1–10.


**Independent review (Fable 5.1, "sound with changes")**

| Item | Decision | Why |
| ---- | -------- | --- |
| A1 License mechanism: v4 in force, 5.0 makes a key or `"free-license"` mandatory; tier radio; `remotion_key_missing`; mask the key; `isProduction: false` in spikes/CI/gates; version facts; drop the "unverified" line | **Adopted with changes** | Confirmed on remotion.dev (/docs/licensing, /docs/5-0-migration, /docs/options/is-production). Instead of masking a `--license-key` argument, the key never reaches a command line: the render uses the Node API and reads env (§5.5), with masking as a second guard. `--is-production` needs a key, so free-license renders keep the default. The 4.0.237 / 4.0.409 / 4.0.539 thresholds aren't confirmed by docs and are cited as the reviewer's (all below our pin) |
| A2 Skills can't be vendored; download the pinned tarball with a hash; install four skills; override Studio in AGENTS.md too | **Adopted** | Verified: `license: null`, no LICENSE file, `"private": true`, mirrors `packages/skills`. §8, §5.3 |
| A3 Count every render, snapshots included; Admin monthly count; one `--frames` sequence instead of stills; "billed in 1,000-render increments" | **Adopted, except the increments** | The Terms' render definition includes stills. I couldn't confirm 1,000-render increments, so the plan shows counts and points to remotion.pro |
| A4 Shrink Phase 1 (engines.ts minimal; contractOf switch at `bundles.ts:179` and `edits.ts:409`; contract-core and read/applyEdits to Phase 3; live gate optional) | **Adopted, reconciled with the cross-plan review** | `contract-core.ts` and `scopeCheck` are named in Phase 1. Whichever plan lands first with a real second consumer builds `contract-core.ts`; Phase 3 at the latest. The run-side `RunEngine` stays in Phase 1 because local mode consumes it at once. `EnginePrompt` moves to Phase 2 for the same no-consumer reason |
| A5 Supply chain through restored archives | **Adopted** | Locked-file hashes in `hydrate`, `check` and finalize; `--ignore-scripts`; no new dependencies in v1 (§5.1) |
| A6 Music on Remotion in Phase 2; only `music_sfx` and voice-over 409 | **Adopted** | A `sound` capability (`none`, `music` or `all`); looks' `sound.musicMood` feeds the pick |
| A7 One source of truth: import `props.json` in `Root.tsx`, drop `--props` | **Adopted** | §5.1 |
| A8 Finalize checks engine from bundle shape | **Adopted** | §4.2 |
| A9 Siblings; Remotion looks have an empty registry; the Action passes `engine` | **Adopted** | §6, header |
| A10 `selectComposition` instead of `remotion compositions`; E1 deadline check; option A wording; root AGENTS.md wording; ldd first | **Adopted** | All verified or harmless; option A's `run` step can read env, wording fixed |
| Citation fixes (GSAP `:232`, render `:202`, `relayout :1026` not exported, compositor size) | **Adopted** | Verified in the code: also poster `:275`, previews `:344`, version `:410`, `syncCaptions :1060`; compositor size cited from `npm view` |
| Contractors already aggregate under 4.0 | **Adopted with changes** | The plan says only what the 5.0 guide states (contractors count from 5.0) and that headcount decides; I couldn't confirm the 4.0 wording |
| Evaluation ends once the stack is set up; strengthen Q1 | **Adopted** | Only E6 runs before the license decision; Q1 now says "before any spike beyond E6" |
| Player embedding is Automators use for Company License holders; previews aren't renders | **Adopted** | Terms and FAQ confirm; §4.4 and the dialog |
| `@remotion/licensing`, `@remotion/fonts` MIT | **Adopted** | `npm view` confirms (also `@remotion/media-utils`) |
| Missed risks (key in logs, telemetry egress, unpinned browser, skills from GitHub, snapshot round cost, Company-License-without-key breach) | **Adopted** | §3 gotchas 11–13, §7, §8, §12 |
| Over-built: static-scan rules 3c–3e | **Adopted with changes** | Moved to §13 with their design; kept a cheap remote-URL / Google Fonts grep, since a remote font breaks offline renders |
| Over-built: DOM contrast check, checkpoint preview bundles, 200-sequence fuzzing, option A | **Adopted** | All moved to §13 with their design; named sequences in v1 |
| Over-built: §10 import path | **Adopted** | §10 is now short, with the design and license caveat kept in §13 |
| Over-built: a public `GET /api/v1/engines` | **Rejected** | The cross-plan rules keep it as the detail call behind `features`: the SDK's `engines.list()` and the CLI's `--engine` help need the enabled list, capabilities and license notice, which `features` doesn't carry. It moves to Phase 2 with the first second engine |

**Cross-plan seam review (render-engines section and shared rules)**

| Item | Decision | Why |
| ---- | -------- | --- |
| 1 `scopeCheck?` on `Engine`/`RunEngine`; `409 not_editable` when `scopedRevision` is false | **Adopted** | §4.1, §4.3 |
| 2 No "except the version line"; no literal version | **Adopted** | Verified: the constant isn't in the prompt text (`reconciler.ts:457`) |
| 3 `editOps` admits `span`, `camera`, `cursor`, `redact`; a `recording` capability; screen-recording is HyperFrames-only | **Adopted** | `EditOpName` in §4.1; conformance suite skips unlisted ops |
| 4 Keep `editable`, add `editing: { engine, capabilities }` | **Adopted** | `videos.ts:898` verified |
| 5 prepare-run order | **Adopted** | §4.3 |
| 6 Engine choice rule owned by looks; Playwright wording | **Adopted** | §4.2, §9 |
| 7 Local mode `--accept-remotion-license`; CLI bundle carries the template lockfile | **Adopted** | §11, with `"free-license"` as the local default for individuals |
| 8 Docs depend on cli-and-sdk phase 6 | **Adopted** | Phase 5 |
| 9 Spike labels E1–E6 | **Adopted** | `S0`–`S13` already exist in `docs/spikes.md` |
| 10 `engines` feature string; `GET /api/v1/engines` as the detail call | **Adopted** | §7 |
| Shared rule 6: `contract-core.ts` named here, built by the first plan to land | **Adopted** | Reconciled with A4 (above) |
| Shared rule 5: manifest stays `v: 1` | **Adopted** | Verified at `run-manifest.ts:295` |
| Shared rule 15: people-facing "scene" | **Adopted** | "Redo a scene" in §6; code keeps `beat` |
| Build order and migration order | **Adopted** | §11 header, §4.2 |

### Draft 2 → 3 (remote review: Fable 5.1, high effort, Netlify Agent Run at `19740d8`, "sound with changes")

| Item | Decision | Why |
| ---- | -------- | --- |
| R1 Lock `src/Root.tsx` and `src/index.ts`; a generated, checked beat/layer registry | **Adopted** | A changed `Root.tsx` would pass `selectComposition` and make editor edits do nothing on screen. Webpack can't import by a runtime string, so the registry is `src/registry.ts`, generated with static imports (not the lazy `() => import()` the review sketched, so nothing loads asynchronously mid-render) |
| R2 Snapshot stills through `renderStill()` on one browser, not `renderFrames()` | **Adopted** | The license-key docs list `renderMedia()` and `renderStill()`, not `renderFrames()`. The render-still docs confirm `openBrowser()` + `puppeteerInstance` reuse. `renders` becomes `{ video, stills, audio }` (audio kept for Phase 4 instead of the review's two-field shape) |
| R3 `delete` removes the beat's file so check rule 2 holds | **Adopted** | `EditOp` `delete` (`src/lib/contract.ts:1006`) only touches props otherwise. Also regenerates the registry; `reorder` and library `media` change no files |
| R4 Freeze everything outside scoped beats on Remotion, mirroring regenerate-beat §4.4 | **Adopted** | Checked against `2026-11-04-regenerate-beat.md:315–316` ("byte-identical and still present … new files only under `assets/`"). Plus the registry is exempt, since it's regenerated |
| R5 Phase 2 music level from ffmpeg on the source file, no audio render | **Adopted with a note** | With one bed and a linear gain the output's loudness is the source's plus the gain. Fades lower it slightly, inside the gate's ±1.5 LU. The full-mix audio render moves to Phase 4 |
| R6 Correct telemetry contents and contractor wording | **Adopted with changes** | remotion.dev/docs/licensing: key, host domain (web-renderer only) and event type; IP only for `@remotion/web-renderer`; kept indefinitely. I couldn't confirm a "success flag", so the dialog doesn't claim one. The FAQ's collaboration rule (combined headcount) supports "people you work with count already"; the exact "contractors aggregate" quote wasn't confirmable, so the wording follows the FAQ's collaboration example |
| R7 Rename the key off the `REMOTION_` prefix; ban `process.env` in `src/` | **Adopted with a note** | The env-variables docs confirm the CLI inlines `REMOTION_*` and reads `.env`. Our render uses the Node APIs, which don't pick env up by themselves, but agents can run the CLI, so the rename is cheap insurance. E5 checks the Node `bundle()` path |
| R8 Install timeouts and `engine_install_failed` | **Adopted** | `runStreaming` takes `timeoutMs` (`scripts/lib/run-tools.ts:141`); deadline is `(22 + 3)` min (`reconciler.ts:174`) |
| R9 Engine choice rule: "first listed engine that's enabled" | **Adopted** | Matches looks §4.14 (`2026-11-04-looks.md:603`); the coordinator's Looks note says the same |
| R10 Phase 1 run side shrinks; `scripts/engine.ts` to Phase 2 | **Adopted with changes** | The roadmap puts local mode in wave 4, so the "consumer at once" reason was wrong. Phase 1 keeps the `RunEngine` type, the HyperFrames `render`/`contract`/`version` and prepare-run's order, with `scaffold`/`hydrate` as optional hook points so the order is fixed for wave-1 plans |
| Claims: `licenseKey` from 4.0.409 | **Adopted** | The license-key page says so; 4.0.237 and 4.0.539 stay the reviewer's |
| Claims: shared-rule numbers | **Adopted** | Body now cites roadmap rules 3 and 4 (`roadmap.md:35–61`); the draft 1 → 2 log keeps the seam review's numbers, with a note |
| Claims: evaluation reading | **Adopted** | The License FAQ bounds evaluation by commercial use only, and draft 2's "setting up the stack" wording wasn't on remotion.dev. E3–E6 now run as local evaluation, which also matches the roadmap's wave 0 |
| Claims: 5.0 `bt709` and ANGLE | **Adopted** | 5.0 migration guide and v4.0.498 release notes; added to §2, E2, Q6 |
| Claims: preview CSP has `'unsafe-inline'` and no `worker-src` | **Adopted** | Verified at `src/lib/preview.ts:57–71`; E4 now reports which the Player needs |
| Missed: other config files Remotion's toolchain loads | **Adopted** | An allowed-paths list in `hydrate`, `check` and finalize; E5 lists what webpack reads |
| Missed: key blast radius, rotation | **Adopted** | §5.5, the dialog, §12 |
| Missed: the license record on `/setup` and the detail call | **Adopted** | Admin-only; `GET /api/v1/engines` never returns it |
| Missed: two Chrome installs per run | **Adopted** | E1 records both; feeds the credits note |
| Over-built: the `/setup` run-log link | **Adopted** | Shows the error code only |
| Over-built: option C's prime button before E1 | **Adopted** | Not beaded until E1 confirms; Q4's recommendation now leans C (the review's point about pinning) |
| Over-built: `renders.sequences` | **Adopted** | Gone with R2 |
| Seam: roadmap bumps the template in "engines 1 (only if a byte changes)" | **Not ours to change** | The plan bumps in Phase 2 and Phase 1 doesn't touch the prompt; recommended to the orchestrator: roadmap → "engines 2" |
| Seam: regenerate-beat says "engines phase 3.5" | **Not ours to change** | It's Phase 3 here; reported to the orchestrator |
| Coordinator (redo-a-scene draft 3): `scopeCheck` returns the spliced files | **Adopted** | One splice for render-job and finalize; `{ problems, files }` in both hooks |
| Coordinator (redo-a-scene draft 3): feedback and scope stills last in prepare-run | **Adopted** | `feedbackStills` empties `video/feedback/` and runs last in `prepare()` today (`scripts/prepare-run.ts:459`) |
| Coordinator (GitHub Action draft 3): the Action has no `engine` input | **Adopted** | Replaces draft 2's "the Action passes `engine` through"; the engine follows the look (§4.2), so the Action needs no Remotion-specific surface |

### Owner decisions (2026-11-04)

| Decision | How it's applied |
| -------- | ---------------- |
| Build the Remotion engine, off and hidden by default; one Netlify POC; no license unless the videos are outstanding; deployers bring their own license | §1 (hidden by default), §1.1 (what the POC may and may not do under the v4 license, FAQ and v5.0 Terms), §9 (no Remotion in Netlify's CI), §11 (E6 → E3–E5 → Phase 1 → Phase 2 → POC → decision → Phases 3–4 only with a license or a contributor), §14 Q1–Q4. Correction: the v5.0 Terms do contain the "technology setup ends evaluation" wording that draft 3 said wasn't on remotion.dev |
| Live tests: `--dry` first, then ask the owner before each gate, with a ceiling | §9; "live test" is defined at first use and used throughout |
| Local mode ships: "make one locally, then deploy it for your team" | §11 local-mode paragraph |
| Unscoped package names; default look None; Action from the repo subfolder | No change needed here: this plan names no packages, the engine choice rule already falls back to `hyperframes` with no look, and the Action has no `engine` input |

---

## Sources

- Remotion License (in the npm package `remotion@4.0.540`, `LICENSE.md`); also
  [github.com/remotion-dev/remotion/blob/main/LICENSE.md](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md)
- [Remotion License FAQ](https://www.remotion.dev/docs/license/faq)
- [Remotion Terms and Conditions (v5.0)](https://www.remotion.dev/docs/terms) and
  [remotion.pro/license](https://www.remotion.pro/license) (Automators, Creators, Enterprise; what counts as a render;
  the Player under Automators)
- [Remotion v5.0 migration](https://remotion.dev/docs/5-0-migration) (contractors count; mandatory reporting)
- [Licensing](https://www.remotion.dev/docs/licensing), [License key option](https://www.remotion.dev/docs/options/license-key),
  [Is Production](https://www.remotion.dev/docs/options/is-production),
  [client-side rendering telemetry](https://www.remotion.dev/docs/client-side-rendering/telemetry)
- [Remotion Agent Skills](https://www.remotion.dev/docs/ai/skills), [`remotion skills` CLI](https://www.remotion.dev/docs/cli/skills),
  and the [remotion-dev/skills](https://github.com/remotion-dev/skills) repository (read with `gh api`: commit
  `c7cb2fd`, 2026-11-02; `license: null`; `package.json` private)
- [Chrome Headless Shell](https://www.remotion.dev/docs/chrome-headless-shell),
  [Linux dependencies](https://www.remotion.dev/docs/miscellaneous/linux-dependencies), [Docker](https://remotion.dev/docs/docker)
- [Visual editing (schema, defaultProps)](https://www.remotion.dev/docs/visual-editing), [Series](https://remotion.dev/docs/series),
  [Sequence](https://remotion.dev/docs/sequence), [Premounting](https://remotion.dev/docs/player/premounting)
- npm registry (`npm view`, 2026-11-04): versions and `license` fields of `remotion`, `@remotion/cli`,
  `@remotion/renderer`, `@remotion/player`, `@remotion/captions`, `@remotion/zod-types`, `@remotion/licensing`,
  `@remotion/fonts`, `@remotion/media-utils`; `dist.unpackedSize` of `@remotion/compositor-linux-x64-gnu`
- `node_modules/netlify-agent-kit/README.md` (v0.4.0) for presets, skill sources, `files` and `run`
- [Licensing (telemetry contents, 5.0 reporting)](https://www.remotion.dev/docs/licensing),
  [Environment variables](https://www.remotion.dev/docs/env-variables), [renderStill()](https://remotion.dev/docs/renderer/render-still),
  [renderFrames()](https://remotion.dev/docs/renderer/render-frames), [Color space](https://www.remotion.dev/docs/options/color-space),
  [v4.0.498 release notes](https://github.com/remotion-dev/remotion/releases/tag/v4.0.498)
- docs/plans/2026-11-04-*.md (sibling plans), `docs/plans/2026-11-04-roadmap.md`, the cross-plan seam review, and the
  remote round-3 review (its result file)
