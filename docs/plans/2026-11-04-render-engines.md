# Pluggable render engines (HyperFrames by default, Remotion opt-in): plan

- **Status:** draft 2 (2026-11-04). Draft 1 had two reviews: an independent review by Fable 5.1 ("sound with
  changes") and the cross-plan seam review of the six 2026-11-04 plans. Every claim was checked against the code and
  Remotion's docs before being folded in, and the review log is at the end (§15). Not built yet, and no beads.
  Phase 0 is spikes E1–E6 (§11). E6 can start now; the others wait for the license decision (open question 1).
- **Ask (owner, 2026-11-04):** "see if we can use Remotion and Remotion skills to create different video styles",
  picked from the idea-wizard list as #3 ("love it, let's do it"). Make the engine that writes and renders a video
  pluggable. HyperFrames stays the default. Remotion is opt-in, never on by default, and gated on its license.
- **Builds on:** the run (`src/domain/prompt.ts`, `scripts/prepare-run.ts`, `scripts/render-job.ts`), finalize and
  bundles (`src/domain/finalize.ts`, `src/domain/bundles.ts`), editing contract v1 (`src/lib/contract.ts`,
  `video/AGENTS.md`), the editor and its sandboxed preview (`src/domain/edits.ts`, `ui/src/pages/Edit.tsx`,
  `netlify/edge-functions/preview.ts`, `src/preview/bridge.js`), and runner setup through `netlify-agent-kit`
  (`package.json` → `netlifyAgent`).
- **Sibling plans (2026-11-04).** The shared rules in the cross-plan review apply. This plan owns four seams:
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
  | GitHub Action (`2026-11-04-github-action.md`) | Passes `engine` through. |

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

**Who must pay.** Eligibility depends on **total headcount**, not on how many people use Remotion (License FAQ). From
5.0, contractors count toward team size (v5.0 migration guide).

**Reporting.** From 5.0, every render must send usage telemetry through the `licenseKey` option: a real key for
Company License holders, or the literal `"free-license"` for the free tier. Today the option is optional. It sends
the IP address, domain, production or development, and video or still. It sends no video content
(remotion.dev/docs/licensing, /docs/5-0-migration).

Most companies that deploy this template, including Netlify, need a Company License to turn Remotion on. HyperFrames
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
    capability path, `sandbox allow-scripts` and `default-src 'none'` (`src/lib/preview.ts:1–60`).
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
- **`licenseKey` / `--license-key`:** documented for `renderMedia()`, `renderStill()`, the web renderers and Lambda.
  `--is-production` marks a render as development so it isn't billed, and works only together with a license key.
  The reviewer gives these version thresholds; I couldn't confirm them, but all are below the 4.0.540 we pin:
  - `@remotion/licensing` from 4.0.237;
  - the render functions' `licenseKey` option from 4.0.409;
  - the CLI flag from 4.0.539.
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
9. **The license applies to us too.** Building and testing the engine at Netlify (spikes that set up the stack, CI that
   renders, live gates, our own deployment) is use by a company of more than 3 people beyond evaluation. Under a
   cautious reading of the Terms, evaluation ends once we start setting up the technology stack. Open question 1.
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
13. **Every still counts as a render.** Snapshot rounds aren't free, either for Automators billing or in time (each
    round is a webpack bundle plus a Chrome launch). §5.4 batches them, and E2 measures "rounds × seconds".

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
/** Problems with an agent's result for a scoped revision: anything outside `beats` that changed. */
export type ScopeCheck = (parent: Map<string, Uint8Array>, agent: Map<string, Uint8Array>, beats: string[]) => string[]
export function scopeCheckFor(id: EngineId): ScopeCheck | null
```

- `scopeCheckFor('hyperframes')` returns the regenerate-beat plan's module when it lands. Until then it returns
  `null`, and HyperFrames' `scopedRevision` capability stays false.
- `scopeCheckFor('remotion')` returns `null` until Phase 3 (§11). Its freeze compares every other beat's
  `src/beats/<id>.tsx` hash and `props.json` entry.
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
  which is true. This is the first migration in the cross-plan order (engines phase 1).
- **One engine per video:** `reviseVideo`, `remixVideo`, edit renders, retries and incorporate-feedback copy the
  engine from the parent. A domain check refuses a version whose engine differs from its parent's
  (`409 engine_mismatch`), which only a bug could trigger, never a request.
- **The engine for a new video** follows the looks plan's rule:
  1. `request.engine` if given, checked against the look's `engines` (else `400 engine_not_supported_by_look`) and
     against the enabled engines (else `409 engine_disabled`);
  2. otherwise the look's first listed engine;
  3. otherwise `hyperframes`.

  A request for a capability the engine lacks gets `409 engine_unsupported`, naming the capability. Examples: Sound
  "Music + effects" or a voice-over on Remotion before Phase 4, or a `recording` on Remotion.
- **Settings** (`db/schema.ts` `settings`, the engines phase 2 migration):
  - `remotion_enabled boolean not null default false`;
  - `remotion_license_ack jsonb null` = `{ by: userId, email, at, tier: 'free' | 'company', note }`.

  No key or secret goes in the database (§7).
- **Run manifest:** an optional `engine` field. Absent means `hyperframes`, so manifests already written stay valid.
  `verifyRunManifest` accepts only known ids, and `v` stays 1 (cross-plan shared rule 5).
- **render-job's manifest:** gains `engine: { id, version, renders? }` next to the existing `hyperframes` version
  string, which stays for older readers. `renders` is Remotion's count: `{ video, stills, sequences }` (§5.4).
- **Finalize checks the engine twice:**
  1. `engine.id` matches the version's engine.
  2. The bundle's shape matches it. HyperFrames means `index.html` at the root. Remotion means `props.json` plus
     `src/Root.tsx` and no root `index.html`, plus the template-identical config files (§5.1). This runs where
     `ensureBundle` builds the bundle index (`bundles.ts:136–195`).

  Either mismatch fails the attempt with `engine_mismatch`, so a run that ignored its prompt and wrote the wrong kind
  of project is caught before it becomes a version. Finalize also adds the run's `engine.renders` to the deployment's
  monthly Remotion count (§7).
- **The video DTO:** keeps `editable` (`videos.ts:898`) as it is, and adds
  `editing: { engine, capabilities: EngineCapabilities }` next to it.

### 4.3 Run side: `scripts/lib/engines/`, `scripts/engine.ts`, and prepare-run's order

The run side is built in Phase 1 because it has a second consumer at once: the CLI plan's local mode bundles
`engine.ts` and `scripts/lib/engines/*` (cross-plan shared rule 13).

```ts
// scripts/lib/engines/types.ts
export interface RunEngine {
  id: EngineId
  /** Seed video/ for an author run (Remotion: copy engines/remotion/template/, install, ensure the browser). */
  scaffold(videoDir: string): Promise<void>
  /** Install what a restored source needs, after checking its config is the template's (Remotion: engine_tampered). */
  hydrate(videoDir: string): Promise<void>
  /** The engine's own checks; 0 errors means ready to render. */
  check(videoDir: string): Promise<{ errors: string[]; warnings: string[] }>
  /** The editing contract for this engine. */
  contract(videoDir: string): string[]
  /** PNG stills at these seconds into .render/snapshots/, in one call (Remotion: one image sequence, §5.4). */
  snapshot(videoDir: string, atSec: number[]): Promise<string[]>
  /** The MP4 at the given quality. */
  render(videoDir: string, out: string, quality: string, onProgress: (pct: number) => void): Promise<RenderReport>
  /** The editor's preview bundle (Remotion, Phase 3: esbuild of the Player host, §4.4). */
  previewBundle?(videoDir: string): Promise<void>
  /** Render-job's guard for a scoped revision (regenerate-beat). */
  scopeCheck?(frozenDir: string, videoDir: string, beats: string[]): string[]
  version(videoDir: string): string
}
```

- **Phase 1** builds only `scripts/lib/engines/hyperframes.ts`: thin wrappers over today's commands, with `scaffold` and
  `hydrate` doing nothing. `render-job.ts` calls `engine.render(...)` where it ran `npx -y hyperframes render` (`:202`)
  and `engine.contract(videoDir)` where it checks the contract (`:85`). Everything after the render stays as it is.
- **`scripts/engine.ts check | snapshot --at 1,3,5 | render | mix`** is one CLI over the run engine named in
  `.render/run-manifest.json` (or `--engine` in local mode). The Remotion prompt uses it. The HyperFrames prompt keeps
  `npx hyperframes check` and `snapshot`, which its skill's work loop already teaches.
- **prepare-run's step order** (owned here, cross-plan shared rule 5; each step skips when the manifest doesn't ask for
  it):
  1. **Source:** `scaffold` for `author` runs, or restore the source/bundle and then `hydrate` for every other kind.
     Revision, render-unchanged and author_from_frozen keep today's restore code.
  2. Library media into `video/assets/media/` (today's step).
  3. The look (looks plan).
  4. Recording files (screen-recording plan), then scope files (regenerate-beat plan).
  5. `.render/run-manifest.json` for render-job (today's step).

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
    index.ts                # registerRoot(Root)
    Root.tsx                # import props from '../props.json'; one <Composition id="main" schema={vaSchema} defaultProps={props} calculateMetadata={vaMetadata} fps={30} …>
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
- **Beats are files.** Remotion's `scopeCheck` freezes every other beat by file hash plus its props entry.
- **The `va/` runtime is ours** (MIT, in this repo, versioned with the contract). It imports Remotion as a dependency.
  It doesn't copy or modify Remotion code, so it isn't a derivative of Remotion, which is what the license's
  "Disallowed use cases" are about.
- **The config and runtime are locked (supply chain, gotcha 11).** `package.json`, `package-lock.json`,
  `remotion.config.ts`, `tsconfig.json` and every file under `src/va/` must be byte-identical to the template's.
  - Their sha256s are kept in `scripts/lib/engines/remotion.ts`.
  - `hydrate` checks them before any `npm ci`, and refuses with `engine_tampered` if one differs. `check` checks them
    again, and finalize checks the bundle (§4.2).
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
2. Every beat id has `src/beats/<id>.tsx`, and every beat file has a beat.
3. A static scan of `src/**/*.tsx` with the TypeScript compiler API (installed in `video/node_modules`):
   - every `<VaText id>`, `<VaImage slot>` and `<VaClip slot>` is a string literal that exists in that beat's props;
   - every text and slot in props is used exactly once;
   - no `@remotion/google-fonts` import, and no `http://` or `https://` string in `src/`. A remote font or image
     breaks an offline render, and the grep is cheap.
4. The locked files (§5.1) match their hashes.
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
uses by then. A **conformance suite** (§9) applies the same op sequences to paired HyperFrames and Remotion fixtures and
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
byte-identical to today's for the same `PromptInput`, with no exceptions. `PROMPT_TEMPLATE_VERSION` follows shared
rule 4: the Phase 2 PR adds 1 to the constant in merge order, because it adds a new template branch. The HyperFrames
bytes don't change, so the PR moves `test/remix-run.test.ts:176` to import the constant if no earlier PR has.

The Remotion author steps (draft wording):

1. "Read the remotion-best-practices skill and the markup and render rules it routes to. **Don't start Remotion Studio
   or open a browser, and ignore the skill's advice not to render**: this machine has no screen and a deadline, and
   render-job renders the video. To see your work, run `npx tsx scripts/engine.ts snapshot --at <seconds>` (all the
   moments you want in one call; each call costs time and counts as a render) and look at the PNGs. The project is
   video/, set up with its dependencies installed."
2. "Follow the editing contract in video/AGENTS.md ("Editing contract v1 (Remotion)"). Write video/props.json first,
   then one component per beat in video/src/beats/, reading every text, colour and media item through the va/
   components. Don't change video/src/va/, package.json, the lockfile, remotion.config.ts or tsconfig.json, and don't
   install packages. Set the composition to {w}x{h}, 30 fps."
3. "Use only files in video/: fonts from video/assets/fonts with loadFont from @remotion/fonts, never Google Fonts or
   any URL. No fetch, no random numbers, no clock."
4. "Run `npx tsx scripts/engine.ts check` until it reports 0 errors." That covers tsc, the contract,
   `selectComposition` and the render smoke.
5–6. summary.json and render-job, unchanged.

The Remotion `video/AGENTS.md` repeats the Studio and render override, since the agent reads it next to the skill.

The root `AGENTS.md` keeps line 8 as it is and adds "unless your prompt names another engine; then read the skill and
run the check it names". Line 12 becomes "Keep the editing contract (in `video/AGENTS.md` for your engine)".

### 5.4 Checks, snapshots and render counts

- **Render smoke:** `engine.ts check` renders the first frame, each beat's midpoint (up to 4) and the last frame as
  **one image sequence** (`renderFrames` / `--frames=a,b,c,d`). One call means one Chrome launch and one bundle, and
  it counts as one image-sequence render rather than several stills. The bundle is cached in `.render/bundle-<hash>`
  by the source hash, so a snapshot and a check on the same source don't bundle twice.
- **Snapshots** for the agent work the same way, as one sequence per call.
- **Agent review:** the prompt has the agent look at snapshots at each beat before rendering, as HyperFrames' work
  loop does.
- **Contrast:** v1 ships without an automated contrast check for Remotion. The design (read `<VaText>` colours from
  the bundle's DOM in the renderer's browser and compute WCAG contrast) is in §13. The version's summary says
  "contrast was reviewed by eye, not measured", like today's "mix measured, not heard" note.
- **Render counts:** every Remotion render the run makes (the video, each snapshot or smoke sequence, any still) is
  tallied by `scripts/lib/engines/remotion.ts` into render-job's manifest as `engine.renders = { video, stills,
  sequences }`. Finalize adds them to the monthly count (§7). We don't claim how Remotion bills them: the count is for
  reconciling against remotion.pro.

### 5.5 Rendering and outputs

- **`render`** calls `renderMedia()` from `@remotion/renderer` (loaded from `video/node_modules`) on the cached
  bundle, with codec h264 and a CRF from the quality map. E2 picks CRFs so file sizes land near today's 1–1.5 MB a
  minute at 1080p.
- **The key:** `licenseKey` is read from env inside the Node process: `REMOTION_LICENSE_KEY` for a Company License,
  or `"free-license"` for the Free License tier recorded in settings (passed in the run manifest as
  `engine: { id: 'remotion', tier }`).
  - The key never appears on a command line, so nothing shows in a process list or in `runStreaming`'s output tail.
  - `scripts/lib/run-tools.ts`'s logger also masks anything shaped like a Remotion secret key (`rm_sec_…`) in every
    log line as a second guard.
  - Spikes, CI and live gates pass `isProduction: false`, which needs a license key, so free-license renders there
    stay at the default.
- **Progress** comes from `onProgress` and feeds `RenderProgressReporter`.
- **After the render** everything is today's code: ffprobe checks, poster, GIF, captions VTT, preview variants, the
  source archive (`video/` minus `node_modules`, which `excluded()` already drops), the bundle, upload and callback.
  Mastering of a narrated mix doesn't apply in v1.

### 5.6 Sound and voice on Remotion

**Phase 2: music only** (bed, fades, level):

- `<VaAudio>` renders `audio.music` with fades and its level.
- `engine.ts mix` measures the mix with ffmpeg `loudnorm` (first pass on an audio-only render) and writes
  `audio.music.volume` toward about −14 LUFS integrated, true peak ≤ −1 dBTP, the same target as today.
- The audio-only render counts as a render.
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
| Redo a scene (scoped revision)                               | Once regenerate-beat lands | ✗ (`409 not_editable`)   | ✓ Phase 3                     | `scopeCheckFor('remotion')` freezes beat files + props entries                              |
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

   > Remotion isn't open source. It's free for individuals, non-profits and companies of up to 3 people (from Remotion
   > 5.0, contractors count too). Every other company needs a Remotion Company License before using it here. For this
   > app that's usually "Remotion for Automators" ($0.01 a render, $100 a month minimum, at remotion.pro), and it also
   > covers the Remotion Player the editor uses. Video Agent doesn't buy or check this for you. Each render tells
   > Remotion your site's domain and IP address, never what's in the video.
   >
   > ( ) My organisation qualifies for the Free License: renders are reported as "free-license"
   > ( ) My organisation has a Remotion Company License: renders are reported with `REMOTION_LICENSE_KEY`
   > Note (optional): license reference or who approved it

**What saving the dialog does:**
- It records `remotion_license_ack` (who, when, which tier, note) and sets `remotion_enabled`.
- "Company License" can't be saved unless `REMOTION_LICENSE_KEY` is set on the project, refused with
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
  - or "in ENGINES but not set up: see Admin". When the last Remotion install failed, the row links to the run log.
- **`REMOTION_LICENSE_KEY`** (optional; mark it secret; scopes: builds and functions). Functions need it only to see
  that it's there. The README's trust model already says runs can read env vars, and that applies here too.
- **Telemetry:** "no network during the render" means the composition never fetches. The renderer's license reporting
  to remotion.pro is the one exception, allowed and disclosed in the dialog, the README's trust model and `/setup`.
- **Who can choose an engine:** anyone who can create, but only among enabled engines, through the look (looks' engine
  choice rule) or an explicit `engine` (REST, MCP `create_video`, SDK, CLI `--engine`). Reviewers and Viewers never
  spend credits, as today.
- **Credits:** a Remotion run costs whatever its agent and runner time cost; E2 measures it against S1. If install adds
  a fixed overhead, the New video page shows "Remotion videos take about N more credits" once it's measured.
- **Remotion's own charges** are between the deployer and Remotion. The Admin usage page shows "Remotion renders this
  month: N (M videos, K stills or sequences)" from finalize's tally, so they can reconcile it with remotion.pro.
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
| B. Install per run            | `scaffold` / `hydrate` run `npm ci --ignore-scripts` in `video/` from the template lockfile, then `npx remotion browser ensure`, only for Remotion runs                                                                                                                                                                  | Only Remotion runs pay; it counts against the deadline                                  |
| C. Cached tarball (B, faster) | An admin starts a "prime" run from the Admin page. It installs once and uploads `node_modules` plus the browser as a tarball to the `internal` Blobs store, keyed by the lockfile hash. The server records the tarball's sha256 from that run's report after the admin confirms it. Every later run downloads it, checks that sha256 (pinned in the server-written run manifest), and unpacks it | One prime per lockfile change. Faster if Blobs beats npm. Pins the browser download    |

**Recommendation pending E1:** C if `npm ci` plus `browser ensure` takes more than about 60 seconds, otherwise B.

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
Playwright, and live gates as `scripts/e2e/*.ts` with `--dry`, a credit ceiling, JSON-line logs and cleanup even on
failure.

**Unit (vitest)**

- `test/engines.test.ts`:
  - the registry and `enabledEngines` (env × enabled × tier, 8 cases);
  - capabilities per phase;
  - the engine choice rule (request, look, default);
  - `409 engine_disabled`, `400 engine_not_supported_by_look` and `409 engine_unsupported` at create (REST and MCP);
  - `scopeCheckFor` returns null where the capability is false.
- `test/prompt.test.ts`: the HyperFrames prompt is byte-identical to today's for the same `PromptInput`. The Remotion
  prompt contains no `hyperframes` string, and does contain the Studio override, the check command, the
  no-network rule and "don't install packages".
- `test/run-manifest.test.ts`: the `engine` field (absent → hyperframes; unknown → rejected; tier only with remotion).
- `test/finalize.test.ts`:
  - engine id mismatch and bundle-shape mismatch fail with `engine_mismatch`;
  - a Remotion bundle with a changed lockfile or `src/va/` file fails;
  - `engine.renders` adds to the monthly count.
- `test/lifecycle.test.ts`: revisions, remixes, edits and retries inherit the engine, and a forced mismatch is refused.
- `test/settings.test.ts`:
  - only admins can save the license choice;
  - "Company License" without `REMOTION_LICENSE_KEY` returns `remotion_key_missing`;
  - the record keeps who and when;
  - turning it off keeps existing videos editable.
- `test/run-tools.test.ts`: the logger masks `rm_sec_…` strings.
- **Phase 3:**
  - `test/contract-remotion.test.ts`: every v1 check in §5.2, one fixture per violation and its message.
  - `test/contract-conformance.test.ts`: paired fixtures (a HyperFrames `index.html` and a Remotion `props.json`
    describing the same video). A table of named op sequences: each op alone, then text+retime, retime+reorder,
    delete+reorder, colour+media, retime to the minimum, delete all but one. Both engines must give the same
    `Composition`, captions and frame totals. Ops an engine doesn't list are skipped. Every edit bug found in either
    engine becomes a row. (Seeded random sequences are in §13.)

**Run side (`scripts/lib/engines/remotion.test.ts`)**

- `hydrate` refuses each tampered file with `engine_tampered`.
- The skills tarball's hash check, and that only the four named skills are installed.
- The render-count tally.

**Template tests** (`engines/remotion/template`, own lockfile, own CI job `npm run test:remotion`, run only once open
question 1 is settled):

- `renderStill` of fixture props at fixed frames gives the same PNG hash twice (determinism).
- A props edit (retime, reorder) renders the expected frames at beat boundaries.
- The static scan catches each pattern in §5.2's check 3.
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

**Live gates (`scripts/e2e/engines.ts`)**

- **Inputs:** `VIDEO_AGENT_URL`, `VIDEO_AGENT_KEY`, `CREDIT_CEILING` (default 800), `--dry` (prints the plan and
  projected credits, makes no requests) and `--keep`.
- **Logging:** one JSON line per step, `{ step, videoId, attempt, ms, credits, renders, ok, detail }`.
- **Remotion renders** in gates are development renders (`isProduction: false`).

| Phase | What the gate does | Checks |
| --- | --- | --- |
| 1 (optional) | One HyperFrames create and one browser edit render, ~290 credits. Phase 1's real gate is the unit suite plus the prompt test, since nothing should change. | Status, `engine: hyperframes`, contract 1, edit ops applied, captions synced |
| 2 | Remotion 16:9 and 9:16 creates, one with music, and one revision | `engine: remotion`; MP4 probe; poster, GIF and captions present; captions match `summary.json`; integrated loudness within ±1.5 LU of −14 for the music video; render counts recorded; time and credits logged next to S1's numbers |
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

Each phase ends with a gate. Live gates spend credits, so each runs `--dry` first and has a ceiling. The cross-plan
build order places these phases as follows:

| Phase | Wave | Depends on |
| --- | --- | --- |
| 0 (spikes) | 0 | E1–E2 wait on the license decision |
| 1 | 1 | Blocks regenerate-beat phase 1, screen-recording phase 2 and looks phase 5 |
| 2 | 3 | Engines 1, looks phase 2, the license, E1 and E2 |
| 3 | 4 | Regenerate-beat phase 1 for the scope hook's HyperFrames side; `contract-core.ts` if it isn't already built |
| 4 | 5 | Phase 3 |
| 5 | 5 | cli-and-sdk phase 6, which owns the `/docs` pages |

### Phase 0: spikes (a new "Engine spikes" section in `docs/spikes.md`, labels E1–E6)

| Spike  | Question | How | Cost |
| ------ | -------- | --- | ---- |
| **E1** | On the runner: first, does `ldd` on Chrome Headless Shell find every shared library (§2)? Then, how long do `npm ci --ignore-scripts` of the template and `npx remotion browser ensure` take, how big are they, and what do they cost? Does the renderer work after `--ignore-scripts`? Does setup time fall inside `deadlineMs = (authoringDeadlineMin + 3) * MIN` (`reconciler.ts:174`), and is it billed? What's the browser archive's sha256? Also time option C (download and unpack from Blobs). | One run with a script-only prompt: install, ensure, render a fixture, time each step; the same with a Blobs tarball. Results go in `docs/spikes.md` next to S1 | 1–2 runs, ~60 credits |
| **E2** | Authoring quality and cost from scratch with the four skills and our template, on S1's three briefs (launch 16:9, sales 9:16 15 s, tutorial 1:1 60 s). Check rounds × seconds per round (bundle + Chrome launch), renders per video, CRF vs file size, and which static-scan rules agents actually break | Three runs with `ENGINES` set on a deploy preview or production; same rubric as S1 | 3 runs, ceiling ~700 credits |
| **E3** | Does the props-driven contract hold up? Hand-build a contract project, apply every edit op as props, render, compare frames and captions; write the conformance suite's first fixtures | Local (`spikes/e3`) | 0 credits |
| **E4** | Can `@remotion/player` run in our `/preview` sandbox (CSP `default-src 'none'`, scripts only from the capability path, `sandbox allow-scripts`)? Bundle size, cold start, seek accuracy vs the MP4 (SSIM, as in S7), bridge round trip | Local Playwright spike modelled on `spikes/s2` | 0 credits |
| **E5** | Determinism and offline: are the same props rendered twice identical? Do fonts load through `@remotion/fonts` and `staticFile` with the network blocked? Does `OffthreadVideo` work with library clips? | Local | 0 credits |
| **E6** | What's left on licensing (start now): ask Remotion to confirm that this template's use is Automators and that the Player is covered; when 5.0 ships and what else it changes; does `/remotion-to-hyperframes` render the original with Remotion? The key's format and the free-license value are already answered (§1) | Read the repos, docs and Terms; email Remotion | 0 |

Only E6 runs before open question 1 is settled. E3–E5 are local, but under a cautious reading of the Terms, setting up
the stack ends evaluation, so they wait for a license (or Remotion's written confirmation). Gate: the spikes are written
up, and the owner picks the install option.

### Phase 1: the engine seam, HyperFrames only (no behaviour change)

1. `src/domain/engines.ts` with `EngineId`, `EngineInfo`, `EngineCapabilities`, `enabledEngines`, and the named
   `ScopeCheck` / `scopeCheckFor` hook (returning null until regenerate-beat registers HyperFrames').
2. `contractOf`'s two callers (`bundles.ts:179`, `edits.ts:409`) switch on the version's engine. Non-HyperFrames
   returns `contract: null`.
3. The `versions.engine` column (default `hyperframes`, the first migration in the cross-plan order), the run manifest
   field, render-job's `engine` manifest field, and finalize's two engine checks.
4. `scripts/lib/engines/types.ts`, `hyperframes.ts` and `scripts/engine.ts`. render-job and prepare-run call the run
   engine, and prepare-run follows the step order in §4.3.
5. The DTO's `editing: { engine, capabilities }` next to `editable`.

Gate: every existing test passes untouched, and the HyperFrames prompt is byte-identical (Phase 1 doesn't touch the
prompt). The live gate is optional.

### Phase 2: Remotion authoring, not yet editable (music allowed)

1. `ENGINES`, the settings columns (the engines phase 2 migration), the Admin dialog with the tier radio and
   `remotion_key_missing`, the `/setup` row, `GET /api/v1/engines`, the `engines` feature string, `engine` on create
   (REST, MCP `create_video`, OpenAPI regenerated so the SDK and CLI get it), and the monthly render count on the Admin
   usage page.
2. `engines/remotion/template/` with the `va/` runtime (music path only), its AGENTS.md and the locked-file hashes.
   `scripts/lib/engines/remotion.ts` (scaffold, hydrate, check, snapshot, render, mix, render tally, key handling).
   The install option from E1, and the pinned skills download.
3. `EnginePrompt`: HyperFrames' lines moved word for word, plus the Remotion author and revision steps.
   `PROMPT_TEMPLATE_VERSION` +1 in merge order. The root `AGENTS.md` line added.
4. UI:
   - engine choice through the look (looks plan), with the Advanced select when the look lists two enabled engines;
   - a small "Remotion" tag in the video page details;
   - the editor's "not editable yet" state;
   - Narration hidden;
   - Sound limited to Silent or Music.
5. The README "Render engines" section, the trust-model line about license reporting, and the configuration table
   rows (`ENGINES`, `REMOTION_LICENSE_KEY`).

Gate: the Phase 2 live gate passes, and E2's quality bar holds.

### Phase 3: editing Remotion videos, and redoing a scene

1. `src/lib/contract-core.ts`, if regenerate-beat or screen-recording hasn't built it yet. `contract.ts` moves to
   import it, guarded by today's contract tests.
2. `src/lib/contract-remotion.ts` (validate, read, applyEdits), the `EngineEditing` interface, and the conformance
   suite.
3. Render-unchanged runs on Remotion render the frozen `props.json`.
4. The Player preview bundle, built in render-job and served by `/preview` through `PreviewSpec`, with the bridge
   inside it.
5. `scopeCheckFor('remotion')` and `RunEngine.scopeCheck` for Remotion, so `scopedRevision` is true.

Gate: the Phase 3 live gate, plus a Playwright run of the editor against a real Remotion bundle.

### Phase 4: effects and voice on Remotion

1. Per-beat `sfx` and ducking from voice spans in `<VaAudio>`, and the editor's `audio` op.
2. `scripts/voice.ts` behind the engine (the tag and sync), and re-voicing in the editor.
3. Lift `409 engine_unsupported` for Music + effects and voice-over.

Gate: the Phase 4 live gate.

### Phase 5: docs and looks

1. The engine docs on cli-and-sdk's `/docs` pages: "Engines" in the API page, and `engine` and `--engine` in the SDK
   and CLI references.
2. Remotion-only looks (3D product, map story, data charts) in the Looks catalogue. Their template dependencies are
   added to the lockfile.
3. A "Making an engine" contributor doc: the interfaces, the conformance suite, the locked-file rule, and what a third
   engine needs.

**Local mode** (cli-and-sdk plan): `video-agent local --engine remotion` needs `--accept-remotion-license`, and prints
this plan's license notice once. The CLI runtime bundle carries `engines/remotion/template/` (the lockfile, not
`node_modules`) and runs `npm ci --ignore-scripts` on first use. On someone's own machine an individual is on the Free
License, so local mode passes `"free-license"` unless they set `REMOTION_LICENSE_KEY`. It's the cheapest way to try
the engine.

---

## 12. Risks

- **License misunderstanding is the biggest risk.** A company turns Remotion on without a license and blames the
  template. Mitigations:
  - off by default, behind two locks;
  - plain wording in four places;
  - a recorded tier, and a key required for "Company License";
  - per-render reporting to Remotion, and a monthly render count shown to the admin;
  - no Remotion package in the app's own dependencies.
- **Authoring quality may start below HyperFrames'.** HyperFrames' skill and our contract evolved together over 16
  prompt versions. E2 measures it. If it's clearly worse, Remotion ships only with the looks it's best at, not as a
  general choice.
- **Thinner QA:** no layout, motion or contrast checks. Mitigated by the render smoke test, the contract scan, agent
  review of stills, and a plain note in the summary.
- **Install time and cost** could make every Remotion video slower and pricier. E1 decides, and option C exists.
- **Supply chain:**
  - Runs install from npm: lockfile integrity hashes, `npm ci --ignore-scripts`, exact versions.
  - Restored archives carry config: the locked-file hashes (§5.1).
  - The browser download isn't pinned by Remotion: option C, or our own pinned hash.
  - Skills come from GitHub at scaffold time: a pinned commit and a checked hash.
- **The key leaking:** never on a command line, read from env inside the renderer process, masked in logs.
- **Telemetry egress:** Remotion learns each deployment's domain and IP and how often it renders. That's disclosed, and
  inherent in using Remotion at all from 5.0.
- **Snapshot rounds** cost time and renders. They're batched into one sequence per call, the bundle is cached, and the
  prompt says each call costs.
- **Remotion 5.0** changes the license (contractors count, reporting mandatory) and may change APIs. We pin 4.0.x and
  plan the move as its own change (open question 6). Our gate already sends a key or `"free-license"`, so the
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
  interface, locked-file rule and conformance suite are meant to make it possible (open question 7).
- **Importing a Remotion project into HyperFrames** (§10): an **Import** entry on New video takes a zip of a Remotion
  project. A run installs `/remotion-to-hyperframes` (a pinned skill source from the HyperFrames repo, or
  `npx hyperframes skills update remotion-to-hyperframes` in setup), converts it, and keeps the contract. **License
  caveat:** if the skill renders the original with Remotion to compare frames, that step uses Remotion, and the
  deploying company's license status applies. E6 finds out. If it does, the import needs the same gate as the engine,
  or skips the comparison and says so.

## 14. Open questions for the owner

1. **Does Netlify buy Remotion for Automators** (or get Remotion's written confirmation that our use is covered) before
   any spike beyond E6, CI template tests, live gates and our own deployment? Building and testing the engine at
   Netlify isn't evaluation once we're setting up the stack. *Recommended:* yes, Automators ($100 a month minimum), and
   ask Remotion in E6 to confirm the Player is covered.
2. **Two locks (env plus the admin's license choice), or env only?** *Recommended:* both. The env controls what runs
   install, and the dialog records a person's decision and picks the reporting key.
3. **Live preview of Remotion edits with `@remotion/player` (Phase 3), or MP4-only editing?** *Recommended:* the
   Player, if E4 passes; MP4-only otherwise.
4. **Install strategy: per run (B) or a primed, hash-checked tarball (C)?** *Recommended:* decide from E1; C if the
   install takes more than about 60 seconds, since it also pins the browser.
5. **`REMOTION_LICENSE_KEY` scopes "builds and functions"**, so the server can see it's set (never its value)?
   *Recommended:* yes, marked secret.
6. **Remotion version:** pin 4.0.540 and plan 5.0 as its own change? *Recommended:* yes. Our key handling already
   meets 5.0's reporting rule.
7. **A fully open second engine (Motion Canvas, MIT): now or later?** *Recommended:* later. Ship the interface and
   conformance suite and invite one from the community.
8. **Import a Remotion project into HyperFrames as its own small plan after Looks?** *Recommended:* yes, once E6 says
   whether the skill renders with Remotion.
9. **Turn Remotion on for our own deployment once licensed?** *Recommended:* yes, so we use what we ship.
10. **Is per-render license reporting to remotion.pro (domain, IP, production or development, video or still)
    acceptable for Netlify's own deployment?** *Recommended:* yes. It sends no content, it's mandatory from 5.0
    anyway, and it's disclosed.

---

## 15. Review log (draft 1 → 2)

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
- docs/plans/2026-11-04-*.md (sibling plans) and the cross-plan seam review
