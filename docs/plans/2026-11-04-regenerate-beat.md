# Redo a scene: regenerate one beat as a scoped revision — plan

- **Status:** draft 2 (2026-11-04). Not started. No beads yet. Written from the idea-wizard list (idea #10) after the
  owner picked it ("faster/cheaper regens sound cool"). Draft 1 was reviewed by an independent Fable 5.1 review
  ("sound with changes") and by the cross-plan seam review of the six 2026-11-04 plans. Each claim was checked against
  the code before it was folded in; §13 is the review log.
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
composition:** the other scenes' HTML and files are the parent's. The MP4 is trusted like every run's, bound to the
composition by its length, and the live gate checks frozen scenes' frames by SSIM (§4.9).

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
| prepare-run fetches `feedback.video` and makes one still per pin (`feedbackStills`). It keeps a copy of the restored parent in `.render/frozen` only when the parent is narrated. | `scripts/prepare-run.ts:60-99`, `:375-395`, `:453-459` |
| render-job validates the contract and refuses leftover `data-va-revoice` marks. It then runs **one** guard from an `else if` ladder (render-unchanged with narration, fit, narrated revision, re-voice, plain render-unchanged). The narrated-revision branch catches every revision of a narrated parent. | `scripts/render-job.ts:86-176` |
| The re-voice guard is the pattern to copy. It hashes every file except the ones the step may write (`keptHash`, which excludes the held still because the narration step rewrites it). It compares `voice.json` entry by entry (same provider, voice and speed; only marked beats change). It then recomputes `index.html`/`summary.json` from the frozen copies with `applyRevoice`. | `src/lib/revoice.ts:33-169` |
| `applyEdits` re-lays the beats with `relayout`. That puts them back to back, snapping each **cumulative** end to whole frames, so a beat that isn't frame-aligned pushes its rounding into the next beat. It also sets the root, layer and video-slot durations, trims speech and rewrites ducking. `syncCaptions` recomputes absolute caption times; text cues stretch by `duration / authoredDuration`, voice cues don't. Both functions are private. | `src/lib/contract.ts:1026-1085` |
| `load`/`save` are a parse5 round trip. Whitespace text nodes, attribute order and script/style text survive it, so a re-indented file serializes differently. | `src/lib/contract.ts:231-243` |
| `validate` checks authored rules and derived values alike. Authored rules: beat ids, `data-composition-id`, track 0, the `vaBeat` script, unique text ids, voice placement. Derived values: back-to-back starts, beat sum = root, layers span the total, the ducking lane. Its script isolation check is a regex: `/\bdocument\s*\.|window\.__timelines/`. | `src/lib/contract.ts:395-520`, `:436` |
| `readColors` reads `--va-color-*` from **every** `<style>` in the document, and the editor's colour op rewrites each one. | `src/lib/contract.ts:249-256`, `:1143-1151` |
| Finalize checks every upload's hash and the MP4 (H.264, size, duration). It only **notes** a length far from the target; it doesn't reject it. It never derives the MP4 from the archive, for any run kind. It reads the uploaded `source.tar.gz` once for run credits (`runCreditsOf`, `SOURCE_READ_LIMITS`: 5,000 entries, 160 MB), and after a version is ready it builds the bundle and sets `versions.contract`. | `src/domain/finalize.ts:131-236`, `:277-287`, `:435-460` |
| `editable` in the API is `status === 'ready' && contract === 1`. | `src/domain/videos.ts:898` |
| The server can read any ready version's composition: `ensureBundle` unpacks its source archive (Blobs I/O) and records contract violations. | `src/domain/bundles.ts:136-195` |
| `readTarGz`'s default limits are 2,000 entries, 50 MB total and 10 MB per file. | `src/lib/tar.ts:12-16` |
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
   durations, caption times, speech spans and the ducking lane all shift. These are derived: compute them, never
   compare them. And `relayout` snaps cumulative ends, so a non-frame-aligned scoped beat would leak a rounding frame
   into the next frozen beat unless it's snapped first.
5. **Shared CSS lives outside beats.** `<head>` and root-level `<style>` hold fonts, classes and `--va-color-*`.
   Inside a beat there are several ways to leak styles out: a `<link rel=stylesheet>`, a second `<style>` (also inside
   `<svg>`), a `--va-color-*` declaration (`readColors` would make it an editor colour role), or a
   `data-composition-src` sub-composition.
6. **Script isolation is a heuristic.** The `vaBeat` check is a regex, and `el.parentElement`, `el.ownerDocument`,
   `el.closest(…)` or `getRootNode()` escape it. Only frames can prove the other scenes look the same.
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
that's null (a version from before this plan), it calls `ensureBundle` **before** opening the transaction, computes
the beats, stores them on the parent with a separate update, then proceeds. Nothing is unpacked while the job row is
locked.

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
- **`contract` could be set the same way.** It could be computed from the same map and set atomically with ready,
  instead of after it (`:277-287`, where `editable` briefly lags). That's a small behaviour change for every version,
  so it's open question 8; recommended yes.
- **`VersionDto`** gains `beats: { id, label, start, duration }[] | null` and `scope: { beats: { id, label }[] } |
  null`. The labels come from the parent's beats, so history can say "Redid Features". These are additive
  (cross-plan rule 10). `editable` stays as it is.
- **Older versions:** their beats fill lazily, when someone opens a scoped revise (§4.1) or the scene picker asks.
  The editor already reads the bundle, so it never needs `beats`. A one-off backfill script is in §11.
- **Why store it rather than compute it per request:** the video DTO is on every list and poll path, and unpacking an
  archive there is too slow.

### 4.3 The run: still a `revision`, with a scope

The reconciler builds a revision manifest as today (`src/domain/reconciler.ts:268-330`) and adds:

```ts
scope?: {
  beats: string[]
  /** The parent's beats as the agent sees them, for the prompt and the stills. */
  layout: { id: string; label: string | null; start: number; duration: number }[]
  /** Stills from the parent MP4 so the agent can match the neighbours, relative to video/. */
  stills: { atSec: number; path: string; what: 'before' | 'middle' | 'after'; beat: string }[]
}
```

- **The parent MP4 comes from the existing `feedback.video`** (`src/lib/run-manifest.ts:56-62`). It's set for scoped
  revisions even when there are no pinned comments, with `pins: []`, which the parser already accepts. No duplicate
  `scope.video`.
- **Manifest version stays 1** (cross-plan rule 5). `verifyRunManifest` gains a shape check for `scope`:
  - ids as above, at most 20 beats;
  - `layout` covering every parent beat;
  - at most 60 stills, each with a `path` under `feedback/scope/`;
  - `scope` requires `kind === 'revision'` and a `feedback.video`.
- **prepare-run step order** is the one render-engines §4.3 owns: restore and hydrate, then library media, then look,
  then recording and **scope files**. For a scoped manifest, prepare-run:
  - always copies the restored parent composition into `.render/frozen/` (today it does so only for narrated parents);
  - writes `.render/frozen/scope.json`;
  - makes the stills with the same ffmpeg path as feedback pins. Each scoped beat gets three: **before** (the last
    frame of the previous beat, if any), **middle**, and **after** (the first frame of the next beat, if any).
    Adjacent scoped beats share stills, which are de-duplicated. Files go to `video/feedback/scope/<beat>-<what>.jpg`;
    `feedback/` is never archived.
- **Kind:** reuse `revision`, as remix did. A new kind would touch every switch over `RunKind` for no behaviour the
  `scope` field doesn't already select. render-job and check-contract look for `scope` in the manifest.
- **HyperFrames only in v1** (cross-plan item 3). The splice and checks are this engine's. render-engines adds an
  optional `scopeCheck?(parent, agent, beats)` to its `Engine`/`RunEngine` interface; this plan's module implements it
  for HyperFrames, and Remotion has none until the engines plan's phase 3.5.

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
| Other beats | Frozen: semantically equal to the parent's, ignoring derived attributes (§4.5). After the relayout, each must keep the parent's exact `data-duration`; that's tested, not exempted. |
| `<head>`, the root's attributes (except `data-duration`), root-level `<style>` and `<script>` | Frozen. |
| Layers (music, background, logo bug, narration) | Frozen, except `data-duration` (the new total) and the music's ducking lane (`data-automation`, recomputed). The narration element is never touched, and the existing lock check also runs. |
| Existing files in `video/` | Byte-identical and still present, except the derived files below. |
| New files | Allowed anywhere under `assets/` (the prompt asks for `assets/beats/<X>/`). Every frozen part of the HTML is frozen, so only scoped beats can refer to them. |
| `summary.json` | Scoped beats' captions are the agent's. Every other cue is recomputed from the parent's (shifted). `title` and `summary` are the agent's; `credits` is the union of the parent's and the agent's. |
| `assets/voice/script.json`, `voice.json`, `assets/voice/X.wav` | Only scoped beats' entries may change, with the same provider, voice and speed (the re-voice guard's rules). A scoped beat in a voiced video may gain a line; it may not remove another beat's. |
| `assets/music/credits.json` | Append-only: a fetched sound effect adds its credit, and existing entries stay. |
| Recorded narration (`assets/narration/bus.wav`, the `va-narration` element, its captions) | Untouched; `checkNarrationKept` runs as for any narrated revision. |
| Screen-recording beats (screen-recording plan) | `assets/recording/plan.json` is a derived file when a scoped beat is a recording beat. That plan's `recording.ts check` (the redaction guard) runs inside `check-contract --fix` when the composition has recording beats. |

Why let the length change: "make this scene twice as long so people can read it" is a common ask, and the editor
already lets people retime beats with the same consequences. Why one-in-one-out: comments, captions, edit drafts and
the editor all key on beat ids, and inserting or splitting beats changes the shape of the video. That needs its own
design (§11).

### 4.5 The splice and the check (`src/lib/scope.ts`)

One module, shared by `check-contract.ts`, render-job and finalize, in the same style as `src/lib/revoice.ts`. The
frame math (relayout, caption sync) comes from `src/lib/contract-core.ts` (cross-plan rule 6). It's imported, not
re-exported from `contract.ts`; if this plan lands before render-engines phase 1, it creates that module under that
name and moves `relayout`/`syncCaptions` into it.

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
/** The derived set for a scope; other features append to it (screen recordings add assets/recording/plan.json). */
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
5. **Relayout** with the core module. Then assert that every frozen beat's `data-duration` equals the parent's
   exactly; that's a test and a runtime assertion, not an exemption.
6. **Captions:**
   - Keep the agent's cues whose `beat` is scoped, deriving a missing `beatStart`/`beatEnd` as `start − beat.start`.
   - Keep the parent's other cues, including recorded-narration cues, which belong to no beat.
   - Run caption sync so later cues shift.
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

A file that is only re-indented has no problems. **The render always uses the splice's bytes**, never the agent's.

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
- no `@import`, `@font-face`, `@namespace` or `@layer` statements, and no `:root`, `html` or `body` in selectors;
- `url()` only to paths under `assets/`;
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
`parentNode|parentElement|ownerDocument|getRootNode|closest\(|previousElementSibling|nextElementSibling|globalThis|self\.`
to the existing `document`/`__timelines` regex. It's applied to scoped beats rather than to every beat (as the review
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
  video/assets/beats/features/. Its script selects only inside its own element (el): never its parents or siblings.
- Keep its length unless the request asks for a change or the new content needs more or less time (0.5 to 120
  seconds); later scenes move with it.
- Match the neighbours: video/feedback/scope/ has stills of version 3: the last frame of the scene before, this
  scene's middle, and the first frame of the scene after. Your scene's last frame is what the next scene cuts from,
  and the next scene starts exactly as it does now.
- In summary.json, write cues only for the scoped scenes' text; the others are put back from version 3.
- After every change run: npx tsx scripts/check-contract.ts --fix. It re-lays the scenes, puts back everything outside
  the scope (other scenes' captions, the music's ducking, anything you changed there) and says what it put back. Keep
  going until it says OK. If you needed something outside the scope, say so in your summary.
```

- **With a voice:** "Edit only this scene's line in assets/voice/script.json, then run npx tsx scripts/voice.ts and
  npx tsx scripts/voice.ts sync."
- **With recorded narration:** "Keep each scoped scene exactly as long as it is now", plus the existing
  locked-narration lines.
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
   - **The checks:** run `spliceScoped`, `scopeProblems` and `scopeFileProblems` on both archives' `index.html`,
     `summary.json`, voice files and file hashes. The uploaded `index.html` must equal the splice semantically.
   - **The MP4 binding:** `|MP4 durationSec − splice root duration| ≤ 0.25 s`.
   - **A failure** fails the attempt as `invalid_output` with "This run changed parts of the video outside the scenes
     it was asked to redo: …". Why `invalid_output` and not a new category: the UI already explains it and offers
     **Retry**, and the message says the rest.

**What this guarantees and what it doesn't.** The saved composition (the archive future edits, revisions and remixes
start from) is guaranteed: outside the scope it's the parent's. Finalize doesn't derive the MP4 from the archive for
any run kind, so a run that changed render-job could render one thing and upload another. Like every run's MP4, it's
trusted, bound here by its length. The live gate checks frozen scenes' frames by SSIM. Rendering the archive on the
server would close this gap for every run kind; that's §11.

### 4.10 Model, effort and time

- Scoped runs read and write less, so they may suit a faster model or lower effort. Add optional `SCOPED_AGENT_MODEL`
  and `SCOPED_AGENT_EFFORT`; unset means the same as `AGENT_MODEL`/`AGENT_EFFORT`.
- **Both attempt callers that serve a scoped version pick them:** revise (`src/domain/videos.ts:474`) and retry
  (`:565`). Otherwise a retried scoped version would run on the wrong model. `newAttempt` gains an options argument
  (`{ scoped: boolean }`); the other callers (create, edits, remix) pass nothing. The attempt records what it used, as
  now.
- **Default: unset.** The pass criterion (§10) compares scoped against full runs on the default model. Gate step 6
  optionally tries a cheaper model (Sonnet 5.5) so the README can suggest one; that's advice, not a pass condition.
- **Expectation to test, not a promise:** 40–100 credits and 2–4 minutes for a 20–60 s video, against 90–250 credits
  for authoring and about 120 for a revision-kind run (§1). The render is still the whole video; rendering only the
  changed frames is §11.
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
  three notes on two scenes, and the owner fixes exactly those two.
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
- Other people are editing `Edit.tsx`, `Video.tsx` and `ui/src/api/*` right now; this plan only names where things go.

Editor entry points (beat card, timeline menu), hover-to-seek on chips and the version switcher's jump wait until the
live gate passes; their designs are in §11.

### 4.13 MCP, skill, SDK and CLI

- **MCP `get_video`** returns each version's `beats` (id, label, start, duration) so agents can pick.
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
- **SDK** (`@netlify-labs/video-agent-sdk`, cli-and-sdk plan):
  - `client.videos.revise(id, { prompt, fromVersion, scope: { beats } })` from the OpenAPI types;
  - the hand-written sugar `client.videos.redoScenes(id, { beats, prompt, fromVersion?, …opts })`, which fills
    `fromVersion` from the latest ready version when it's omitted and sends an idempotency key;
  - no separate beats call, since the version DTO carries `beats`;
  - before sending a scope, it checks `features` for `scoped_revision` and throws `unsupported_by_server` when it's
    missing.

  This plan adds the resource-method rows in its own PR, and the coverage test enforces that.
- **CLI** (`@netlify-labs/video-agent-cli`, bin `video-agent`):
  - `video-agent scenes <video> [--version n]` lists scenes.
  - `video-agent revise <video> --scene <id|label> … "<change>"`: repeatable; accepts an id or a unique label,
    case-insensitive.
  - `video-agent redo <video> --scene <id|label> … "<change>"`: the short form, hidden until the server lists
    `scoped_revision`.
  - Both send an idempotency key (and take `--idempotency-key`) and `--version`; `--wait` follows the run like other
    commands.
  - `not_editable` (409) maps to exit code 7, by the CLI plan's rule.
- **Local mode** (`video-agent local …`): the splice and checks live in `src/lib/scope.ts` and the scripts, so a local
  project can do a scoped revision the same way. That's also how the check gets exercised without credits.
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
| `newAttempt` | Options argument `{ scoped }` (revise and retry). |
| Config | `SCOPED_AGENT_MODEL`, `SCOPED_AGENT_EFFORT` (optional), in the README's configuration table. |
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

Each phase ends with a gate. Live gates spend credits and run `--dry` first.

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

1. `contract-core.ts`: import `relayout` and caption sync from it, or create it with them if this plan lands first.
   No behaviour change; the editor's tests keep passing.
2. `src/lib/scope.ts`: `spliceScoped`, `scopeProblems` (the semantic compare), `scopeFileProblems`, `DERIVED_FILES`,
   the `css-tree` style check and the scoped script check. All problems in plain words.
3. Register the HyperFrames `scopeCheck` on the engine (render-engines interface).
4. `RunManifest.scope` and its checks; `feedback` with empty pins.
5. prepare-run: the frozen copy, `scope.json`, and the stills (3 per beat, de-duplicated, ≤ 60).
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
   yes); the server-side scope check with the parent archive and the MP4 length binding.
3. `reviseVideo`: the scope rules and errors, the engine capability gate, `fromVersion` required, `look_not_allowed`,
   and the lazy beats fill outside the transaction.
4. Reconciler: `scope` in the manifest with layout and stills, and `feedback.video` set; the `buildPrompt` scope
   section; the template constant +1; `SCOPED_AGENT_*` via `newAttempt` in revise and retry.
5. REST schema and DTO, `openapi:gen`; `scoped_revision` in `features`; MCP `revise_video` and `get_video`; the
   catalog row and skill recipe ("Redo a scene").

**Gate:** integration tests green; **live gate part 1** (§10 steps 1–2) on production.

### Phase 3: the UI

1. The revise panel's scene picker.
2. Redo this part on a comment; Incorporate feedback's scoped switch.
3. The history label.

**Gate:** Playwright (§8); a person redoes a scene from each entry point on production.

### Phase 4: SDK, CLI, docs and measurement. Needs cli-and-sdk phases 2–3.

1. SDK rows (`scope` on `revise`, `redoScenes`) and CLI commands (`scenes`, `revise --scene`, `redo`).
2. README: "Redo a scene". The API docs follow from OpenAPI, and the CLI page is the CLI plan's.
3. **Live gate part 2** (§10 steps 3–7). Write the numbers into `docs/spikes.md` and this plan's "As built".
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
- **Scripts:** `el.parentElement`, `el.closest('#root')`, `el.ownerDocument` in a scoped beat → reported. The same
  code in a frozen beat → not reported (existing videos stay editable).
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
- Reconciler: the manifest has scope, layout, de-duplicated stills and `feedback.video` with empty pins.
  `SCOPED_AGENT_*` is used on revise **and on retry**.
- Finalize:
  - A scoped upload that matches → ready, with `beats` set in the same transaction.
  - One that changed another scene → failed `invalid_output` with the message, and **no blobs written**.
  - The parent archive missing → `source_unavailable`.
  - An MP4 0.5 s off the splice's length → `invalid_output`.
  - The parent archive over the default 50 MB but under `SOURCE_READ_LIMITS` → read fine.
- prepare-run: the frozen copy and the stills, using ffmpeg on a fixture MP4 as the feedback-still tests do.
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
| Stills fan out (5 × 20 seeks in draft 1). | 3 per beat, de-duplicated, ≤ 60 in total. |
| A "scoped" request is really a whole-video change ("make everything blue"). | The dialog explains it; frozen parts can't change; the agent says so in its summary; people revise the whole video instead. |
| Redo from a comment spends credits by surprise. | It always opens the dialog with the cost line; never a direct POST. |
| Cost doesn't drop much (most of it is reading the skill and context). | Measure first; the optional cheaper model; reading guidance in the scoped prompt. If the gate shows less than 25% saved, the feature still pays for itself on drift, and the plan says so. |

## 10. Live gate: `scripts/e2e/regen-beat.ts`

Run with `--dry` first: it checks the env, prints each step and the projected credits, and makes no requests.

```sh
VIDEO_AGENT_URL=https://<site> VIDEO_AGENT_KEY=nva_… SOURCE_ID=vid_… [VOICED_ID=vid_…] [NARRATED_ID=vid_…] \
  [BASELINE=1] [CHEAP_MODEL=1] [CREDIT_CEILING=700] npx tsx scripts/e2e/regen-beat.ts [--keep] [--dry]
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
6. **Cheaper model** (`CHEAP_MODEL=1`, needs `SCOPED_AGENT_MODEL` set on the site): step 1's request again. Record
   credits, time and check rounds. This is advice for the README, not a pass condition.
7. **Narrated** (`NARRATED_ID`): redo a middle scene. Check the length is unchanged and the narration bus hash equals
   the parent's.

The script stops starting runs once `CREDIT_CEILING` (default 700) is reached, and deletes what it made unless
`--keep`. It prints a table of credits, wall time, check rounds and drift for scoped runs against the baseline.

**Pass:**
- steps 1, 2 and 4 (and 5 and 7 when given) pass every check;
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
- **Non-contract videos**, and **Remotion videos** (render-engines phase 3.5 adds its `scopeCheck`).
- **Redoing the last scene before a held last frame** with recorded narration (needs the hold capture in the scoped
  run).
- **New fonts in a scoped scene** (needs a controlled `@font-face` path).

## 12. Open questions for the owner

1. **Length:** may redoing a scene change its length, moving later scenes? Recommended: yes, except with recorded
   narration.
2. **Cheaper model for scoped runs:** keep the same model by default, with `SCOPED_AGENT_MODEL` available to admins,
   and suggest one in the README only after the gate's optional comparison? Recommended: yes.
3. **Who can redo scenes:** anyone who can revise, as today (recommended), or only owners and admins?
4. **How many scenes at once:** up to 20, never all of them? Recommended: yes.
5. **Scoped Incorporate feedback:** on by default when every picked comment is pinned (recommended), or off by
   default?
6. **Variations:** later, as their own plan? Recommended: yes.
7. **Held last frame:** refuse the last real scene of a narrated video that holds its frame in v1 (recommended), or
   build the hold capture into scoped runs now?
8. **Finalize sets `contract` atomically with ready** (and `beats`), so `editable` never lags? This is a small change
   for every version. Recommended: yes.
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

## 13. Review log (draft 1 → 2)

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
| Shared rules 1, 4, 5, 10, 15, 16 (feature string, template rule, manifest v1, additive DTO, terminology, `@netlify-labs/*` package names) | Adopted | Throughout. |
| Build order (phase 1 on engines 1; phase 2 on cli 1; phase 4 on cli 3; migration and template after looks 2) | Adopted | Status block and §7. |
