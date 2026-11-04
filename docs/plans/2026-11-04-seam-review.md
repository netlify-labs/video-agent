# Cross-plan seam review (2026-11-04)

- **Status:** the seam review of the six 2026-11-04 plans' draft 1, kept as a record. The plans' review logs cite its
  "shared rule N" and "cross-plan item N" numbers. The maintained summary is "Shared rules all six follow" in the
  [roadmap](2026-11-04-roadmap.md); where the two differ, the roadmap and the plans' draft 3 win (for example, local
  mode moved to wave 2, the engine rule picks the first *enabled* engine, and `rest_wait` is reserved).


These were the resolutions sent to each plan's writer, who could reject an item with evidence in their review log.

Facts verified in the repo:
- `src/domain/prompt.ts`: the prompt text does NOT contain `PROMPT_TEMPLATE_VERSION`; the number is only recorded on the attempt (`reconciler.ts:457`). `test/remix-run.test.ts:176` pins the literal `16`.
- `src/lib/run-manifest.ts:295-320`: `verifyRunManifest` rejects any `v !== 1`, checks known fields, ignores unknown ones. Adding optional fields needs no version bump.
- Retry and cancel are per-version routes: `POST /api/v1/videos/{id}/versions/{n}/retry` (`src/app.ts:539`) and `/cancel` (`:557`).
- `POST /api/v1/media/check` exists (`src/app.ts:1436`).
- `EditOp` is a closed union of 8 ops (`src/lib/contract.ts:1003-1016`).
- `docs/spikes.md` already uses `S0`–`S13`; plans' spike labels collide with it and each other.
- No `packages/` directory and no `workspaces` in `package.json` yet.

## Shared rules (all plans)

| # | Groundwork | Owner | Others do |
|---|---|---|---|
| 1 | `features` array (+ `version`) in `GET /api/v1/config`. Registry, snake_case: `remix, narration, planning, rest_wait, cli_login, looks, engines, scoped_revision, screen_recording, context, external_ref` | cli-and-sdk phase 1.2 | add their own string in their own PR; nobody else adds the array |
| 2 | `operationId` on every route + uniqueness test (camelCase, verb-first) | cli-and-sdk phase 1.1 | every new route carries one |
| 3 | SDK resource-method rows + coverage test (`raw` generated; resource methods hand-written; method or `RAW_ONLY` entry per route) | cli-and-sdk phase 2 | each plan adds its rows in the PR with its routes |
| 4 | `PROMPT_TEMPLATE_VERSION`: no literal numbers in plans. Rule: +1 in each PR that changes the template, in merge order; `test/remix-run.test.ts:176` imports the constant (first PR to touch it); with the feature off, the prompt text is byte-identical to today | rule | no "v17" anywhere |
| 5 | Run manifest stays `v: 1`; new fields (`look`, `engine`, `scope`, `recording`) are optional, each with its own shape check in `verifyRunManifest`. prepare-run step order owned by render-engines §4.3: scaffold (author) or restore + hydrate (others) first, then library media, then look, then recording and scope files | rule + render-engines | looks drops its v2 bump |
| 6 | `relayout` / `syncCaptions` on the `Composition` model live in `src/lib/contract-core.ts` (name from render-engines); first plan to land builds it under that name | render-engines names it | import, don't re-export from contract.ts |
| 7 | `EngineCapabilities` (editOps incl. screen-recording's `span`, `camera`, `cursor`, `redact`; `scopedRevision`; `recording`) | render-engines | screen adds `recording`; regen uses `scopedRevision` |
| 8 | Spike labels: cli `C`, looks `K`, engines `E`, regenerate-beat `B`, screen-recording `D`, github-action `A` | rule | rename before anything lands in docs/spikes.md |
| 9 | `settings` row columns and `/admin/settings` schema: sequence migrations (build order) and regenerate OpenAPI each PR | — | — |
| 10 | Version DTO grows additively (`look`, `engine` + `editing`, `beats` + `scope`, `recording`, `context`/`externalRef`); keep `editable`; webhooks reuse the DTO | each | — |
| 11 | Docs nav that scales to ~7 tabs | cli-and-sdk phase 6.1 | others add pages only |
| 12 | `packages/` workspaces, Changesets, trusted publishing | cli-and-sdk phase 1.6 | github adds `packages/action` (private, not npm-published, excluded from Changesets) |
| 13 | Local-mode prepare-run (file-based fetch mode); the CLI runtime bundle includes `prepare-run`, `engine.ts`, `scripts/lib/engines/*`, `recording.ts` | cli-and-sdk phase 4 | — |
| 14 | Error code → CLI exit code rule ("by HTTP status, then by code") | cli-and-sdk | new codes follow it |
| 15 | Terminology: people-facing "scene", "Redo this scene", "Look", "Restyle"; code/API `beat`, `scope`, `look`, `engine`; CLI flags `--scene`, `--look`, `--engine` | rule | cli, github, engines adjust wording |

Engine choice rule (owned by looks, referenced by engines): a look lists its `engines`; a new video's engine is `request.engine` if given (validated against the look's list, else `400 engine_not_supported_by_look`), otherwise the look's first listed engine, otherwise `hyperframes`. A look whose every engine is disabled shows greyed ("needs Remotion (off)"). `PATCH /admin/settings.defaultLook` refuses a look whose engines are all disabled.

Restyle = `revise { look }` (looks' choice). "Same demo, new recording" = `remix { recording }`; "same recording, another look" = `remix { look }`.

## Changes for cli-and-sdk

1. Keep `new VideoAgent({ url, … })`; add a `userAgent` option. State in §4.2: authenticated requests never follow a cross-origin redirect with the key, EXCEPT file routes, which 302 to signed storage URLs and are followed WITHOUT the `Authorization` header (`src/app.ts:676-707`).
2. Move `retry`/`cancel` to `versions.retry(id, n)` / `versions.cancel(id, n)` (routes are per version).
3. Keep `files.url` / `files.download(video, { file, to })`; github-action switches.
4. `wait` sends `If-None-Match`, treats 304 as no change, uses `rest_wait` when advertised; cadence is this plan's, overridable with `intervalMs`; `timed_out` is terminal (`src/schemas.ts:62`).
5. Add `media.check(hashes)`.
6. Add resource methods other plans need: `looks.list()`, `look` on videos.create/revise/remix and plans.create; `engines.list()`, `engine` on create; `scope` on `videos.revise` plus sugar `videos.redoScenes(id, { beats, prompt, …opts })`; `media.upload(…, { role })`, `media.uploadRecording(file, { telemetry, onProgress })`, `media.setTelemetry(id, json)`, `media.getTelemetry(id)`, `recording` on create/remix; `videos.list({ externalRef })`, `externalRef` and `context` on create/revise/remix. State in §4.1 that each feature plan adds its rows in its own PR and the coverage test forces it.
7. Own the `features` registry (shared rule 1); rename `regenerate_beat` → `scoped_revision`; add `context`, `external_ref`, `screen_recording`, `cli_login`.
8. CLI commands: `video-agent scenes <video>`, `revise --scene …` (repeatable, id or label), `video-agent redo <video> --scene <id|label>… "<change>"` (drop `regen`; hidden until `scoped_revision`); `looks`, `--look` on create/revise/remix, `restyle <video> <look>` (sugar for `revise --look`); `record` and `local demo` (owned by screen-recording phase 4; `record` needs Playwright as an optional dependency installed on first use, listed in `doctor`; the "one small bundled file" promise says "except `record`"); fold `upload-recording` into `media upload --role screen-recording --telemetry t.json`; `demo` is sugar for `create --recording <id|file>`; `--idempotency-key` on create/revise/remix/redo; a `brief pr|release|changelog` group owned by github-action (module at `packages/cli/src/brief/`, bundled by the action); drop `--recipe`/`--notes-file` in favour of `brief … | create --prompt-file -`.
9. Local mode bundle adds `engine.ts`, `scripts/lib/engines/*`, `recording.ts` and `prepare-run` with a file-based fetch mode (build the file-based half of §6.8 now). `local --engine remotion` requires `--accept-remotion-license` and prints the engines plan's notice once.
10. Rephrase the "prompt identical to today's" test: for the same `PromptInput`, the blobs prompt and the local prompt differ only in the `--upload` argument. Name feature strings from the registry.
11. List `packages/action` (private) in the `packages/` layout so workspaces, build, test, ESLint cover it; Changesets ignores it.
12. Exit-code mapping for new server codes: `not_editable` (409) → 7; `look_disabled`, `engine_disabled`, `engine_unsupported`, `cli_login_disabled` (409) → 7; `unknown_look`, `look_not_allowed`, `invalid_request` (400) → 2 or 1; `unsupported_by_server` → 9. State the rule.
13. Phase 6.1 owns a docs nav that scales (tabs: api, mcp, skills, cli, sdk, looks, github).

## Changes for looks

1. Don't bump the run manifest to v2 (shared rule 5).
2. No literal template number (shared rule 4). Looks is right that the number isn't in the prompt text.
3. `look.json` schema accepts an optional `recording` block (`frame`, `padding`, `radius`, `shadow`, `wallpaper`, `cursor`, `ripple`, `callout`, `zoomMax`, or `"recording": false`), owned here, documented as "used by screen recordings"; give `clean` a `recording` block in phase 2. Otherwise "unknown keys refused" breaks screen-recording.
4. §4.13 "nothing hand-written" contradicts cli-and-sdk's two layers: resource methods are hand-written; name `operationId`s (`listLooks`; `look` is a body field). CLI commands (`looks`, `--look` on revise/remix, `restyle`) come after cli phase 3.1.
5. `video-agent local --look <id|path>`: an id resolves against looks bundled with the CLI at build time; a path points at a folder (for contributors before their PR merges). Local mode runs from the bundled runtime, not a checkout.
6. Engine precedence: adopt the engine choice rule above (looks owns the picker).
7. Regenerate-beat refuses `look` with `scope` (`400 look_not_allowed`), raised by `reviseVideo` when `scope` is present; note it in §4.9 errors.
8. Restyle stays a revision (screen-recording changes).
9. Spike labels → `K1–K4`.
10. Settings columns: sequence with other plans (build order).

## Changes for render-engines

1. Regenerate-beat's splice is HyperFrames-specific. Shared frame math lives in `src/lib/contract-core.ts` (shared rule 6). Add `scopeCheck?(parent, agent, beats)` to `Engine`/`RunEngine`, implemented for HyperFrames by regenerate-beat's module, absent for Remotion until Phase 3.5. `reviseVideo` refuses `scope` when `capabilities.scopedRevision` is false with regenerate-beat's `409 not_editable` (no new code).
2. "Byte-identical except the version line" is wrong: the version isn't in the prompt text. The HyperFrames prompt must be byte-identical, full stop. No literal 17.
3. `EngineCapabilities.editOps` must admit screen-recording's `span`, `camera`, `cursor`, `redact` and a `recording: boolean` capability; Remotion lists none. Conformance suite skips ops an engine lacks. Screen-recording is HyperFrames-only in v1; `recording` on a Remotion video is `409 engine_unsupported`.
4. Keep the DTO's `editable` (`videos.ts:898`) as is and add `editing: { engine, capabilities }` next to it.
5. Write the prepare-run order (shared rule 5) in §4.3.
6. Adopt the engine choice rule; remove the engine-first wording in §9 Playwright ("engine choice shown only when two enabled; looks filter by engine"). Keep "Engine select under Advanced only when the look lists more than one".
7. Local mode: `video-agent local --engine remotion` needs `--accept-remotion-license`; the CLI runtime bundle carries `engines/remotion/template/` (lockfile only; `npm ci` at run time).
8. Docs: cli-and-sdk owns /docs pages; depend on its phase 6.
9. Spike labels → `E1–E6`.
10. `engines` feature string via the registry; `GET /api/v1/engines` is the detail call.

## Changes for github-action

1. SDK names: `new VideoAgent({ url, apiKey, userAgent, fetch })`, `versions.retry/cancel`, `files.download(video, { file, to })` instead of `versions.download`, `videos.wait` (pass `intervalMs` for 5→15 s), `retryAfterSec` not `retryAfter`, `media.check`. Remove "(adjust here when it settles)".
2. `npx -y video-agent@1` would run a stranger's package (`video-agent` is taken on npm). Use `npx -y @video-agent/cli@1` (superseded by item 16: `@netlify-labs/video-agent-cli`).
3. `features` is cli-and-sdk phase 1.2's; add only `context` and `external_ref`.
4. Use `/video redo <scene> <change>` (id or unique label), `scope: { beats }` in the API; feature string `scoped_revision`.
5. You own the brief builder module at `packages/cli/src/brief/`; the CLI catalog gets `brief pr|release|changelog`; `packages/action` bundles it. Phase 1 depends on cli phase 3.1 plus the SDK.
6. `packages/action` is `private: true`, excluded from Changesets and npm trusted publishing, released only by your release script.
7. `context` in `buildPrompt`: follow shared rule 4.
8. Add screen-recording's "refresh on release" (scripted tour → `videos.remix(id, { recording })`) to "Not in v1" as a phase-5 item after screen-recording phase 4.
9. The SDK's `wait` throws `VideoAgentError` code `video_failed` on failed/cancelled/timed_out; catch it rather than read a status.
10. Spike labels A1–A5 stay.

## Changes for regenerate-beat

1. SDK: `videos.revise(id, { prompt, scope: { beats } })` plus sugar `videos.redoScenes(id, { beats, prompt, …opts })`; drop `videos.beats(id, { version })` (the DTO already carries `beats`). CLI: `scenes <video>`, `revise --scene …`, `redo <video> --scene … "<change>"`. Feature string `scoped_revision`. `redo` sends an idempotency key like `revise`.
2. Shared frame math: import from `src/lib/contract-core.ts`; if you land first, create it under that name (shared rule 6).
3. Engine gate: `reviseVideo` refuses `scope` on a version whose engine lacks `scopedRevision`, with `409 not_editable` naming the engine. Run-side guard and finalize check are HyperFrames-only in v1; say so.
4. Refuse `look` with `scope` (`400 look_not_allowed`).
5. Make the derived-file set in `scopeFileProblems` extensible (a list other features append to); list `assets/recording/plan.json` as derived when a scoped beat is a recording beat; `recording.ts check` (redaction guard) runs inside `check-contract --fix` when the composition has recording beats.
6. No literal "v17" (shared rule 4).
7. Spike labels → `B1–B3`.
8. MCP catalog row and skill recipe say "Redo a scene", not "regenerate".
9. GitHub Action's `/video redo` uses your `scope.beats`.

## Changes for screen-recording-demo

1. Restyle = `revise { look }` (framing, cursor, callouts, intro/outro rebuilt; steps and plan kept); "same demo, new recording" = `remix { recording }`; "same recording, another look" = `remix { look }`.
2. `look.json.recording` is owned by looks (looks item 3); depend on looks phase 1 (schema) and a `recording` block in `clean`; `recording: false` hiding a look needs the picker (looks phase 3).
3. CLI/SDK surface: `record` and `local demo` stay; `upload-recording` becomes `media upload --role screen-recording --telemetry t.json`; `demo` is sugar for `create --recording`. SDK: `media.uploadRecording`, `media.setTelemetry`, `media.getTelemetry`, `media.upload(…, { role })`, `recording` on create/remix. `operationId`s `setMediaTelemetry`, `getMediaTelemetry`. Phase 1.5 SDK methods depend on cli phase 2.
4. v1 is HyperFrames-only; `recording` on a Remotion video is `409 engine_unsupported`; Remotion's capability `recording: false`. Your `relayout` change lands wherever `relayout` lives (`contract-core.ts` if it exists).
5. A scoped revision of a demo may change `assets/recording/plan.json` for scoped steps; `recording.ts check` runs inside `check-contract --fix`. Say so.
6. Run manifest `recording`: keep `v: 1`, optional field with a shape check.
7. Prompt: shared rule 4.
8. Spike labels S1–S6 collide with `S0`–`S13` → `D1–D6`.
9. GitHub Action "refresh on release": keep `recording` on remix in v1.
10. Feature string `screen_recording` via the registry.
11. `/docs/cli#record` section lives in cli-and-sdk's page; add it in your phase 4.

## Cross-plan build order

Wave 0 — spikes (parallel): cli C1–C4; looks K1–K4; engines E3–E6 (E1–E2 wait on the license decision); regen B1–B3; screen D1–D6; github A1–A5.

Wave 1 — groundwork (parallel across plans):
- cli phase 1 (operationIds, features + version, x-request-id, rest_wait, oasdiff, packages/ workspaces). Blocks every plan's API additions, the SDK, the action.
- engines phase 1 (Engine interface, HyperFrames only, contract-core.ts, versions.engine, manifest engine, prepare-run order). Blocks regen phase 1, screen phase 2, looks phase 5.
- looks phase 1 (schema incl. recording, validator, catalog, clean). Blocks screen phase 3, looks phase 2.

Wave 2: cli phase 2 (SDK; blocks github 1, cli 3, screen 1.5, regen 4, looks 4.13); looks phase 2 (after looks 1 + cli 1); regen phase 1 (after engines 1), then regen phase 2 (after cli 1); screen phase 1 (after cli 1; SDK rows after cli 2); cli phase 5 (player, /v/{slug}.json; after cli 1.2).

Wave 3: cli phase 3 (remote CLI, catalog, login); github phase 1 (after cli 2 + 3.1), github phase 2; looks phase 3 (UI, plans); engines phase 2 (Remotion authoring; license + E1/E2; after engines 1 + looks 2); screen phase 2 (after screen 1 + engines 1); regen phase 3 (UI).

Wave 4: cli phase 4 (local mode; after cli 3.1 + engines 1 + C1–C3); github phase 3 (context, external_ref; after cli 1); looks 4, regen 4, screen 3, engines 3 (needs regen 1 for the scope hook) in parallel.

Wave 5: cli 6 (docs nav, pages), then looks 3.6, github 4, screen 4 (record, /docs/cli#record), engines 5; cli 7 (release); engines 4; screen 5; github "refresh on release".

Template-bump merge order: looks 2 → regen 2 → engines 1 (only if its refactor changes any byte) → screen 2 → github 3. Each PR sets the constant to current+1.

Migrations (one PR each, OpenAPI regenerated per PR): engines 1 (versions.engine) → looks 2 (versions.look, 3 settings) → regen 2 (versions.scope, versions.beats) → cli 3.3 (cli_logins, cliLoginEnabled) → screen 1 (version_media.telemetry_*, media telemetry columns, recordingQuotaBytes) → engines 2 (remotion_*) → github 3 (videos.external_ref).

Dependency lines each plan must add: looks (phase 2 on cli 1; 4.13 on cli 2–3); regen (phase 1 on engines 1; phase 4 on cli 3); screen (1.5 on cli 2; 3 on looks 1; 4 on cli 3); github (1 on cli 2 + 3.1; 3 on cli 1.2); engines (2 on looks 2; 3 on regen 1; 5 on cli 6).

## Addendum (orchestrator, after the CLI/SDK review): package names and one word

16. **npm scope.** The `@video-agent` npm org already exists and belongs to someone else (registry `/-/org/video-agent/package` → 200, checked 2026-11-04), so we can't publish there. `@netlify-labs` is unclaimed (→ 404). Packages: **`@netlify-labs/video-agent-sdk`**, **`@netlify-labs/video-agent-cli`** (bin `video-agent`), **`@netlify-labs/video-agent-player`**. Run it with `npx -y @netlify-labs/video-agent-cli@1 …`. Never `npx video-agent` (the unscoped `video-agent` is a stranger's 0.0.0 with no bin). Owner question for cli-and-sdk: `@netlify-labs/*` (recommended) or official `@netlify/*`. Replace every `@video-agent/…` in every plan.
17. **"Telemetry" means one thing.** The CLI plan promises "no telemetry" (usage reporting), Remotion has license telemetry, and screen-recording called its pointer/click data `telemetry.json`. Rename screen-recording's data to the **pointer trace**: `trace.json`, media field `traceSha256`, routes `PUT/GET /api/v1/media/{id}/trace` (`setMediaTrace`/`getMediaTrace`), SDK `media.setTrace`/`media.getTrace`, `media.uploadRecording(file, { trace })`, CLI `media upload --role screen-recording --trace t.json`. "Telemetry" in these plans then means only usage/licence reporting.
