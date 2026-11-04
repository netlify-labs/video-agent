# Redo a scene: regenerate one beat as a scoped revision — plan

- **Status:** draft 3 (2026-11-04). Not started. No beads yet. Written from the idea-wizard list (idea #10) after the
  owner picked it ("faster/cheaper regens sound cool"). Reviews:
  - Draft 1: an independent Fable 5.1 review ("sound with changes") and the cross-plan seam review of the six
    2026-11-04 plans.
  - Draft 2: a remote Fable 5.1 review (high effort, a Netlify Agent Run at `19740d8`, "sound with changes").

  Each claim was checked against the code before it was folded in. §13 is the review log.
- **Ask:** on a finished video, pick one scene (or a few), say what should change, and get a new version where only
  those scenes changed. Everything else stays as it was: the same HTML for the other scenes, so the same pictures, the
  same captions, the same music, the same voice. It should be faster and cheaper than revising the whole video, and it
  should never "drift" (a full revision often changes things nobody asked about).
- **Builds on:** revisions (`reviseVideo`, `src/domain/videos.ts:397-485`), the `revision` run kind and
  `scripts/prepare-run.ts`, editing contract v1 (`src/lib/contract.ts`, "Editing contract v1" in `video/AGENTS.md`),
  the re-voice guard that already proves "only these files changed" (`src/lib/revoice.ts`), the narration lock for
  revisions (`checkNarrationKept`, `src/lib/narration-modified.ts:326`), incorporate feedback (`snapshotFeedback`,
  `src/domain/videos.ts:491`) and its stills from the parent MP4, and finalize (`src/domain/finalize.ts`).
- **Depends on other 2026-11-04 plans:**
  - Phase 1 needs render-engines phase 1, which provides `src/lib/contract-core.ts`, the `Engine` interface with
    `capabilities.scopedRevision`, and `versions.engine`. If this plan lands first, it creates `contract-core.ts`
    under that name.
  - Phase 2 needs cli-and-sdk phase 1: `operationId`s and the `features` array in `/api/v1/config`.
  - Phase 4 needs cli-and-sdk phases 2–3 (SDK and remote CLI).
  - looks phase 2 merges before this plan's phase 2: its template bump and migration come first.
- **Words** (cross-plan terminology rule): people see **scene** and **Redo this scene**. Code and API say **beat** and
  **scope**. The CLI flag is `--scene`. The feature string is `scoped_revision`.

---

## 0. What it is, in one paragraph

A **scoped revision** is a normal revision with one extra field, `scope: { beats: ["features"] }`, and a required
`fromVersion` (beat ids belong to one version). The run restores the parent's composition, as revisions do today, and
the agent is told to rewrite only the scoped beats. Before it renders, a deterministic **splice** builds what the
composition must be: the parent with the agent's scoped beats put in, re-laid end to end, later captions shifted, the
music's ducking rewritten. The splice is what gets rendered. Anything the agent changed outside the scope is put back
and reported while the agent works (`check-contract.ts --fix`), and refused at render time and again in finalize,
which checks the uploaded composition against the parent's archive on the server. **What's guaranteed is the saved
composition:** outside the scope, its `index.html` and `summary.json` are byte-for-byte what splicing the parent
produces, and every other existing file is the parent's. The MP4 is trusted like every run's, bound to the
composition by its length, and the live gate checks frozen scenes' frames by SSIM (§4.9). (A **live test** or live
gate is a script that makes real videos on the production site and checks them; it costs credits.)

## 1. Why this is worth building

- **Drift is the main complaint about revisions.** "Make the end card orange" restores the whole composition and asks
  the agent to "Change only what the request asks for" (`src/domain/prompt.ts:215-217`). That's a request, not a
  rule: nothing checks it. Agents tidy up, retime and rephrase things nobody mentioned. Scoped revisions make "only
  this part" a checked guarantee, which also makes review faster: reviewers only need to re-watch the changed scene.
- **It should cost less.** A run costs a fixed overhead plus whatever the agent reads, writes and renders:
  - The fixed part is small: a "hello" run cost 14.4 credits (`docs/spikes.md:8`), a render-unchanged run 33.6–34.4
    (`docs/spikes.md:164-175`).
  - An authoring run costs 90–250 (`docs/spikes.md:34-49`, `:171`).
  - A remix, which is a revision-kind run, cost 120.3 (`docs/plans/2026-11-03-remix.md:307`).

  A scoped run reads and writes one beat, so it should land somewhere in between. We don't know where yet; spike B3
  and the live gate measure it (§10).
- **It's the natural action for feedback.** Comments are pinned to a moment (`CommentRow.timeSec`,
  `src/domain/types.ts:584`), and a moment falls in exactly one beat. "Redo this part" on a comment is one click from
  feedback to a fix that can't touch the rest.
- **The contract already makes it possible.** Beats are direct children of the root. Each animates itself with one
  script and selects only inside its own element, and nothing animates across a boundary (`video/AGENTS.md`,
  "Editing contract v1"; checked by `validate`, `src/lib/contract.ts:395-450`). So a beat can be swapped as a unit,
  which is what the editor's reorder and delete already do (`applyOne`, `src/lib/contract.ts:1100`; reorder `:1121`,
  delete `:1132`).

## 2. Facts this plan relies on (checked 2026-11-04)

| Fact | Where |
| --- | --- |
| `reviseVideo` does the following, all inside `deps.store.tx`: checks `version:create`; refuses while another version is unfinished; picks the parent (`fromVersion` or the latest ready); snapshots comments; consumes a plan; inherits media, sound and voice-over; inserts a queued version with one attempt. | `src/domain/videos.ts:397-485` |
| `ReviseInput` has `prompt`, `fromVersion`, `durationSec`, `webhookUrl`, `planId`, `commentIds`, `mediaIds`, `sound`, `voiceover`; the REST schema mirrors it (`ReviseSchema`). | `src/domain/videos.ts:68-82`, `src/schemas.ts:469-492` |
| MCP `revise_video` maps `change`, `from_version`, `plan_id`, `duration_sec`, `comment_ids`, `media_ids`, `sound`, `voiceover` onto `reviseVideo`. | `src/mcp.ts:730-790` |
| Incorporating comments needs `video:incorporate` (owner or admin); at most 50 comments and 20,000 characters. | `src/domain/videos.ts:85-86`, `:491-514` |
| `newAttempt(deps, jobId, n, now)` takes no version. It has callers in create (`:366`), revise (`:474`), retry (`:565`), edits (`src/domain/edits.ts:796`) and remix (`src/domain/remix.ts:256`). | `src/domain/videos.ts:195` |
| Run kinds are `author`, `revision`, `render_unchanged`, `author_from_frozen`. A revision's manifest has `source` (the parent's archive and its reference files) and an optional `feedback` (the parent MP4 and pins for stills). | `src/lib/run-manifest.ts:26-62` |
| `verifyRunManifest` rejects any `v !== 1`, checks the shape of known fields and ignores unknown ones. `feedback.pins` may be empty (it's only capped at 50). | `src/lib/run-manifest.ts:19`, `:121`, `:295-365` |
| For a revision, the reconciler restores the parent's `source.tar.gz` by key and hash, adds reference files (the narration bus) via `readReferences`, and makes feedback stills from the parent MP4 for pinned comments. | `src/domain/reconciler.ts:268-330` |
| prepare-run fetches `feedback.video` and makes one still per pin with `feedbackStills`. That function **empties `video/feedback/` first** and runs last in `prepare()`, after any restore and the library media. prepare-run keeps a copy of the restored parent in `.render/frozen` only when the parent is narrated. | `scripts/prepare-run.ts:60-99` (the `rmSync` at `:65`), `:375-395`, `:452-460` |
| render-job validates the contract and refuses leftover `data-va-revoice` marks. It then runs **one** guard from an `else if` ladder (render-unchanged with narration, fit, narrated revision, re-voice, plain render-unchanged). The narrated-revision branch catches every revision of a narrated parent. | `scripts/render-job.ts:86-176` |
| The re-voice guard is the pattern to copy. It hashes every file except the ones the step may write (`keptHash`, which excludes the held still because the narration step rewrites it). It compares `voice.json` entry by entry (same provider, voice and speed; only marked beats change). It then recomputes `index.html`/`summary.json` from the frozen copies with `applyRevoice`. | `src/lib/revoice.ts:33-169` |
| `relayout` puts the beats back to back, snapping each **cumulative** end to whole frames, so a beat that isn't frame-aligned pushes its rounding into the next beat. It also sets the root, layer and video-slot durations, trims speech and rewrites ducking. `syncCaptions` recomputes absolute caption times, snapping them to frames; text cues stretch by `duration / authoredDuration`, voice cues don't. Both functions are private. | `src/lib/contract.ts:1026-1085` |
| `relayout` runs only on editor, narration and re-voice paths: `applyFitNarration`, the held frame, `applyEdits` and `applyRevoice`. **An authored composition is never relaid.** `check-contract.ts` and render-job only validate it, and `validate` only needs each start within half a frame of the running sum, so an authored contract-v1 parent can have beats that aren't frame-aligned (3.85 s). | `src/lib/contract.ts:901`, `:984`, `:998`, `:1093`, `:1268`; `:424` |
| GSAP resolves string targets (`tl.from('.card', …)`, `gsap.utils.toArray('.card')`) against the whole document, not the beat. `vaBeat` hands the beat a plain GSAP timeline. | `video/vendor/va-contract.js:9-16` |
| The renderer's Chrome is 156 (puppeteer's pinned revision, used by HyperFrames). | `node_modules/puppeteer-core/lib/puppeteer/revisions.js:10` |
| No read route returns a version's beats. The only route that returns a `Composition` is `POST …/versions/{n}/edits`, which opens a draft as a side effect. | `src/app.ts:1156` |
| Finalize stores the uploaded `source.tar.gz` exactly as uploaded. | `src/domain/finalize.ts:217` |
| `load`/`save` are a parse5 round trip. Whitespace text nodes, attribute order and script/style text survive it, so a re-indented file serializes differently. | `src/lib/contract.ts:231-243` |
| `validate` checks authored rules and derived values alike. Authored rules: beat ids, `data-composition-id`, track 0, the `vaBeat` script, unique text ids, voice placement. Derived values: back-to-back starts, beat sum = root, layers span the total, the ducking lane. Its script isolation check is a regex: `/\bdocument\s*\.|window\.__timelines/`. | `src/lib/contract.ts:395-520`, `:436` |
| `readColors` reads `--va-color-*` from **every** `<style>` in the document, and the editor's colour op rewrites each one. | `src/lib/contract.ts:249-256`, `:1143-1151` |
| Finalize checks every upload's hash and the MP4 (H.264, at most 2 GB, duration). It only **notes** a length far from the target; it doesn't reject it. It never derives the MP4 from the archive, for any run kind. It reads the uploaded `source.tar.gz` once for run credits (`runCreditsOf`, called at `:236`, with `SOURCE_READ_LIMITS`: 5,000 entries, 160 MB total, 60 MB per file). After a version is ready, it builds the bundle and sets `versions.contract`. | `src/domain/finalize.ts:131-236`, `:162`, `:277-287`, `:435-439`, `:447-460` |
| `editable` in the API is `status === 'ready' && contract === 1`. | `src/domain/videos.ts:898` |
| The server can read any ready version's composition: `ensureBundle` unpacks its source archive (Blobs I/O) and records contract violations. | `src/domain/bundles.ts:136-195` |
| `readTarGz`'s default limits are `BUNDLE_LIMITS`: 2,000 entries, 50 MB total, 10 MB per file. | `src/lib/tar.ts:12-16`, `:48` |
| The server's bundle contract check combines `contractOf` over the archive with `missingLocalFiles`, which uses the reference files and the version's library media. | `src/domain/bundles.ts:170-188` |
| Files that never count and are never archived: dot folders, `node_modules`, `renders`, top-level `.mp4`, `feedback/`, and hydrated library media (`assets/media/med_*`). | `src/lib/bundle-manifest.ts:28-41` |
| `check-contract.ts` validates `video/`; `--duck` rewrites the music's ducking lane first. | `scripts/check-contract.ts:1-49` |
| `voice.ts` re-speaks every line that changed in `script.json` and keeps unchanged ones. `voice.ts sync` drops the non-voice cues of voiced beats, adds voice cues for every voiced beat, sorts all cues by start, and rewrites ducking. | `scripts/voice.ts:54-80`, `:145-171` |
| Each attempt records `agent`, `model` and `effort` from config (`AGENT`, `AGENT_MODEL`, `AGENT_EFFORT`), and the runner adapter passes them on. | `src/deps.ts:88-90`, `src/adapters/runner.ts:15-21`, `src/domain/reconciler.ts:171-173` |
| The prompt text doesn't contain `PROMPT_TEMPLATE_VERSION`; the number is recorded on the attempt. `test/remix-run.test.ts` pins the literal 16. `sanitizeBrief` keeps fenced data from closing its fence. | `src/domain/prompt.ts:8`, `:106`; `src/domain/reconciler.ts:457` |
| `css-tree` 3.2.1 is installed (a dependency of `hyperframes`), not a direct dependency. | `npm ls css-tree` |
| UI entry points today: the video page's revise panel ("Revise and regenerate this video"), its **Retry** button, Incorporate feedback in the review panel, the editor's beat cards, and the editor timeline's beat blocks. | `ui/src/pages/Video.tsx:682`, `:1092`; `ui/src/components/Review.tsx:274`; `ui/src/pages/Edit.tsx:1047`; `ui/src/components/timeline/Timeline.tsx:476` |
| API error codes are a closed union, each with an HTTP status. | `src/lib/errors.ts:1-37` |
| Agent Runners work from a Git checkout of this project (README "Before you deploy"). A run executes the repo's own `scripts/` in its own workspace, so it can change them there. | `README.md:33`, `AGENTS.md` |

## 3. Gotchas the design has to handle

1. **"Change only X" can't be enforced by asking.** The check has to be deterministic and run twice. It runs in the
   run, so the agent can fix itself. It runs again in finalize, because a run executes the repo's scripts in its own
   checkout and could change render-job.
2. **Validating the agent's file first gives the wrong errors.** `validate` checks derived values too, so the normal
   case ("I made Features 2 s longer and didn't move the later scenes") fails with messages about later scenes'
   starts. Validate the parent, splice, then validate the splice.
3. **Byte comparisons of hand-written HTML are fragile.** A parse5 round trip keeps whitespace, attribute order and
   script text, so a formatter re-indenting frozen scenes would look like a violation. Compare semantically (§4.5).
4. **Changing a beat's length moves everything after it.** Later beats' `data-start`, the root, layer and video-slot
   durations, caption times, speech spans and the ducking lane all shift. These are derived values, so compute them;
   never compare them. Plain `relayout` is the wrong tool here. It snaps cumulative ends, and authored parents were
   never relaid, so their frozen beats may not be frame-aligned: relaying would change a 3.85 s frozen beat to 3.833
   or 3.867 s. Frozen durations have to be kept verbatim and only scoped ones snapped (§4.5).
5. **Shared CSS lives outside beats.** `<head>` and root-level `<style>` hold fonts, classes and `--va-color-*`.
   Inside a beat there are several ways to leak styles out: a `<link rel=stylesheet>`, a second `<style>` (also inside
   `<svg>`), a `--va-color-*` declaration (`readColors` would make it an editor colour role), or a
   `data-composition-src` sub-composition.
6. **Script isolation is a heuristic.** The `vaBeat` check is a regex, and `el.parentElement`, `el.ownerDocument`,
   `el.closest(…)` or `getRootNode()` escape it. So do GSAP **string targets**: GSAP resolves `tl.from('.card', …)`
   against the whole document, and it's the most common way an agent selects. Only frames can prove the other scenes
   look the same.
7. **Neighbours.** The contract puts a transition in the beat it leads into, so the next scene's entrance is frozen
   and the scoped scene's last frame is what that entrance cuts from. The agent can't see the neighbours in the HTML
   alone; it needs stills.
8. **Voice.** Changing a voiced beat's line changes its WAV, `voice.json`, `script.json`, its narration captions and
   the ducking. `voice.ts` re-speaks any changed line, and `sync` re-sorts every cue.
9. **Recorded narration is locked.** The root must last exactly as long as the bus, so a scoped beat in a narrated
   video can't change length, and no sound may play over the speech (`checkNarrationKept`).
10. **The held last frame.** A narrated video can end with `va-hold`, a still of the last visual frame
    (`HOLD_STILL_SRC`, `src/lib/contract.ts:909-1000`). Redoing the last real beat makes that still stale, and only the
    narration step captures it.
11. **New files and old files.** The scoped beat may need new images or sound effects. Existing files may be used by
    frozen beats, so they must not change or disappear.
12. **Versions are one at a time** (`hasUnfinished`, `src/domain/videos.ts:423`), so "three variations in parallel"
    doesn't fit the version model.
13. **Old, non-contract and non-HyperFrames videos.** Scoping needs contract v1 and an engine whose capabilities say
    `scopedRevision` (render-engines plan). Everything else can only be revised whole.
14. **No archive I/O inside the revise transaction.** `ensureBundle` reads Blobs. Doing that while the job row is
    locked would hold the lock across network calls.
15. **Labels are agent-written.** `data-va-label` values reach the next prompt, so they're data in a fence.
16. **The stills folder gets wiped.** `feedbackStills` empties `video/feedback/` before writing pin stills, so any
    scope stills written before it would vanish.
17. **Older versions have no beats list.** Without a read route, the picker can't show scenes for any version made
    before this plan.
18. **A semantic check isn't the archive.** Finalize stores the upload as is, so if the check were only semantic, a
    whitespace-sensitive difference in a frozen scene could still be saved.
19. **Retries repeat failures.** A scoped attempt refused for out-of-scope changes, retried with the same prompt, has
    the same odds and spends the same credits.

## 4. Design

### 4.1 The request

`POST /api/v1/videos/{id}/versions` gains an optional `scope`:

```json
{
  "prompt": "Make the headline say 'Ship on Friday' and slide it in from the left.",
  "fromVersion": 3,
  "scope": { "beats": ["features"] }
}
```

Rules, checked in `reviseVideo`:

- **Feature and engine:**
  - `scoped_revision` is listed in `/api/v1/config` `features` (cli-and-sdk owns the array; this plan adds the
    string).
  - The parent's engine must have `capabilities.scopedRevision`. If not: `409 not_editable`, "Version 3 was made with
    Remotion, which can't redo scenes one by one yet. Revise the whole video instead." In v1 only HyperFrames has the
    capability.
- **`fromVersion` is required with `scope`** (`400`: "Say which version the scenes are from (fromVersion): scene ids
  belong to one version"). That stops a scope written against v3 being applied to a newer v4 that happens to share
  ids.
- **The parent:** must be `ready` and `contract === 1`. If not: `409 not_editable`, "Version 3 can't be edited scene
  by scene (it doesn't keep the editing contract). Revise the whole video instead."
- **`beats`:**
  - 1 to 20 ids, each matching `[a-z0-9][a-z0-9-]{0,40}`, de-duplicated.
  - Each must be a beat of the parent, read from `versions.beats` (§4.2). Unknown ids → `400 invalid_request`, naming
    them and listing the real ones with their labels: "There's no scene "feature". This video's scenes: intro
    (Opening), features (Features), …".
  - Not every beat (`400`: "That's every scene: revise the whole video instead (leave out scope)"). Refused rather
    than quietly treated as a full revision, so a script that thinks it froze something finds out it didn't.
  - Not `va-hold`, and not the last real beat when the version ends with `va-hold` (`400`: "This scene ends the video
    under your recorded narration and holds its last frame; redo it with a whole-video revision"). See open question
    7.
- **Fields that can't be combined with `scope`:** `planId`, `durationSec`, `sound`, `voiceover` → `400`, one message
  per field. `look` → `400 look_not_allowed` (looks plan). Plans and those settings describe the whole video. A scoped
  scene's voice line can still change: the request says so in words and the agent rewrites that line (§4.7).
- **Allowed with `scope`:** `commentIds` (same owner/admin rule) and `mediaIds` (new picks the scoped scenes may use).
- `webhookUrl` and `Idempotency-Key` work as for any revision.

The version stores `scope: { beats: string[] }` (new nullable `versions.scope` jsonb). Its `targetDurationSec` is
inherited from the parent, as now, and the finalize length notice is unchanged.

**No archive I/O in the transaction.** `reviseVideo` reads the parent's `versions.beats` inside the transaction. When
that's null (a version from before this plan), it fills them first, outside the transaction:
1. a read-only `loadJob` visibility check (so nobody can make the server unpack a private video they can't see);
2. only for a ready version, `ensureBundle` (the same fill as the beats route, §4.2);
3. store the beats on the parent with a separate update;
4. then open the transaction, which re-checks everything as now.

Nothing is unpacked while the job row is locked.

Why not a separate endpoint (`POST …/beats/{beat}/regenerate`): a scoped revision is a revision in every other way
(history, attempts, retries, comments, webhooks, credits). One field keeps REST, MCP, SDK and CLI in step and keeps one
code path. OpenAPI documents `not_editable` and `look_not_allowed` on the route's 409 and 400 responses.

### 4.2 Which scenes a version has: `beats` on the version

People and agents need the beat list to pick from. Today it's only inside the bundle.

- **At finalize,** compute `versions.beats` (new nullable jsonb) from the uploaded `source.tar.gz` and store it in the
  same transaction that marks the version ready. Shape: `[{ id, label, start, duration }]`, from
  `read(load(index.html))`, only when the composition declares contract v1.
  - Finalize already un-tars that archive for `runCreditsOf` (`src/domain/finalize.ts:447-456`). Refactor so it's read
    once (`readTarGz(gz, SOURCE_READ_LIMITS)`) and both use the map.
  - It's small: 20 beats is about 1 KB.
- **`contract` could be set the same way:** atomically with ready, instead of after it (`:277-287`, where `editable`
  briefly lags). It would have to use the same inputs as `ensureBundle`: `contractOf` over the archive **plus**
  `missingLocalFiles` with the reference files and the version's library media (`src/domain/bundles.ts:170-188`).
  Computing it from `index.html` alone would mark compositions editable that the bundle later finds incomplete. It's a
  small behaviour change for every version, so it's open question 8; recommended yes, with those inputs.
- **`VersionDto`** gains `beats: { id, label, start, duration }[] | null` and `scope: { beats: { id, label }[] } |
  null`. The labels come from the parent's beats, so history can say "Redid Features". These are additive
  (cross-plan rule 10). `editable` stays as it is.
- **Older versions: `GET /api/v1/videos/{id}/versions/{n}/beats`** (operationId `getVersionBeats`).
  - It follows the same visibility rule as the video: a private video someone can't see is 404.
  - When `versions.beats` is null and the version is ready, it runs `ensureBundle` outside any transaction, stores the
    list and returns `{ beats }`. Non-contract versions get `null`; versions that aren't ready get `409 not_ready`.
  - The DTO's `beats` is the cached value. When it's null, the revise panel, Redo this part, the CLI's `scenes` and
    MCP `get_video` (and the recipe's "find the beat") fall back to this route. A scoped revise fills it the same
    way (§4.1).
  - The editor still reads the bundle and never needs it.
  - A one-off backfill script is in §11.
- **Why store it rather than compute it per request:** the video DTO is on every list and poll path, and unpacking an
  archive there is too slow.

### 4.3 The run: still a `revision`, with a scope

The reconciler builds a revision manifest as today (`src/domain/reconciler.ts:268-330`) and adds:

```ts
scope?: {
  beats: string[]
  /** Stills from the parent MP4 so the agent can match the neighbours, relative to video/. Empty: no stills. */
  stills: { atSec: number; path: string; what: 'before' | 'after'; beat: string }[]
}
```

There's no `layout` in the manifest: prepare-run restores the parent first and reads the same
`{ id, label, start, duration }` list from it (`read(load(index.html))`), writing it into `.render/frozen/scope.json`.
The prompt's JSON comes from the reconciler, which has `versions.beats`. One source, nothing to disagree.

- **The parent MP4 comes from the existing `feedback.video`** (`src/lib/run-manifest.ts:56-62`). It's set for scoped
  revisions even when there are no pinned comments, with `pins: []`, which the parser already accepts. No duplicate
  `scope.video`.
- **Manifest version stays 1** (cross-plan rule 5). `verifyRunManifest` gains a shape check for `scope`:
  - ids as above, at most 20 beats;
  - at most 40 stills, each with a `path` under `feedback/scope/`;
  - `scope` requires `kind === 'revision'`, and non-empty `stills` require a `feedback.video`.
- **prepare-run step order** is the one render-engines §4.3 owns: restore and hydrate, then library media, then look,
  then recording and **scope files**. For a scoped manifest, prepare-run's scope step:
  - always copies the restored parent composition into `.render/frozen/` (today it does so only for narrated parents);
  - writes `.render/frozen/scope.json` with the beats and the parent's layout read from the restored files.
- **The stills are made with the feedback stills, last.** `feedbackStills` empties `video/feedback/` and runs last
  (`scripts/prepare-run.ts:65`, `:452-460`).
  - One call, `feedbackStills(root, mp4, pins, scopeStills)`, writes pin stills and scope stills from the one
    downloaded MP4 and lists both in `feedback/index.json`. The scope step doesn't write stills itself.
  - The engines plan's order gets a note: "feedback and scope stills, last" (recommended to the orchestrator).
  - Each scoped beat gets two stills: **before** (the last frame of the previous beat, if any) and **after** (the
    first frame of the next beat, if any). Those are what the scene has to cut from and into; the scene being
    replaced is in the HTML already.
  - Adjacent scoped beats share stills, which are de-duplicated, ≤ 40 in total. Files go to
    `video/feedback/scope/<beat>-<what>.jpg`; `feedback/` is never archived.
- **A large parent MP4 skips the stills.** Each scoped run downloads the parent MP4 (up to 2 GB, `finalize.ts:162`)
  just for the stills. When the parent's MP4 is over 300 MB (`outputs.bytes`), the reconciler sends
  `stills: []` and no `feedback.video` unless there are pins. The prompt then says "There are no stills of the
  neighbours for this video; read their HTML instead."
- **Kind:** reuse `revision`, as remix did. A new kind would touch every switch over `RunKind` for no behaviour the
  `scope` field doesn't already select. render-job and check-contract look for `scope` in the manifest.
- **HyperFrames only in v1** (cross-plan item 3). The splice and checks are this engine's.
  - render-engines defines `RunEngine.scopeCheck?(frozenDir, videoDir, beats): string[]`
    (`docs/plans/2026-11-04-render-engines.md:423`). It returns problems only, but render-job also needs the splice's
    bytes to render.
  - This plan asks for that signature to become
    `scopeCheck?(frozenDir, videoDir, beats): { problems: string[]; files?: Record<string, string> }`, where `files`
    is the splice's `index.html`/`summary.json` (recommended to the orchestrator; the engines doc is the cheaper edit).
  - Until it changes, render-job calls `spliceScoped` directly for HyperFrames and uses the hook only for the problem
    list.
  - Remotion has no hook until the engines plan's phase 3.

### 4.4 What the agent may change

Inside each scoped beat, **anything**: its children, its text, its media slots, its script, its sound effects, its
voice line. Its frame stays: the same `data-va-beat` and `data-composition-id`, the same position among the beats,
track 0.

| Part | Rule |
| --- | --- |
| Scoped `<section data-va-beat="X">` | Rewrite freely. Keep the id and position. One beat in, one beat out (no adding, splitting or removing beats in v1). Text ids must be unique and should start with `X-`. No `data-composition-src` and no `<link>`. |
| Scoped beat length | May change (0.5–120 s, the editor's bounds) when the request needs it; the prompt says keep it otherwise. It's snapped to whole frames before the relayout. Later beats move. **With recorded narration it must stay exactly the same.** |
| Scoped beat styles | At most one `<style>`, a direct child of the beat, holding exactly one prelude-less `@scope { … }` block (§4.6). No other `<style>` anywhere in the beat (including inside `<svg>`). Colours only through `var(--va-color-…)` roles the root declares; no `--va-color-*` declarations. |
| Scoped beat script | The `vaBeat` rules, plus a stricter escape check for scoped beats only (§4.6). |
| Other beats | Frozen: their `data-duration` is kept verbatim, and they're semantically equal to the parent's apart from derived attributes (§4.5). After the relayout, each must still have the parent's exact `data-duration`; that's asserted and tested. |
| `<head>`, the root's attributes (except `data-duration`), root-level `<style>` and `<script>` | Frozen. |
| Layers (music, background, logo bug, narration) | Frozen, except `data-duration` (the new total) and the music's ducking lane (`data-automation`, recomputed). The narration element is never touched, and the existing lock check also runs. |
| Existing files in `video/` | Byte-identical and still present, except the derived files below. |
| New files | Allowed anywhere under `assets/` (the prompt asks for `assets/beats/<X>/`). Every frozen part of the HTML is frozen, so only scoped beats can refer to them. |
| `summary.json` | Scoped beats' captions are the agent's. Every other cue is recomputed from the parent's (shifted). `title` and `summary` are the agent's; `credits` is the union of the parent's and the agent's. |
| `assets/voice/script.json`, `voice.json`, `assets/voice/X.wav` | Only scoped beats' entries may change, with the same provider, voice and speed (the re-voice guard's rules). A scoped beat in a voiced video may gain a line; it may not remove another beat's. |
| `assets/music/credits.json` | Append-only: a fetched sound effect adds its credit, and existing entries stay. |
| Recorded narration (`assets/narration/bus.wav`, the `va-narration` element, its captions) | Untouched; `checkNarrationKept` runs as for any narrated revision. |
| Screen-recording beats (screen-recording plan) | Whatever that plan registers in `DERIVED_FILES`: today `assets/recording/plan.json`, plus `assets/recording/<step>.cursor.js` and `assets/recording/<step>.hold.jpg` for the scoped recording steps (screen-recording plan, draft 3). That plan's `recording.ts check` (the redaction guard) runs inside `check-contract --fix` when the composition has recording beats. |

Why let the length change: "make this scene twice as long so people can read it" is a common ask, and the editor
already lets people retime beats with the same consequences. Why one-in-one-out: comments, captions, edit drafts and
the editor all key on beat ids, and inserting or splitting beats changes the shape of the video. That needs its own
design (§11).

### 4.5 The splice and the check (`src/lib/scope.ts`)

One module, shared by `check-contract.ts`, render-job and finalize, in the same style as `src/lib/revoice.ts`. The
frame math (relayout, caption sync) comes from `src/lib/contract-core.ts` (cross-plan rule 6). It's imported, not
re-exported from `contract.ts`. If this plan lands before render-engines phase 1, it creates that module under that
name with `relayout`, the new `relayoutScoped` and `syncCaptions` in it.

```ts
export interface ScopeInput {
  parent: { html: string; summary: Summary; voice?: VoiceFile | null; script?: VoiceScript | null }
  agent:  { html: string; summary: Summary; voice?: VoiceFile | null; script?: VoiceScript | null }
  beats: readonly string[]
  /** Recorded narration: scoped beats keep their length. */
  lockedLength: boolean
}
/** The composition the scope allows: the parent with the agent's scoped beats spliced in, relaid, recaptioned, reducked. */
export function spliceScoped(i: ScopeInput): { html: string; summary: Summary; putBack: string[]; problems: string[] }
/** Every way the agent's composition differs from the splice outside the scope, in plain words (semantic compare). */
export function scopeProblems(i: ScopeInput, splice: { html: string; summary: Summary }): string[]
/** Files: every parent file outside the derived set is present and byte-identical in the agent's set. */
export function scopeFileProblems(parent: Map<string, string /*sha256*/>, agent: Map<string, string>, derived: readonly string[]): string[]
/** The derived set for a scope; other features append to it (screen recordings add assets/recording/plan.json and, for scoped steps, <step>.cursor.js and <step>.hold.jpg). */
export const DERIVED_FILES: ((beats: readonly string[], comp: Composition) => string[])[]
```

**`spliceScoped`, in order:**

1. Validate the **parent** only. A failure there is a server bug, since `not_editable` should have stopped it, and is
   reported as one. Load the agent's file (`load`) **without** validating it: its derived values are expected to be
   stale.
2. **Beat list:** the agent's beats must be the parent's ids, in the parent's order, each once. Added, removed,
   renamed or moved beats are reported by label.
3. **Splice:** start from the parent document and replace each scoped section with the agent's (deep clone).
4. **Scoped beats:**
   - Snap each one's `data-duration` to whole frames, and refuse a change when `lockedLength`.
   - Set `data-va-authored-duration` to the duration (it's freshly authored, so its captions don't stretch).
   - Run the style and script checks (§4.6).
5. **Scope-aware relayout:** `relayoutScoped(d, scoped)` in `contract-core.ts`, next to `relayout`.
   - Frozen beats keep their `data-duration` string **verbatim**.
   - Only scoped beats are snapped (step 4).
   - Each beat's `data-start` becomes `fmt(sum of the durations before it)`, which is what `validate` expects (`:424`).
   - The root, layers and video slots get the new total.
   - Speech spans and ducking are recomputed as `relayout` does.

   Plain `relayout` would be wrong: it snaps cumulative ends, and an authored parent is never relaid (§2), so a 3.85 s
   frozen beat would change. After the relayout, frozen durations are asserted equal to the parent's, as a test and a
   runtime assertion.
6. **Captions:**
   - Keep the agent's cues whose `beat` is scoped, deriving a missing `beatStart`/`beatEnd` as `start − beat.start`.
     Then compute their absolute times from beat-relative ones, snapped as `syncCaptions` does (a fresh beat).
   - Keep the parent's other cues, including recorded-narration cues, which belong to no beat. A frozen beat's cues
     are **shifted by that beat's start delta**, without re-rounding, so unshifted beats keep their cue times exactly.
     `syncCaptions` snaps every cue (`:1072-1073`), which could move a frozen cue by a frame.
   - Voice cues for voiced scoped beats are recomputed from `voice.json` with the code `syncVoice` uses, so they can't
     be hand-edited.
   - Sort by `(start, beat, textId)`.
7. **`title` and `summary`** come from the agent; **`credits`** = parent ∪ agent, de-duplicated, order kept.
8. **Validate the splice.** Its violations are reported as the agent's ("Scene "Features": its voice-over runs to
   5.2 s; make the scene longer").
9. **`putBack`** lists every difference between the agent's file and the splice outside the scope (from
   `scopeProblems`), in plain words.

**`scopeProblems` compares semantically, never as strings.** It walks the agent's tree and the splice's, skipping
scoped sections:

- whitespace-only text nodes are dropped;
- text is whitespace-collapsed, except inside `script`, `style`, `pre` and `textarea`, where it's trimmed;
- attributes are compared as a sorted map;
- derived values are skipped: `data-start` on beats, `data-duration` on the root, layers and video slots, and the
  ducking `data-automation` on a `data-va-duck` layer.

Each difference is named: "`<head>` changed (a `<style>` was added)", "Scene "Opening" changed (its headline text)",
"The music layer's volume changed", "Root attribute data-va-contract changed". It also compares:

- `summary.json` cues of other scenes, order-insensitively (by beat, `textId`, text and beat-relative times);
- other beats' `voice.json` entries and `script.json` lines;
- the provider, voice and speed.

A file that is only re-indented has no problems. **The render always uses the splice's bytes**, never the agent's:
`save(splice)` for `index.html` and `JSON.stringify(splice.summary, null, 2)` for `summary.json`. render-job writes
those bytes before it renders and archives. Splicing a splice gives the same bytes again (a fixed point of the parse5
round trip), so finalize can require **byte equality** (§4.9). The semantic compare is for what the agent sees while
working, and for messages.

**`scopeFileProblems`** compares hashes:

- **Parent side:** `.render/frozen` in the run; the parent's `source.tar.gz` in finalize.
- **Agent side:** the agent's files.
- **Excluded:** the derived set (`index.html`, `summary.json`, `assets/voice/script.json`, `assets/voice/voice.json`,
  `assets/music/credits.json`, `assets/voice/<scoped>.wav`, plus whatever `DERIVED_FILES` adds), and reference files
  (the narration bus, covered by the narration lock).
- **Reported:** any parent file that is missing or different. `credits.json` is checked separately as append-only, and
  new files are fine.
- **The held still `assets/hold/last.png` is not excluded,** unlike in `keptHash`. There it's excluded because the
  narration step rewrites it, and a scoped run has no narration step.

Why "splice then compare" rather than a diff with an allow list: the splice says exactly what the result must be, so
the check can't drift from the rule, and the render uses the splice, so what people get is what was checked. The
re-voice guard proved this shape (`checkRevoiced` compares with `applyRevoice`'s output).

### 4.6 Styles and scripts that can't leak

The scoped beat gets at most one `<style>`, as its direct child, holding a **prelude-less** `@scope`:

```html
<section class="clip" data-va-beat="features" …>
  <style>
    @scope {
      .card { border-radius: 24px; background: var(--va-color-surface); }
      .card h2 { font-size: 84px; }
    }
  </style>
  …
</section>
```

A prelude-less `@scope` in a `<style>` scopes to that style's parent element, so the agent can't get the beat id
wrong. The check parses the style with `css-tree`, made a direct dependency at the version already installed (3.2.x).
It walks the AST and requires:

- exactly one top-level `@scope` rule, with no prelude;
- **an allow-list of at-rules inside it:** only `@media`, `@supports`, unnamed `@container` and `@keyframes`. Every
  other at-rule is refused by name (`@import`, `@font-face`, `@namespace`, `@layer`, `@property`, `@counter-style`,
  `@page`, `@font-palette-values`, `@position-try`, `@view-transition`, named `@container`, and any added later), since
  many of them are global. An allow-list doesn't need updating with each Chrome release (the renderer is Chrome 156);
- no `:root`, `html` or `body` in selectors, and no `:has()` that reaches outside the scope root;
- `url()` only to plain relative paths under `assets/`: no `//`, no scheme (`data:`, `http:`, `javascript:`), no
  `..`;
- any `@keyframes` named with the prefix `X-` (keyframe names are global even inside `@scope`);
- no custom property declarations named `--va-color-*`.

In the scoped beat's markup, the check also refuses:

- another `<style>` (including inside `<svg>`);
- `<link>`;
- a `style` attribute declaring `--va-color-*`;
- `data-composition-src`.

**Spike B1** is part of the phase 1 fixture, not a phase 0 gate. It confirms the renderer's Chrome applies a
prelude-less `@scope` inside the beat and not outside. `@scope` has been in Chrome since 118 (MDN compat data), and
HyperFrames renders with a current headless Chrome, so this should pass. If the prelude-less form misbehaves, the
fallback is `@scope ([data-va-beat="X"])` with the prelude checked against the id.

**Fonts:** `@font-face` is global, so v1 lets a scoped beat use only fonts the composition already loads. The brand's
fonts are all there.

**Scripts:** for scoped beats only, the `vaBeat` script check adds
`parentNode|parentElement|ownerDocument|getRootNode|closest\(|previousElementSibling|nextElementSibling|globalThis|self\.|\bwindow\b|\beval\b|\bFunction\(`
to the existing `document`/`__timelines` regex. It also refuses **string targets** in GSAP calls, since GSAP resolves
strings against the whole document:
`/\b(tl|gsap)\.(from|to|fromTo|set|timeline)\(\s*['"\`]/` and `/gsap\.utils\.toArray\(\s*['"\`]/`. The prompt
says: "select with el.querySelector(All) and pass elements to the timeline, never selector strings."

`\btop\b`, `\bparent\b` and `\bframes\b` are **not** added: `top` is a CSS property GSAP animates
(`{ top: 10 }`), and `parent`/`frames` are common words in names. They'd refuse honest scripts. It's applied to scoped beats rather than to every beat (as the review
proposed) because `validate` runs on every new run and on bundles of existing versions. Tightening it for all beats
would make working videos non-editable and fail runs that do nothing wrong. Isolation stays a heuristic: a determined
script can still reach outside its beat. The only check on pixels is the live gate's SSIM over frozen scenes (§10).

### 4.7 Voice, music and recorded narration

- **AI voice-over.** If the parent is voiced and the scoped beat has a line, the agent edits **only that beat's line**
  in `assets/voice/script.json`, then runs `npx tsx scripts/voice.ts` and `voice.ts sync`. `voice.ts` re-speaks every
  line that differs, which is why the prompt says to edit only that line. The guard checks that only scoped entries
  changed, with the same provider, voice and speed. A beat's length must still fit its voice; validating the splice
  enforces "make the beat longer". A parent with no `voice.json` has no `assets/voice/` in its archive, and then the
  voice checks are skipped.
- **Music.** The layer is frozen; its duration follows the total and its ducking lane is recomputed. With music on,
  sound effects may be added inside the scoped beat as `<audio id>` children, with their files as new files.
- **Recorded narration.** The scoped beat keeps its exact length. No new `<audio>` and no unmuted `<video>` while the
  narration speaks (its `data-va-speech` spans), and its captions stay. `checkNarrationKept` runs as for every
  revision of a narrated video, and `spliceScoped` adds the length rule.
- **Held last frame.** Refused in v1 (§4.1). Later: a scoped run of that beat ends with the narration step's hold
  capture, the way render-unchanged runs do (§11).

### 4.8 The prompt

`buildPrompt` gets a `scope` input and adds a section after the revision line (`src/domain/prompt.ts:215-217`), in
place of "Change only what the request asks for". `PROMPT_TEMPLATE_VERSION` goes up by one in this plan's phase 2 PR,
in the cross-plan merge order (after looks phase 2). That PR also makes `test/remix-run.test.ts` import the constant
if no earlier PR has. **Without a scope, the prompt text is byte-identical to today's.**

```
This is a scoped revision of version 3: change only these scenes, as JSON (start and duration in seconds of version 3):
<<<
[{"id":"features","label":"Features","start":4.0,"duration":6.5}]
>>>
- Everything else is frozen exactly as version 3 has it: the other scenes (their HTML and scripts), <head>, the root
  and its styles and scripts, every layer, and every file already in video/. Changes there are put back and the
  render is refused if they remain.
- Inside a scoped scene you may rewrite anything: its elements, text, media slots, script and sound effects. Keep its
  data-va-beat and data-composition-id, its place in the order, and text ids that start with "features-".
- Styles it needs go in one <style> directly inside the scene, holding one @scope { … } block (no selector after
  @scope). Use only the --va-color-… roles the root declares and fonts the composition already loads. Put new files in
  video/assets/beats/features/. Its script selects only inside its own element: use el.querySelector(All) and pass
  elements to the timeline, never selector strings, and never its parents or siblings.
- Keep its length unless the request asks for a change or the new content needs more or less time (0.5 to 120
  seconds); later scenes move with it.
- Match the neighbours: video/feedback/scope/ has stills of version 3: the last frame of the scene before and the
  first frame of the scene after. Your scene's last frame is what the next scene cuts from, and the next scene starts
  exactly as it does now.
- In summary.json, write cues only for the scoped scenes' text; the others are put back from version 3.
- After every change run: npx tsx scripts/check-contract.ts --fix. It re-lays the scenes, puts back everything outside
  the scope (other scenes' captions, the music's ducking, anything you changed there) and says what it put back. Keep
  going until it says OK. If you needed something outside the scope, say so in your summary.
```

- **With a voice:** "Edit only this scene's line in assets/voice/script.json, then run npx tsx scripts/voice.ts and
  npx tsx scripts/voice.ts sync."
- **With recorded narration:** "Keep each scoped scene exactly as long as it is now", plus the existing
  locked-narration lines.
- **Without stills** (a parent MP4 over 300 MB, §4.3): "There are no stills of the neighbours for this video; read
  their HTML instead."
- **On a retry after a scope refusal:** the attempt's stored error (the `scope_violated` or finalize message, with its
  list of what was outside the scope) is added as data in its own fence: "The previous attempt was refused for
  changing these parts outside the scope; leave them as they are: …". It's derived from the version's own attempts, so
  every retry of the same state gets the same prompt.
- The numbered steps (read the skill, write, check, summary, render) stay as they are.

The scene list is agent-written data (labels come from `data-va-label`), so it goes in a fence through `sanitizeBrief`
(`src/domain/prompt.ts:106`), and ids are checked before they reach the prompt.

### 4.9 Enforcement points

1. **`check-contract.ts --fix`, run by the agent.** `--fix` is the new name, and `--duck` stays as an alias.
   - With a scope in `.render/run-manifest.json`, it writes the splice over `video/index.html` and `video/summary.json`
     and prints what it put back (`putBack`).
   - It also prints `scopeFileProblems`, which it can't fix (a changed or deleted existing file), and splice
     validation problems.
   - With a screen-recording beat in the composition, it runs that plan's `recording.ts check`.
   - It exits 1 while anything was put back or remains, and prints "Contract v1: OK (scope: features)" otherwise.
   - Without a scope, `--fix` does what `--duck` does today.

   This is **revert and report** on the run side: the agent sees what it touched and can move what it needed into
   the scene.
2. **render-job, run by the agent, before the render.** The scope check is a **separate `if`** after the existing
   guard ladder (`scripts/render-job.ts:104-176`), not another `else if`. A scoped revision of a narrated parent then
   gets both the narration check and the scope check.
   - It reads the manifest's scope and `.render/frozen`, re-runs the splice and the checks, and refuses anything
     `putBack` would change or any file or validation problem, with `StepError` `scope_violated: <first problem>`,
     the full list, and "Run npx tsx scripts/check-contract.ts --fix, put those parts back, and run render-job again."
   - On success it writes the splice's bytes, renders them, and logs `scope.verified { beats, lengthDelta, newFiles }`.
3. **Finalize, on the server, before the version can be ready.** For a version with `scope`:
   - **When:** after the MP4/poster/GIF/VTT checks and **before any `blobs.set`**.
   - **The parent's archive:** read it with `blobs.get('sources', parentOutput.sourceKey)` and hash-check it against
     `parentOutput.sha256['source.tar.gz']`; read its references with `readReferences` (for the bus length). Missing →
     `source_unavailable`.
   - **Both archives** are parsed with `readTarGz(…, SOURCE_READ_LIMITS)`, never the 50 MB defaults.
   - **The checks:** run `spliceScoped` on the parent's archive and the uploaded one. The uploaded `index.html` and
     `summary.json` must be **byte-identical** to `save(splice)` and `JSON.stringify(splice.summary, null, 2)`.
     render-job writes exactly those bytes before archiving, so an honest run always passes. `scopeProblems` is used
     only to write the message. `scopeFileProblems` runs on file hashes and the voice files as before.
   - **The MP4 binding:** `|MP4 durationSec − splice root duration| ≤ 0.25 s`.
   - **A failure** fails the attempt as `invalid_output` with "This run changed parts of the video outside the scenes
     it was asked to redo: …". Why `invalid_output` and not a new category: the UI already explains it and offers
     **Retry**, and the message says the rest.

**What this guarantees and what it doesn't.** The saved composition (the archive future edits, revisions and remixes
start from) is guaranteed. Outside the scope, its `index.html` and `summary.json` are byte-for-byte what splicing the
parent produces, and every other existing file is the parent's. Finalize doesn't derive the MP4 from the archive for
any run kind, so a run that changed render-job could render one thing and upload another. Like every run's MP4, it's
trusted, bound here by its length. The live gate checks frozen scenes' frames by SSIM. Rendering the archive on the
server would close this gap for every run kind; that's §11.

### 4.10 Model, effort and time

- **v1 runs scoped revisions on the deployment's model and effort** (`AGENT_MODEL`/`AGENT_EFFORT`), like every run.
  The gate measures that.
- **A separate model for scoped runs is after the gate** (§11). Scoped runs read and write less, so they may suit a
  faster model, but the knob (`SCOPED_AGENT_MODEL`/`SCOPED_AGENT_EFFORT`, plus `newAttempt` options in revise and
  retry) isn't added until a measured comparison shows a win.
- **Expectation to test, not a promise:** 40–100 credits and 2–4 minutes for a 20–60 s video, against 90–250 credits
  for authoring and about 120 for a revision-kind run (§1). The time includes downloading the parent MP4 for the stills
  (skipped over 300 MB, §4.3). The render is still the whole video; rendering only the changed frames is §11.
- The 22-minute authoring deadline is unchanged.

### 4.11 Comments: "Redo this part"

- A comment pinned to a moment (`timeSec`) belongs to the beat whose `[start, start + duration)` contains it, using
  the commented version's `beats`.
- **On a pinned comment** (owner or admin, since it incorporates the comment), **Redo this part** always **opens the
  scoped revise dialog**: that scene picked, the comment checked (`commentIds: [id]`), an optional note, and the cost
  line. It never posts directly, because it spends credits. The still from the parent MP4 is made as today.
- **Incorporate feedback** (`IncorporateModal`, `ui/src/components/Review.tsx:274`) gets a switch, **Only change the
  scenes these comments point at**, shown when every picked comment is pinned. On: `scope.beats` is the distinct beats
  of the picked pins and `fromVersion` the commented version. This is likely the most-used path: a reviewer leaves
  three notes on two scenes, and the owner fixes exactly those two. The switch starts **on** when the pins fall in
  fewer than half the scenes and **off** otherwise: a reviewer who commented on every scene wants a whole revision
  (open question 5).
- Others who can revise but can't incorporate (a Creator on someone else's video) use the scene picker without the
  comment.

### 4.12 UI (v1)

Everything here uses plain words, and every action says what it costs ("Uses AI credits, usually less than a full
revision").

- **Video page, revise panel** (`ui/src/pages/Video.tsx:1092`):
  - A choice above the prompt: **Whole video** (default) or **Some scenes**.
  - **Some scenes** shows the shown version's scenes as chips with label and time ("2. Features · 0:04–0:10"); click
    to pick. It sends `fromVersion` as the shown version.
  - Picking scenes hides the length, sound, look and plan controls, with one line: "Length, sound and voice stay as
    they are. Say in the request if a scene should run longer."
  - Disabled, with the reason, when the version isn't editable or its engine can't redo scenes. Hidden when the
    server doesn't list `scoped_revision`.
- **Comments:** Redo this part, and Incorporate's switch (§4.11).
- **History:** a scoped version says "v4 · Redid Features", with the request.
- **After a scope refusal:** a failed scoped version whose error is a scope refusal shows **Revise the whole video**
  next to **Retry** (`ui/src/pages/Video.tsx:682`), opening the revise panel on Whole video with the same request.
  Retry carries the refusal into the next prompt (§4.8).
- Other people are editing `Edit.tsx`, `Video.tsx` and `ui/src/api/*` right now; this plan only names where things go.

Editor entry points (beat card, timeline menu), hover-to-seek on chips and the version switcher's jump wait until the
live gate passes; their designs are in §11.

### 4.13 MCP, skill, SDK and CLI

- **MCP `get_video`** returns each version's `beats` (id, label, start, duration) so agents can pick. When a version's
  cached `beats` is null, the tool fills it through the same code as `GET …/versions/{n}/beats`.
- **MCP `revise_video`** gains `beats` (an array of beat ids) and, with it, requires `from_version`. Description:
  "Optional. Redo only these scenes (ids from get_video's beats for from_version); everything else stays exactly as it
  is. Faster and cheaper than revising the whole video. Needs from_version. Can't be combined with plan_id,
  duration_sec, sound, voiceover or look." Errors pass through: `not_editable`, unknown ids with the real list,
  `look_not_allowed`.
- **MCP catalog and skill** say **Redo a scene** (`src/mcp-catalog.ts`, `skills/netlify-video/SKILL.md`,
  `references/recipes.md`). The recipe:
  1. `get_video` → find the beat by label or time.
  2. `revise_video` with `beats` and `from_version`.
  3. Follow the run.
  4. Review only that scene.

  Also: prefer redoing scenes for feedback on specific moments.
- **SDK** (`netlify-video-agent-sdk`, cli-and-sdk plan):
  - `client.videos.revise(id, { prompt, fromVersion, scope: { beats } })` from the OpenAPI types;
  - the hand-written sugar `client.videos.redoScenes(id, { beats, prompt, fromVersion?, …opts })`, which fills
    `fromVersion` from the latest ready version when it's omitted and sends an idempotency key;
  - `beats` comes from the version DTO; when it's null, the SDK's generated `getVersionBeats` (and the CLI's
    `scenes`) call `GET …/versions/{n}/beats`. There's no hand-written beats method beyond that resource row;
  - before sending a scope, it checks `features` for `scoped_revision` and throws `unsupported_by_server` when it's
    missing.

  This plan adds the resource-method rows in its own PR, and the coverage test enforces that.
- **CLI** (`netlify-video-agent`, bin `video-agent`):
  - `video-agent scenes <video> [--version n]` lists scenes.
  - `video-agent revise <video> --scene <id|label> … "<change>"`: repeatable; accepts an id or a unique label,
    case-insensitive.
  - `video-agent redo <video> --scene <id|label> … "<change>"`: the short form, hidden until the server lists
    `scoped_revision`.
  - Both send an idempotency key (and take `--idempotency-key`) and `--version`; `--wait` follows the run like other
    commands.
  - `not_editable` (409) maps to exit code 7, by the CLI plan's rule.
- **Local mode** (`video-agent local …`, "make one locally, then deploy it for your team"): the splice and checks live
  in `src/lib/scope.ts` and the scripts, so a local project can redo a scene the same way. That's also how the check gets exercised without credits.
- **GitHub Action:** its `/video redo <scene> <change>` comment command uses `scope.beats` (github-action plan).

## 5. Data and API changes

| Change | Detail |
| --- | --- |
| `versions.scope` | jsonb, nullable: `{ beats: string[] }`. One migration with `versions.beats`, after looks phase 2's in the cross-plan migration order. |
| `versions.beats` | jsonb, nullable: `[{ id, label, start, duration }]`, set at finalize with ready for contract v1, filled lazily for older versions. |
| `ReviseSchema` | `scope: { beats: string[1..20] }`, optional; `fromVersion` required when `scope` is present. Documented. `npm run openapi:gen`. |
| `VersionDto` | Additive `beats` and `scope` (with labels). |
| `ErrorCode` | `not_editable` (409) and `look_not_allowed` (400, defined by the looks plan), both documented on the route. |
| `/api/v1/config` `features` | Adds `scoped_revision`. |
| `RunManifest` | Optional `scope` (§4.3); `feedback` with `pins: []` is allowed. Shape check in `verifyRunManifest`. |
| `PromptInput` | Optional `scope`; the template constant goes up by one in this plan's PR. |
| `GET /api/v1/videos/{id}/versions/{n}/beats` | New, operationId `getVersionBeats`: `{ beats }` (null for non-contract versions), filled and stored on first read; video visibility rules; `409 not_ready` before ready. SDK resource row and MCP fallback. |
| Prompt on retry | A refused scoped attempt's error is added to the next attempt's prompt as fenced data (§4.8). |
| Webhooks | `video.ready`/`video.failed` carry the version DTO, so `scope` comes along; no new events. |
| Dependencies | `css-tree` (already installed via `hyperframes`) becomes a direct dependency. |

## 6. Permissions, privacy, credits

- Same as revising: `version:create` (Admin, Creator); Reviewers and Viewers can't. A Creator can redo scenes of
  someone else's video, adding a version they author, as with any revision.
- `commentIds` keeps its owner/admin rule, and Redo this part on a comment follows it.
- Private videos stay private: scoping changes nothing about who can see or revise.
- Credits are spent like any run and attributed to the author and key. The UI says scoped runs usually cost less, and
  never gives a number until the gate has measured one.

## 7. Build order

Each phase ends with a gate. Live gates spend credits: each one runs `--dry` first (it prints the steps and projected
credits and spends nothing), then **asks the owner before it runs**, with a credit ceiling. There's no blanket
pre-approval.

### Phase 0: spikes

- **B2: does a frozen beat render the same?** No credits. Render a fixture, then render it again with one middle beat
  replaced and its length changed. Compare the untouched beats' frames at matched beat-relative times with ffmpeg's
  `ssim` filter. This sets the drift threshold for the gate (expect ≥ 0.99: H.264 at different offsets won't be
  bit-identical).
- **B3: one hand-made scoped run.** About 100 credits. Use a draft scoped prompt and the scope checks as a script, on
  a real 3–5 beat video with music. Record credits, time, `check-contract --fix` rounds, and whether the run stayed
  in scope.
- **Gate:** a short note in `docs/spikes.md` with both results.

(B1, `@scope` in the renderer, is in phase 1's fixture: §4.6.)

### Phase 1: the splice and the checks (run side). Needs render-engines phase 1.

1. `contract-core.ts`: import `relayout` and caption sync from it, or create it with them if this plan lands first,
   and add `relayoutScoped` (frozen durations verbatim, scoped ones snapped). No behaviour change to `relayout`; the
   editor's tests keep passing.
2. `src/lib/scope.ts`: `spliceScoped`, `scopeProblems` (the semantic compare), `scopeFileProblems`, `DERIVED_FILES`,
   the `css-tree` style check and the scoped script check. All problems in plain words.
3. Register the HyperFrames `scopeCheck` on the engine (render-engines interface).
4. `RunManifest.scope` and its checks; `feedback` with empty pins.
5. prepare-run: the frozen copy and `scope.json` (with the layout read from the restored parent) in the scope step;
   the stills (2 per beat, de-duplicated, ≤ 40) in the one `feedbackStills` call, last.
6. `check-contract.ts --fix` (with `--duck` as an alias) and the scope.
7. render-job: the separate scope `if`, `scope_violated`, rendering the splice's bytes.

**Gate:**
- the unit tests (§8) are green;
- **B1:** a fixture with a prelude-less `@scope` beat renders with the styles applied inside it and not outside;
- a fixture end to end with a fake manifest (prepare-run → a hand-edited scoped beat → `check-contract --fix` →
  render-job up to the render step) passes;
- a tampered fixture fails with the right message.

### Phase 2: the service. Needs cli-and-sdk phase 1 (operationIds, `features`).

1. Migration: `versions.scope`, `versions.beats`.
2. Finalize: one `readTarGz` for credits and beats; store `beats` with ready (and `contract`, if open question 8 says
   yes, with `ensureBundle`'s inputs); the server-side scope check (byte equality with the splice, file hashes) with
   the parent archive, and the MP4 length binding.
3. `reviseVideo`: the scope rules and errors, the engine capability gate, `fromVersion` required, `look_not_allowed`,
   and the lazy beats fill outside the transaction.
4. Reconciler: `scope` in the manifest with stills, and `feedback.video` set (none over 300 MB); the `buildPrompt`
   scope section, including the no-stills and retry lines; the template constant +1.
5. `GET …/versions/{n}/beats` with the visibility check and the stored fill; the same fill in `reviseVideo` before
   its transaction.
6. REST schema and DTO, `openapi:gen`; `scoped_revision` in `features`; MCP `revise_video` and `get_video`; the
   catalog row and skill recipe ("Redo a scene").

**Gate:** integration tests green; **live gate part 1** (§10 steps 1–2) on production, after `--dry` and the owner's
OK.

### Phase 3: the UI

1. The revise panel's scene picker.
2. Redo this part on a comment; Incorporate feedback's scoped switch.
3. The history label, and **Revise the whole video** next to **Retry** after a scope refusal.

**Gate:** Playwright (§8); a person redoes a scene from each entry point on production.

### Phase 4: SDK, CLI, docs and measurement. Needs cli-and-sdk phases 2–3.

1. SDK rows (`scope` on `revise`, `redoScenes`) and CLI commands (`scenes`, `revise --scene`, `redo`).
2. README: "Redo a scene". The API docs follow from OpenAPI, and the CLI page is the CLI plan's.
3. **Live gate part 2** (§10 steps 3–6), after asking the owner. Write the numbers into `docs/spikes.md` and this plan's "As built".
4. After the gate: the editor entry points and the rest of §11's "after the gate" list, if the owner wants them.

Phases 1 and 2.1–2.2 can run in parallel with phase 3's layout work once the DTO shape is fixed.

## 8. Tests

**Unit tests** (`src/lib/scope.test.ts`, fixtures under `test/fixtures/scope/`):

- **Splice and relayout:**
  - Only the scoped beat changed → no problems, and the splice equals the agent's file semantically.
  - The scoped beat grew 2 s and the agent left later starts stale → `--fix` re-lays it with no problems. Later beats
    start 2 s later, the root and layers are 2 s longer, later text cues move 2 s, voice cues follow their beats, and
    the ducking lane equals `applyDucking` on the result.
  - **A 3.85 s scoped beat** (115.5 frames) is snapped. Every frozen beat after it keeps the parent's exact
    `data-duration`.
  - Shrunk below its voice's end → the splice validation's "make the scene longer".
  - **A parent whose frozen beats are 3.85 s long** (authored, never relaid): the splice keeps their durations
    verbatim, the starts validate, and the cues of frozen beats before the scope keep their exact times.
  - **Fixed point:** splicing the splice gives byte-identical `index.html` and `summary.json`.
- **Comparison:**
  - **A prettier-formatted file** with no semantic change has no problems: re-indented frozen beats, reordered
    attributes, reflowed head.
  - Changes outside the scope are each reported once, naming the scene by label: a `<head>` style added; another
    beat's text; another beat's script; a layer's volume; a root attribute; a root-level `<script>`.
  - A beat renamed, removed, added or moved → reported.
- **Styles:**
  - Valid prelude-less `@scope` → fine.
  - Reported:
    - a prelude naming another beat;
    - two `@scope` blocks;
    - a block that closes early and continues (`} body {`);
    - `@import`, `@font-face`, `:root`;
    - `url(https://…)`;
    - an unprefixed `@keyframes`;
    - a `--va-color-accent` declaration (in the style or a `style` attribute);
    - a second `<style>`, including inside `<svg>`;
    - `<link rel=stylesheet>`;
    - `data-composition-src`.
- **Scripts:** `el.parentElement`, `el.closest('#root')`, `el.ownerDocument`, `window.x`, `tl.from('.card', …)` and
  `gsap.utils.toArray('.card')` in a scoped beat → reported. `tl.to(el.querySelector('.card'), { top: 10 })` → fine.
  The same code in a frozen beat → not reported (existing videos stay editable).
- **At-rules:** `@media`, `@supports`, unnamed `@container` and prefixed `@keyframes` inside `@scope` → fine;
  `@property`, `@counter-style`, `@page`, `@layer`, named `@container` → reported. `url(//x)`, `url(data:…)`,
  `url(../x)` → reported.
- **Narration:** a length change while locked → refused. A new `<audio>` over speech → refused (by `checkNarrationKept`
  in the same run).
- **Held frame:** a scope on the last real beat before `va-hold` → refused by `reviseVideo`. A tampered
  `assets/hold/last.png` → reported by `scopeFileProblems`.
- **Voice:**
  - Reported: another beat's `voice.json` entry changed; provider, voice or speed changed; another beat's
    `script.json` line changed.
  - Fine: the scoped line changed with a matching WAV length; cues in a different order; a parent without
    `voice.json`.
- **Files:** an existing file modified or deleted → reported; a new file under `assets/beats/X/` → fine;
  `credits.json` with an entry edited → reported, appended → fine; a `DERIVED_FILES` extension entry → excluded.
- **Summary:** other scenes' cues hand-edited → put back by `--fix`; render-job refuses if they're left.

**Other unit and integration tests** (`test/*.test.ts`):

- `run-manifest.test.ts`: the scope shape checks (a bad id, too many beats, a still path outside `feedback/scope/`,
  `scope` without `feedback.video`, `scope` on a non-revision kind); `feedback` with empty pins.
- `prompt.test.ts`: snapshots of a scoped prompt (silent, voiced, narrated); **without a scope, byte-identical to the
  previous template**.
- `remix-run.test.ts` imports `PROMPT_TEMPLATE_VERSION`.
- New `scoped-revise.test.ts`:
  - every `reviseVideo` rule and message: not editable, the engine lacking `scopedRevision`, a missing
    `fromVersion`, unknown ids with the list, all beats, the held frame, each refused combination including `look`;
  - the stored scope; an idempotent replay; the `commentIds` policy;
  - the lazy beats fill happens outside the transaction (the fake store asserts no Blobs call while locked).
- Reconciler: the manifest has scope, de-duplicated stills (2 per beat) and `feedback.video` with empty pins; a
  parent MP4 over 300 MB gives `stills: []`, no `feedback.video` and the no-stills prompt line; a retry after a scope
  refusal carries the previous error in its prompt, and two retries of the same state get the same prompt.
- Beats route: returns and stores beats for a pre-plan version; `null` for a non-contract version; `409 not_ready`;
  404 for a private video the caller can't see; `reviseVideo`'s fill does no Blobs work for a caller who can't see
  the video.
- Finalize:
  - A scoped upload that matches → ready, with `beats` set in the same transaction.
  - One that changed another scene → failed `invalid_output` with the message, and **no blobs written**.
  - The parent archive missing → `source_unavailable`.
  - An MP4 0.5 s off the splice's length → `invalid_output`.
  - An uploaded `index.html` that is semantically equal to the splice but differs in bytes (re-indented frozen scene)
    → `invalid_output` (finalize requires bytes).
  - The parent archive over the default 50 MB but under `SOURCE_READ_LIMITS` → read fine.
- prepare-run: the frozen copy, and pin stills plus scope stills from one `feedbackStills` call (neither deletes
  the other, both listed in `feedback/index.json`), using ffmpeg on a fixture MP4 as the feedback-still tests do.
- render-job: a scoped revision of a narrated parent runs both the narration and the scope checks.
- `mcp-catalog.test.ts` and an MCP test for `beats`/`from_version` on `revise_video` and `beats` on `get_video`.

**Playwright** (`npm run test:ui`):
- the revise panel's Some scenes: the picker, the hidden controls, a request body with `scope` and `fromVersion`;
- hidden when `features` lacks `scoped_revision`;
- Redo this part on a pinned comment opens the dialog (no request until confirmed);
- Incorporate's switch appears only for all-pinned picks and sends the right beats;
- the history label.

**Logging:** every check logs a structured line, so a failed run's report shows exactly what moved:
`scope.splice { beats, lengthDelta }`, `scope.put_back { where, beat, what }`, `scope.problem { where, beat, what }`,
`scope.verified { beats, lengthDelta, newFiles, ms }`, `finalize.scope_violated`, `finalize.scope_duration_mismatch`.

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| Agents ignore the scope and loop on refusals, burning the deadline. | `check-contract --fix` puts things back itself and says what; problems are named with where to put things instead; B3 and the gate count rounds. |
| Scenes don't meet at the boundaries (a jump at the cut). | Stills of both neighbours; "your last frame is what the next scene cuts from"; reviewers look at boundary frames in the gate. |
| A scoped script reaches outside its beat (`parentElement`, `closest`, `globalThis` tricks). | The stricter scoped-beat regex; SSIM over frozen scenes in the gate is the only pixel check. Isolation is a heuristic, and the plan says so. |
| Global CSS or colour-role injection from inside the beat. | The `css-tree` AST check and the markup checks (§4.6). |
| The MP4 isn't the archive (a run that changes render-job). | Finalize guarantees the archive; the MP4 is bound by length and checked by SSIM in the gate; server-side render is §11. |
| `@scope` (prelude-less) behaves differently in headless Chrome. | B1 in the phase 1 fixture; fallback to the prelude form. |
| The splice disagrees with what the editor would do. | It uses the same core relayout and caption sync (`contract-core.ts`), not a copy. |
| A rounding frame moves into a frozen beat. | Snap scoped durations first; the frozen-duration assertion and its test. |
| Frozen beats render slightly differently anyway (offsets, GOPs). | The SSIM threshold from B2, not bit equality. The composition is identical, which is the actual guarantee. |
| Finalize gets slower (two archives). | Both are usually under 1 MB and capped by `SOURCE_READ_LIMITS`; finalize is a background function. Measured in the gate. |
| Stills fan out (5 × 20 seeks in draft 1) and the parent MP4 download is big. | 2 per beat, de-duplicated, ≤ 40 in total; no stills over 300 MB. |
| Retries repeat a scope refusal. | The previous refusal goes into the retry prompt; the UI offers **Revise the whole video** next to **Retry** after a scope refusal (§4.12). |
| Unauthorized Blobs work through the lazy beats fill. | A visibility check before `ensureBundle`, and only for ready versions. |
| A "scoped" request is really a whole-video change ("make everything blue"). | The dialog explains it; frozen parts can't change; the agent says so in its summary; people revise the whole video instead. |
| Redo from a comment spends credits by surprise. | It always opens the dialog with the cost line; never a direct POST. |
| Cost doesn't drop much (most of it is reading the skill and context). | Measure first; the optional cheaper model; reading guidance in the scoped prompt. If the gate shows less than 25% saved, the feature still pays for itself on drift, and the plan says so. |

## 10. Live gate: `scripts/e2e/regen-beat.ts`

A live test: it makes real videos on the production site and checks them, so it costs credits. Run it with `--dry`
first: it checks the env, prints each step and the projected credits, and makes no requests. Then **ask the owner
before each run** (part 1 and part 2 are separate asks), quoting the dry run's projected credits and the
`CREDIT_CEILING`.

```sh
VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… SOURCE_ID=vid_… [VOICED_ID=vid_…] [NARRATED_ID=vid_…] \
  [BASELINE=1] [CREDIT_CEILING=700] npx tsx scripts/e2e/regen-beat.ts [--keep] [--dry]
```

`SOURCE_ID` is a contract v1 video with at least 3 beats and music. Each step logs a JSON line (`step`, `videoId`,
`version`, `credits`, `ms`, results).

1. **Scoped, same length.** Redo the middle beat: "Make the headline say 'Ship on Friday' and slide it in from the
   left." Check:
   - the version is ready and `scope` is recorded;
   - the beat ids and order are unchanged;
   - the scoped beat's captions contain the phrase;
   - other scenes' captions equal the parent's (shifted by 0);
   - out-of-scope frames (every 0.5 s, at matched beat-relative times) have SSIM ≥ the B2 threshold against the
     parent MP4;
   - music is present.
2. **Bad requests** (no credits):
   - an unknown beat id → 400 with the list;
   - every beat → 400;
   - `scope` without `fromVersion` → 400;
   - `planId` with scope → 400;
   - `look` with scope → 400 `look_not_allowed`;
   - a non-editable version, if one exists → 409.
3. **Baseline** (`BASELINE=1`, optional): the same request as a whole-video revision of the same parent. Record
   credits, time and the out-of-scope SSIM, to show how much a full revision drifts.
4. **Scoped, longer.** "Make this scene twice as long so people can read the list." Check:
   - later beats moved by the delta and keep their durations;
   - captions shifted;
   - the root is longer by the delta;
   - the MP4 length matches.
5. **Voiced** (`VOICED_ID`): change a scoped scene's line in words. Check that only that beat's WAV and voice cues
   changed and the other voice cues are identical.
6. **Narrated** (`NARRATED_ID`): redo a middle scene. Check the length is unchanged and the narration bus hash equals
   the parent's.

The script stops starting runs once `CREDIT_CEILING` (default 700) is reached, and deletes what it made unless
`--keep`. It prints a table of credits, wall time, check rounds and drift for scoped runs against the baseline.

**Pass:**
- steps 1, 2 and 4 (and 5 and 6 when given) pass every check;
- **scoped median credits ≤ 60% of a full revision's.** The full revision is step 3 when `BASELINE=1`. Otherwise it's
  the parent version's own run credits (`usage.totalCreditsCost` on the version DTO), which is less exact but free;
  the table says which was used;
- wall time is reported.

If the savings miss the bar but drift is zero, ship anyway and record the numbers (the guarantee is the main point),
then revisit the model default.

`--selftest` runs the frame and caption analysis on two local fixture MP4s, like `scripts/e2e/narration.ts
--selftest`.

## 11. Not in v1

**After the gate (designed, ready to build):**

- **Editor beat card:** a **Redo this scene…** icon next to move and delete (`ui/src/pages/Edit.tsx:1047`). It opens
  the scoped dialog with that scene picked. If the draft has unrendered changes: "This starts from v3 as rendered;
  your draft's changes aren't included. Render your draft first, or redo from v3."
- **Editor timeline:** the same action in each beat block's menu (`ui/src/components/timeline/Timeline.tsx:476`).
- **Hover-to-seek on scene chips** in the revise panel.
- **Version switcher jump:** a scoped version's switcher entry seeks to the changed scene.
- **A separate model for scoped runs.** `SCOPED_AGENT_MODEL` and `SCOPED_AGENT_EFFORT` (unset = the deployment's).
  `newAttempt(deps, jobId, n, now, { scoped })` picks them in both callers that serve a scoped version, revise
  (`src/domain/videos.ts:474`) and retry (`:565`), so a retry doesn't fall back to the default model. The other
  callers (create, edits, remix) pass nothing, and the attempt records what it used, as now. Measured first: a gate
  step (`CHEAP_MODEL=1`) runs step 1's request with the cheaper model (Sonnet 5.5) and records credits, time and check
  rounds. The result is README advice, not a pass condition.
- **`scripts/backfill-beats.ts`**, like `scripts/backfill-previews.ts`: fills `versions.beats` for ready contract
  versions in batches. v1 fills lazily instead (§4.2).

**Later (own design needed):**

- **Variations** ("make three takes of this scene and let me pick"). It doesn't fit cheaply: versions are one at a
  time, and three runs cost three times as much. A cheap design: one run authors N alternatives of the beat as hidden
  sibling sections and renders a short audition clip of just them (or stills); the person's pick is applied with a
  render-unchanged splice (about 34 credits). It needs an "audition" output kind and a picker, so it's worth a plan of
  its own once scoped runs are measured.
- **Adding, splitting, merging or removing scenes through the agent** ("add a scene after this one"). The editor can
  already delete and reorder; insertion needs new-id rules and comment and caption mapping.
- **Redo from an unrendered editor draft:** needs a scoped `author_from_frozen`. v1 starts from the rendered version.
- **Rendering only the changed frames** and splicing them into the parent MP4. It would cut render time on long
  videos, but audio continuity, GOP boundaries and the poster and GIF make it a project of its own.
- **Server-side render** (or a server-side frame check) of the archive, binding the MP4 to the composition for every
  run kind.
- **Scoped remix**, and scope over layers ("change the music only in this scene").
- **Non-contract videos**, and **Remotion videos** (render-engines phase 3 adds its `scopeCheck`).
- **Redoing the last scene before a held last frame** with recorded narration (needs the hold capture in the scoped
  run).
- **New fonts in a scoped scene** (needs a controlled `@font-face` path).

## 12. Open questions for the owner

1. **Length:** may redoing a scene change its length, moving later scenes? Recommended: yes, except with recorded
   narration.
2. **Cheaper model for scoped runs:** leave the knob out of v1 and add `SCOPED_AGENT_MODEL`/`SCOPED_AGENT_EFFORT` only
   if a measured comparison after the gate shows a win? Recommended: yes.
3. **Who can redo scenes:** anyone who can revise, as today (recommended), or only owners and admins?
4. **How many scenes at once:** up to 20, never all of them? Recommended: yes.
5. **Scoped Incorporate feedback default:** shown when every picked comment is pinned; starts on when the pins fall
   in fewer than half the scenes, off otherwise? Recommended: yes.
6. **Variations:** later, as their own plan? Recommended: yes.
7. **Held last frame:** refuse the last real scene of a narrated video that holds its frame in v1 (recommended), or
   build the hold capture into scoped runs now?
8. **Finalize sets `contract` atomically with ready** (and `beats`), so `editable` never lags? This is a small change
   for every version. It must use `ensureBundle`'s inputs (`contractOf` plus `missingLocalFiles` with references and
   library media), not `index.html` alone. Recommended: yes, with those inputs.
9. **Editor entry points** (beat card, timeline menu): after the gate (recommended), or in v1?
10. **New fonts in a scoped scene:** not allowed in v1? Recommended: yes; the brand's fonts are already loaded.

## Sources

- CSS `@scope` reference (including scoping to the owner `<style>`'s parent without a prelude):
  https://developer.mozilla.org/en-US/docs/Web/CSS/@scope
- MDN browser-compat-data for `@scope` (Chrome `version_added: "118"`):
  https://chromium.googlesource.com/external/github.com/mdn/browser-compat-data/+/HEAD/css/at-rules/scope.json
- Chrome 118 release notes (`@scope` shipped): https://developer.chrome.com/blog/new-in-chrome-118
- ffmpeg `ssim` filter: https://ffmpeg.org/ffmpeg-filters.html#ssim
- css-tree: https://github.com/csstree/csstree

## 13. Review log

### Review log (draft 1 → 2)

Two reviews of draft 1 on 2026-11-04: an independent Fable 5.1 review ("sound with changes"), and the cross-plan seam
review of the six 2026-11-04 plans (the orchestrator's chosen resolutions). Every code claim was checked before it
was used.

**Independent review**

| Item | Decision | Why |
| --- | --- | --- |
| A1.1 Validate the parent only; splice before validating | Adopted | `validate` checks derived values (`contract.ts:395-450`), so validating the agent's file first gives misleading errors in the normal case. |
| A1.2 Semantic compare, not a parse5 round trip | Adopted | `load`/`save` keep whitespace, attribute order and script text (`contract.ts:231-243`). |
| A1.3 Snap scoped durations before relayout; assert frozen durations | Adopted | `relayout` snaps cumulative ends (`:1026-1058`); confirmed it leaks rounding into the next beat. |
| A1.4 `--fix` reverts and reports; render-job and finalize refuse | Adopted | Resolves draft 1's open question 3; the agent sees what it touched and the guarantee stays strict. |
| A1.5 The scope check is a separate `if` in render-job | Adopted | Confirmed the ladder (`render-job.ts:104-176`) would otherwise skip it for narrated parents. |
| A1 new tests (3.85 s beat, prettier file, stale derived values) | Adopted | In §8. |
| A2 Finalize guarantees the archive, not the MP4; order; parent read; MP4 length binding; hold still not excluded | Adopted | Confirmed finalize never derives the MP4 (`finalize.ts:131-236`) and `keptHash` excludes the hold still only because of the narration step. |
| A3 Style holes; `css-tree`; prelude-less `@scope`; refuse `data-composition-src` | Adopted | Confirmed `readColors` reads every `<style>` (`:249-256`) and `css-tree` 3.2.1 is installed. The prelude-less form is in the CSS spec and MDN. |
| A3 Fold the `@scope` check into phase 1 | Adopted | Now B1, part of the phase 1 fixture. |
| A4 Stronger script escape check | Adopted with changes | Applied to scoped beats only. `validate` runs on every run and on existing versions' bundles, so tightening it for all beats would make working videos non-editable. Isolation is stated as heuristic, with SSIM the pixel check. |
| A5 Names `regenerate_beat`/`regenerateBeat`/`regen --beat` | Rejected | The cross-plan rules chose `scoped_revision`, `videos.redoScenes`, `scenes`, `revise --scene` and `redo --scene`. |
| A5 `fromVersion` required; refuse `look`; `features` gating; `unsupported_by_server` | Adopted | Beat ids belong to one version; the seam review also asks for `look_not_allowed`. |
| A6 No archive I/O in the transaction; beats from finalize's one `readTarGz` with ready; `contract` likewise | Adopted (contract as open question 8) | Confirmed `reviseVideo` runs inside `store.tx` and `ensureBundle` reads Blobs. Setting `contract` atomically changes behaviour for every version, so it's the owner's call. |
| A6 Drop the backfill script from v1 | Adopted | Moved to §11 with its design; lazy fill in v1. |
| A7 Reuse `feedback.video` with empty pins; 3 stills per beat, de-duplicated, ≤ 60; "last frame" prompt line | Adopted | Confirmed the parser allows empty pins and prepare-run fetches the MP4 whenever `feedback` is set. |
| A8 Voice: no `voice.json`; edit only your line; order-insensitive cues; derive `beatStart`/`beatEnd` | Adopted | Confirmed `syncVoice` re-sorts and replaces voiced beats' cues (`voice.ts:145-171`). |
| A9 No literal template number | Adopted | Cross-plan rule 4. |
| A9 `newAttempt` callers (revise and retry) | Adopted | Confirmed `:474` and `:565`; also noted the edits and remix callers, which pass nothing. |
| A9 `--fix` with `--duck` alias; `not_editable` in OpenAPI; "Retry" wording; held-frame wording | Adopted | `Video.tsx:682` says Retry. |
| A9 Citation fixes | Adopted with corrections | `applyOne` is `:1100` (reorder `:1121`, delete `:1132`) and `sanitizeBrief` is `prompt.ts:106`; the review's `:1100-1128` and `:103-105` were close but off. The review's `snapshotFeedback :485` and `reviseVideo :397-479` are wrong: `:485` is `reviseVideo`'s closing line and `snapshotFeedback` starts at `:491`. The trust-model citation now points at the Git checkout (README:33) rather than claiming the README says runs edit scripts. |
| Missed risks (MP4 binding, CSS, script escape, stills fan-out, comment POST, `SOURCE_READ_LIMITS`, labels in a fence) | Adopted | In §9, §4.6, §4.8, §4.9 and §4.11. |
| Over-built: backfill, editor icon, timeline menu, version jump, hover-to-seek | Adopted | Moved to §11 "After the gate" with their designs. |
| Over-built: the pass criterion depending on a second model; the mandatory baseline | Adopted with changes | The cheaper model is advice only. The baseline is `BASELINE=1`; without it the comparison uses the parent version's own run credits, so the 60% criterion still has a reference. |

**Cross-plan seam review (regenerate-beat section and shared rules)**

| Item | Decision | Why |
| --- | --- | --- |
| 1 SDK `revise` + `redoScenes`; no `videos.beats`; CLI `scenes`, `revise --scene`, `redo --scene`; idempotency key | Adopted | §4.13. |
| 2 Frame math from `contract-core.ts` | Adopted | §4.5, phase 1.1. |
| 3 Engine gate on `scopedRevision`, `409 not_editable`; HyperFrames-only guard | Adopted | §4.1, §4.3. |
| 4 `look_not_allowed` | Adopted | §4.1. |
| 5 Extensible derived set; recording `plan.json`; `recording.ts check` in `--fix` | Adopted | `DERIVED_FILES`, §4.4, §4.9. |
| 6 No "v17" | Adopted | §4.8. |
| 7 Spike labels B1–B3 | Adopted | §7. |
| 8 "Redo a scene" in MCP and skill | Adopted | §4.13. |
| 9 GitHub Action `/video redo` uses `scope.beats` | Adopted | §4.13. |
| Shared rules 1, 4, 5, 10, 15, 16 (feature string, template rule, manifest v1, additive DTO, terminology, package names) | Adopted | Throughout. Package names later became the unscoped `netlify-video-agent-*` (owner decisions, below). |
| Build order (phase 1 on engines 1; phase 2 on cli 1; phase 4 on cli 3; migration and template after looks 2) | Adopted | Status block and §7. |

### Review log (draft 2 → 3): remote Fable 5.1 review (high effort, Netlify Agent Run at `19740d8`)

The verdict was "sound with changes". Every claim was checked against the code at this commit.

| Item | Decision | Why |
| --- | --- | --- |
| R1 Scope-aware relayout: frozen durations verbatim, scoped snapped; shift frozen cues without re-rounding | Adopted | Confirmed: `validate` allows starts within half a frame (`contract.ts:424`), and authored compositions are never relaid. One correction: `relayout` has five callers (`:901`, `:984`, `:998`, `:1093`, `:1268`), not only `applyEdits`, but all are editor, narration or re-voice paths, so the point holds. `syncCaptions` snaps cues (`:1072-1073`). |
| R2 Scope stills after `feedbackStills` (one call) | Adopted | Confirmed the `rmSync` (`prepare-run.ts:65`) and that it runs last (`:452-460`). The engines plan's order should say "feedback and scope stills, last". |
| R3 `GET …/versions/{n}/beats` for older versions | Adopted | Confirmed no read route returns beats; `POST …/edits` (`app.ts:1156`) opens a draft. |
| R4 Finalize requires bytes, and §0 says so | Adopted | Confirmed finalize stores the upload as is (`finalize.ts:217`). render-job writes the splice's bytes and a splice of a splice is a fixed point, so byte equality is stricter and still passes honest runs. |
| R5 GSAP string targets and more escape words | Adopted with changes | GSAP string targets resolve against the document (`va-contract.js` hands a plain timeline). Added `window`, `eval`, `Function(`. Rejected `\btop\b`, `\bparent\b` and `\bframes\b`: `top` is a CSS property GSAP animates (`{ top: 10 }`), and the other two are common in names, so they'd refuse honest scripts. |
| R6 At-rule allow-list; stricter `url()` | Adopted | Confirmed Chrome 156 (`puppeteer-core/lib/puppeteer/revisions.js:10`). An allow-list doesn't age. |
| R7 Drop `scope.layout` from the manifest | Adopted | prepare-run reads it from the restored parent; one source. |
| R8 Visibility check before the pre-transaction `ensureBundle` | Adopted | Confirmed `ensureBundle` writes Blobs (`bundles.ts:150-166`). |
| Claims: `scopeCheck` returns problems only | Adopted | Confirmed `render-engines.md:423`. This plan calls `spliceScoped` directly until the engines doc returns the splice files; recommended to the orchestrator. |
| Claims: recording derived files include `<step>.cursor.js` | Adopted | Confirmed `screen-recording-demo.md:691-693`; the row now defers to that plan's `DERIVED_FILES`. |
| Seam (screen-recording draft 3): add `<step>.hold.jpg` for scoped recording steps | Adopted | Added next to `plan.json` and `<step>.cursor.js` in §4.4 and the `DERIVED_FILES` comment, at that plan's request. |
| Claims: `runCreditsOf` lines; 60 MB file cap; `readTarGz` default | Adopted with corrections | `runCreditsOf` is defined at `finalize.ts:447` and called at `:236` (the review said `:238`). The default parameter is `BUNDLE_LIMITS` (`tar.ts:48`), now cited. |
| Missed: retries repeat the refusal | Adopted with changes | UI offers Revise the whole video next to Retry. The previous refusal goes into the retry prompt as fenced data derived from the version's own attempts, so the same state still gives the same prompt. |
| Missed: the parent MP4 download (up to 2 GB) | Adopted | No stills above 300 MB (`outputs.bytes`), with a prompt line; noted in §4.10. |
| Missed: `url()` schemes | Adopted | §4.6. |
| Over-built: `SCOPED_AGENT_*` and `newAttempt` plumbing | Adopted | Moved to §11 "After the gate" with its full design and the gate step that measures it; open question 2 updated. |
| Over-built: `scope.layout` | Adopted | R7. |
| Over-built: three stills per beat | Adopted | Two (before, after), ≤ 40; the scene being replaced is already in the HTML. |
| Over-built: `credits.json` append-only check | Rejected | `runCreditsOf` keeps only valid entries but can't restore one a run deleted. A frozen music track fetched in an earlier run would lose its CC BY credit, which is an attribution failure, so append-only stays. |
| Over-built: make gate step 4 (longer scene) optional | Rejected | Changing length is the riskiest path (R1's relayout, caption shift, MP4 binding), and open question 1 depends on it, so it stays in the pass bar. |
| Seams: `scopeCheck` signature; prepare-run order note; `contract-core.ts` contents | Adopted | §4.3, §4.5; the first two are recommendations to the orchestrator. |
| Owner questions Q8 (same inputs as `ensureBundle`), Q2 (defer), Q5 (fewer than half the scenes) | Adopted | Confirmed `bundles.ts:170-188`. Q1 and Q9 unchanged (agreed). |

### Owner decisions 2026-11-04

| Decision | Effect here |
| --- | --- |
| Packages are unscoped: `netlify-video-agent` (CLI, bin `video-agent`) and `netlify-video-agent-sdk`. | §4.13 uses them. The draft 1 → 2 log's mention of `@netlify-labs/*` is history. |
| Local mode ships ("make one locally, then deploy it for your team"). | §4.13 wording. |
| Live tests run `--dry` first, then ask the owner before each gate, with a credit ceiling. | §0 (definition), §7, §10. |
| Default look, Action install, Remotion POC. | Don't touch this plan: scoped revisions refuse `look`, and Remotion has no `scopedRevision` in v1. None of this plan's owner questions were answered by them; all stay open. |
