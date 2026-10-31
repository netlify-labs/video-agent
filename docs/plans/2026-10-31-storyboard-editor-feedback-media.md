# Plan: plan-with-questions, in-browser editing, pinned feedback, live progress and a media library

Draft 2 (2026-10-31). Builds on [`PLAN.md`](../../PLAN.md) (the v1 spec). Draft 1 was reviewed by Claude Fable 5 and
Codex `gpt-6.1-sol` (high effort); the decision log at the end says what was taken. Draft 2 also replaces draft 1's
"Gateway writes a storyboard composition" with the owner's **plan with questions** flow (§5).

## 1. What we're building and why

| Feature                             | What people get                                                                                                                                                        | Why it matters                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **A. Live progress**                | While a run works: what it's doing in words, steps and credits so far; later (A2) the composition playing as it's written                                              | A stage name for 5 minutes feels broken                                                      |
| **B. Plan with questions**          | On Create: "Answer a few questions to plan it first?" A few multiple-choice clarifying questions (with write-in, skippable), then a refined brief that goes to the run | Vague prompts are the main cause of wasted renders; questions cost seconds and a few credits |
| **C. Edit in the browser**          | On a finished version: change on-screen text and beat timing in a form (later: click the text in the preview), see it instantly, then **Render** without new authoring | Typo and timing fixes stop costing a full authoring run                                      |
| **D. Comments and pinned feedback** | Anyone signed in pauses, clicks a spot and comments; selected comments become the next version with **Incorporate feedback**                                           | Precise revisions from the whole team                                                        |
| **E. Media library**                | A **Media** page for logos and screenshots; **Add media** on New video and Revise                                                                                      | Product videos need real product UI                                                          |

Non-goals: audio (va-css.2), templates (va-css.3), spend limits (va-css.4).

## 2. Facts this plan relies on (checked 2026-10-31)

- **HyperFrames plays in the browser.** `hyperframes@0.8.222` (Apache-2.0) ships `dist/hyperframes-player.global.js`, a
  `<hyperframes-player>` element (`src`/`srcdoc`, controls, play/pause/seek/durationchange). It creates its **own
  nested iframe** and by default loads its runtime from `cdn.jsdelivr.net/npm/@hyperframes/core@0.8.222/…` (we must
  vendor it). HyperFrames Studio, a browser editor, ships in the same package as a reference.
- **Compositions are attribute-driven HTML** (`data-start`, `data-duration`, `data-track-index`; root
  `data-composition-id`, `data-width`, `data-height`), but animation timing also lives in GSAP timelines
  (`video/index.html`), so editing timing safely needs a contract (§6).
- **The HyperFrames skill ships in the package** at `dist/skills/hyperframes/` (`SKILL.md` 7 KB; references ≈150 KB).
- **Run progress is readable** via `nax-agent-runner-sdk` `getSnapshot()` (`state`, `latestStep`, nullable `usage`
  with `stepsCount` and `totalCreditsCost`); the reconciler already stores `latestStep` every minute
  (`src/domain/reconciler.ts:304`). The SDK has no render-only execution mode; every run is a prompt.
- **AI Gateway** injects `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` (and others) into Functions; 180 credits per US$;
  200k context. Its docs exclude Enterprise plans unless enabled. **Our team (`gtm-engineering`, Enterprise) has AI
  Gateway access** (confirmed by the owner, 2026-10-31). Deployers on other plans may not, so the feature is optional
  (§5).
- **Constraints from the shipped code:**
  - Version and job status are derived from the latest attempt (`statusForStage`, `src/domain/types.ts:30–48`).
  - A revision inherits its parent's `targetDurationSec` (`src/domain/videos.ts:243`), and finalize rejects ±25% (`src/domain/finalize.ts:117`).
  - Source archives exclude every `*.mp4` (`scripts/render-job.ts:58`).
  - Finished compositions exist only as `sources/{job}/v{n}.tar.gz` (`src/domain/finalize.ts:154`).
  - The files edge function serves four fixed names (`netlify/edge-functions/files.ts:12`).
  - `AGENTS.md` allows only two scripts outside `video/`.
  - Cleanup handles explicit rows only, over closed store unions (`src/domain/types.ts:221`, `src/deps.ts:75`).
  - Captions come from `video/summary.json` (`scripts/render-job.ts:57`).

## 3. Shared foundation: a safe composition preview (needed by C and A2)

Compositions are model-written HTML with scripts. They never run on the app's origin.

- **Preview bundles:** finalize (a background function) also extracts each version's composition into
  `bundles/{job}/v{n}/` with a manifest (paths, sizes, hashes), with no MP4s. Extraction validates paths, entry
  count and expanded size, and stages before committing.
- **Preview page:** `GET /preview/{job}/v{n}/…?exp&sig` from an edge function, serving only manifest files of that
  immutable bundle, with headers:
  - `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'none'; frame-src 'self'; form-action 'none'; base-uri 'none'`
  - `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`.
    The vendored player and runtime come from the same signed path. Nothing is fetched from a CDN.
- **In the app:** `<iframe sandbox="allow-scripts">`. A per-preview channel id accompanies every `postMessage`; the
  parent checks the sender is that iframe and the message matches a schema (`time`, `click{x,y,textId}`, `ready`,
  `error`). The parent sends only `play`, `pause`, `seek`, `apply-edits`. Nothing from the composition can trigger a
  fetch, a mutation or a new asset grant.
- **Residual risk, stated plainly:** a malicious composition can still try to exfiltrate what it's given
  (`connect-src 'none'` and no referrer reduce this; signed URLs are short-lived and bundle-scoped). It can't read
  the viewer's session or the API.
- **The UI says** the preview is close but not frame-exact; the MP4 is the truth.

## 4. Feature A: live progress

**A1 (ships first, no prompt changes):**

- `GET /api/v1/videos/{id}/progress` returns `{ attemptId, versionN, stage, step, steps, credits, observedAt, stale }`.
- It's a pure read and never changes attempt state; outcomes stay with the reconciler.
- It calls `getSnapshot` for running attempts at most every 5 s per run. A Blobs-backed cache entry coalesces
  concurrent fetches across Function instances. It serves the last value marked `stale` when upstream fails, and
  falls back to the stored `attempts.latestStep`.
- Queued and starting attempts return the stage and queue position from stored rows.
- The UI polls every 3 s while visible, shows the narration under the stage track, and labels steps and credits as
  counts, never as percentages.

**A2 (after F0):**

- **Checkpoints:** `scripts/checkpoint.ts "<message>"` (added to `AGENTS.md` run rules) posts to
  `/api/internal/runs/{attemptId}/checkpoint` with the attempt's callback token.
  - Accepted only while that attempt is the latest and `running`.
  - Sequence-numbered; a late or reordered checkpoint never replaces a newer one.
  - Bounded: 500-character message, 2 MB bundle, 10/min. Server-chosen keys under `checkpoints/{attemptId}/`.
  - Never touches callback receipts, leases or outcomes. Cleaned up when the attempt ends.
  - The preview plays the latest checkpoint bundle.
- **Render percentage** comes from `render-job.ts` itself (it owns the blocking render) through the same endpoint, not
  from the agent.

## 5. Feature B: plan with questions (AI Gateway)

**Flow (web):** the person writes a prompt and presses **Create video**. A dialog asks **"Answer a few questions to
plan it first?"** with **Plan it** and **Just create**; an admin setting picks which is the default button, and a
"Don't ask again" box remembers the choice per person.

1. **Questions.** The app shows 3–6 questions, one card each, like Claude's question tool. Each card has 2–4
   options, an **Other** write-in, and **Skip**. A **Create now** button is always there, and leaving the dialog
   keeps the prompt.
2. **Brief.** On **Done**, a second call turns prompt + answers into a refined brief. The person sees it and can edit
   it, then presses **Create video**.
3. **Run.** The run's prompt is the original request plus a fenced `Plan (from the questions)` section with the brief
   and the Q&A. Everything after is today's flow.

**Gateway calls** (synchronous Function routes; both are short JSON outputs, S1 measures latency):

| Call                            | Input                                                     | Output (validated with zod)                                                                                             |
| ------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/plans`            | prompt, aspect, durationSec, mediaIds                     | `{ planId, questions: [{ id, question, why, options: [{ id, label, description }], multiSelect, allowOther }] }` (3–6)  |
| `POST /api/v1/plans/{id}/brief` | `answers: [{ questionId, optionIds?, other?, skipped? }]` | `{ brief: { goal, audience, keyMessage, beats: [{ text, seconds }], tone, length, callToAction, mustInclude, avoid } }` |

- **Context:** a build-time, allowlisted digest of `context/` (and the brand kit from `BRAND_ZIP_URL` when set),
  packaged with the function and identified by hash. Media captions are included, and images go in as vision input
  where helpful. Everything user-provided goes in as labelled data inside fences, never as instructions. The system
  prompt says: "you're storyboarding a short video; ask only questions whose answers change the video".
- **Model:** an admin setting from a server-side allowlist of exact model ids (default: a fast Sonnet). No tool loop
  is needed.
- **Records:** a `plans` row (id, userId, prompt, inputs hash, questions, answers, brief, model, tokens, credits,
  createdAt, usedByVersion, expiresAt 24 h). Each call's credits count in usage views, separate from run credits.
- **Failure:** if Gateway is unavailable, rate-limited or times out, the dialog says so and offers **Create now**.
  Planning is never required, and setup reports Gateway as an optional capability that never blocks ordinary videos.

**API and MCP:**

- `POST /api/v1/videos` and `revise` accept an optional `planId` (the brief is attached server-side from the plan row,
  owned by the same user and unused), so scripts and webhooks behave exactly as today unless they opt in.
- MCP gains `plan_video` (returns the questions for the AI client to ask its user) and `plan_brief`; `create_video`
  accepts `plan_id`.
- Revisions can plan too: the questions are about the change.

## 6. Feature C: edit in the browser, render without new authoring

- **Editing contract (version 1), required by the run prompt and `AGENTS.md` for new videos:**
  - each beat is a clip with `data-va-beat="<id>"`, `data-start` and `data-duration`, and **its own GSAP timeline
    with times local to the beat**;
  - on-screen text nodes carry `data-va-text="<id>"` (unique), with captions in `summary.json` keyed to the same ids;
  - the root carries `data-va-contract="1"`.
    Compositions without the marker show **Edit** disabled, with "Ask for a revision instead".
- **Editor:** opens a finished version from its preview bundle (§3).
  - **Step 1:** a beat timeline (drag edges, number inputs, keyboard nudges) and text fields.
  - **Step 2:** click text in the preview to edit it in place; the preview reports `data-va-text`, and HyperFrames
    Studio is the reference. OpenCut's and Omniclip's timelines are references for the UI.
  - Edits are applied by an inert parser (no script execution), with text set as escaped text nodes. Changing beat
    _k_ shifts later beats; the root duration, `summary.json` caption cues and the new version's `targetDurationSec`
    are updated together.
  - The preview updates instantly via `apply-edits`.
- **Saving** creates an `edits` draft: id, job, base version, author, `rev`, an immutable bundle key and hash,
  contract version, expiry 7 days.
  - Save needs `If-Match: rev`; a conflict offers reload, or fork to your own draft.
  - **Render** freezes that revision and creates vN+1 plus one queued attempt in `render_unchanged` mode, atomically.
    It uses an `Idempotency-Key`, and retries reuse the frozen bundle.
- **Render unchanged** run: `prepare-run` restores the frozen bundle and verifies its hash. The prompt says: "Don't
  change the composition. Run `hyperframes check`; if it fails, stop and report. Render." `render-job` re-hashes the
  composition before rendering and fails on any difference. It's still an Agent Runner (rendering needs Chrome and
  FFmpeg); S4 measures cost.
- **Prior art:** browser video editors (OpenCut, OpenReel, Omniclip, WebAV) edit video frames with WebCodecs; ours are
  HTML, so we borrow their timeline UI, not their engines. S7 asks whether the browser could render the MP4 itself
  (WebCodecs encodes fine; faithfully turning DOM into frames is the blocker). It's research only.
- **Fallback if S8 fails:** generate compositions from beat JSON with our own compiler for editable videos (less
  creative range, fully editable).

## 7. Feature D: comments, pinned feedback, incorporate

- **`comments`:**
  - id, job, versionN, authorId, body (≤2,000 chars), `timeSec?` and `x?`/`y?` (normalized 0–1 within the displayed
    video content, letterboxing excluded, always paired), createdAt, editedAt, resolvedAt/By, deletedAt;
  - rendered as text only.
- **Pinning:** pause on a ready version, click the frame, type. Markers appear on the progress bar and as dots, only
  on the version they were made on. Clicking a comment seeks there. No HTML preview is needed (it's the MP4).
- **Permissions:** everyone signed in can read and comment; authors edit and delete their own; the video owner and
  admins resolve and delete any.
- **Notifications:** an in-app unread badge for the owner, with a per-user read model (`comment_reads`).
- **Incorporate feedback:**
  - Select open comments on one ready version and press the button. It's disabled, with the reason, while another
    version is unfinished.
  - It creates a revision with `version_comments` rows that snapshot each comment (body, author, timeSec, x/y) at
    queue time. The prompt lists them as fenced, labelled data; total length is bounded.
  - **Frame stills are made in the run:** `prepare-run` pulls the parent MP4 and runs `ffmpeg -ss` per pinned comment
    into `video/feedback/`, with a dot drawn at x/y. No browser capture or upload.
  - Comments are marked "addressed in vN+1" only in the successful finalize transaction. Failed, cancelled or
    replayed attempts change nothing. Resolving stays a separate human action.
- **MCP:** `list_comments`, `add_comment`; `revise_video` accepts `comment_ids`.

## 8. Feature E: media library

**E1 (images):**

- PNG, JPEG and WebP, up to 5 MB, uploaded in one request (under the Function body limit).
- The server sniffs the type, decodes it (pixel limit 40 MP), computes the sha256 and dimensions, and quarantines the
  upload until it's verified. Files are served with a fixed type and `nosniff` from new signed routes.
- **`media`:** id, name, caption (≤300 chars), mime, bytes, sha256, width, height, uploadedBy, createdAt, deletedAt.
  The library is team-wide.
- **Media page:**
  - a grid with "used in N videos" and an empty state;
  - drag-and-drop upload with per-file progress and errors;
  - delete by the uploader or an admin (soft delete).
- **Add media:** chips on New video, Revise and the plan dialog.
  - At queue time, `version_media` snapshots media id, sha256, blob key and caption into the version.
  - `prepare-run` downloads into `video/assets/media/` and verifies hashes.
  - The prompt lists files with their captions as data.
  - Media is **by reference**: it never enters `source.tar.gz`. Revisions re-download via `version_media`, and soft
    delete keeps the bytes while any version, plan or queued attempt references them.
- **E2 (later):** SVG (served only inside the sandbox, or as an attachment) and MP4, behind an upload-session design:
  - uploader-bound expiring sessions and server keys;
  - part limits and hashes, idempotent completion;
  - decode and codec validation, quotas, abandoned-part cleanup;
  - assembly where there are no Function limits.

## 9. Cross-cutting changes

| Area                      | Change                                                                                                                                                                                                                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data (new migration only) | `plans`, `edits`, `comments`, `comment_reads`, `version_comments`, `media`, `version_media`; version `mode` (`author` default, `render_unchanged`); settings columns: plan default, plan model                                                                                                                                   |
| Stores and cleanup        | New Blobs stores or prefixes: `bundles`, `checkpoints`, `edits`, `media`, `brand-cache`, each added to `BlobStoreName`, `CleanupRow.store` and `deleteVideo`'s cleanup rows. The sweep gains an expiry worker (plans 24 h, edits 7 d, checkpoints at attempt end). Late writers recheck deletion before commit, as finalize does |
| Policy                    | New actions for plans, edits (read, save, fork, render), comments (create, edit, resolve, delete), media (upload, delete); enforced in the domain layer so REST and MCP share them; paid routes keep the setup gate                                                                                                              |
| API                       | All new routes in OpenAPI with errors and pagination; `If-Match` and `PUT` allowed in CORS; idempotency on render, incorporate and media upload                                                                                                                                                                                  |
| Edge                      | `/preview/{job}/v{n}/*` (sandbox CSP, manifest-only); `/media/{id}` and `/media/{id}/thumb` (signed, fixed MIME)                                                                                                                                                                                                                 |
| Runs                      | `prepare-revision` → `prepare-run` (bundles, media, feedback stills); `checkpoint.ts`; contract and render-unchanged prompts; `AGENTS.md` updated in the same change                                                                                                                                                             |
| Setup page                | AI Gateway: optional capability (ok, unavailable or unknown)                                                                                                                                                                                                                                                                     |

## 10. Order of work

1. **A1 live progress** (snapshot only). Independent; ships first.
2. **S1, then B (plan with questions).** Our team has Gateway access; S1 measures latency and cost.
3. **D comments and incorporate.** No preview needed; can run in parallel with B.
4. **E1 media (images).** Parallel with D; B and D use it when present.
5. **S2 + S8, then F0 (preview) and C (editor + render unchanged).** S4 measures the render cost.
6. **A2 checkpoints and live composition** (needs F0).
7. **E2** (SVG and video uploads, after S5). **S7** browser render stays research.

## 11. Spikes

| #   | Question                                                                                                                                                                                                                                                                                       | Done when                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| S1  | Latency, tokens and credits for questions + brief with two models from a deployed Function; 429 and timeout behaviour                                                                                                                                                                          | Measured calls from production, numbers in SPIKES.md                                     |
| S2  | The real nested player and runtime (vendored) inside the §3 CSP, in Chrome and Safari: play, seek, click to text id, fonts and media from signed bundle URLs, `apply-edits`, URL renewal; negative tests (no API access with the viewer's session, forged messages ignored, no network egress) | All checks pass in both browsers, as an automated test                                   |
| S4  | Full time and credits for a render-unchanged run (15 s and 60 s, with fonts and media): setup, check, render, upload, finalize; cold and warm; hash mismatch fails                                                                                                                             | Measurements in SPIKES.md                                                                |
| S5  | (E2) Upload sessions at the configured maxima for SVG and MP4: assembly memory and time, resume, duplicates, hash mismatch, Range playback, cleanup                                                                                                                                            | Before E2 only                                                                           |
| S7  | Browser render with WebCodecs plus a faithful DOM-to-frame path                                                                                                                                                                                                                                | Timeboxed research; "no" is fine                                                         |
| S8  | Edit round trip: a contract-1 composition with nested scenes, a font, an image; shorten and lengthen a middle beat, change long text; captions follow; restore in a fresh run and render unchanged                                                                                             | Saved edits survive exactly, with no model repair; unsupported compositions fail clearly |

(Draft 1's S3 and S6 are gone: the Gateway no longer writes compositions.)

## 12. Tests and release gates per feature

| Feature | Unit + integration (PGlite, fakes)                                                                                                                     | Playwright (mock build)                                                   | Live gate                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| A1      | Cache coalescing, stale/error/null usage, queued/starting, retry identity, no state changes from reads                                                 | Hidden-tab polling stops, stale label, cancel/retry                       | Several viewers, bounded upstream calls                           |
| B       | Zod validation of model output, fenced inputs, plan ownership/expiry/single use, Gateway down/429/timeout, usage accounting                            | Dialog: plan, skip one, Other, skip all, Create now, edit brief, errors   | Questions + brief + run on production, credits recorded           |
| C       | Edit patcher invariants (timing shift, captions, target), inert parsing/escaping, If-Match conflicts, frozen render input, render-unchanged hash check | Text/timing edits, conflict reload/fork, unsupported version              | Edit → render → MP4 and VTT match the edit                        |
| D       | Scope/permission matrix, coordinate validation, snapshot at queue, addressed only on success, deletion                                                 | Pin accuracy with letterboxing, unread badge, incorporate disabled states | Incorporate run receives stills; only included comments addressed |
| E1      | Sniff/decode/size failures, quarantine, soft delete with references, permissions                                                                       | Upload states, picker, empty library                                      | Upload → use in a video → revise after soft delete                |
| F0/A2   | Manifest/path/signature, late-checkpoint ordering, cleanup                                                                                             | CSP headers, forged messages, canaries                                    | Production preview plays; old deploys can't serve bundles         |

Existing CI (typecheck, lint, vitest, Playwright, `openapi:check`, migrations applied in PGlite) stays required.

## 13. Owner decisions

1. **Plan dialog default:** show the dialog with **Plan it** or **Just create** as the default button? (Proposed: the
   dialog shows; default button **Plan it**; "Don't ask again" per person.)
2. **Planning model:** a fast Sonnet by default; may admins pick others from the allowlist?
3. **Edits and incorporate:** anyone may make an edit or incorporate feedback (like revisions today), or owner and
   admins only? (Proposed: anyone; it creates a new version, never changes an existing one.)
4. **Render unchanged is a hard guarantee:** if the check fails, stop rather than let the agent fix it? (Proposed: yes;
   offer "Revise instead".)
5. **Media:** team-wide, images-only E1 at 5 MB (proposed); when do SVG and video matter?
6. **Notifications for comments:** in-app badge only (proposed), or also browser notifications and webhooks?

## Decision log

**Draft 2 (2026-10-31), owner input:**

- Planning became **plan with questions**: the Gateway asks multiple-choice clarifying questions (with write-in,
  skippable) and returns a refined brief that's appended to the run prompt. It never writes compositions. Removed:
  Gateway HTML, the planning draft lifecycle and its durable-task machinery, S3 and S6.
- The gtm-engineering team has AI Gateway access (owner). S1 measures cost and latency only.

**Reviews of draft 1** (Fable 5 high, runner `6ae61fb3247cb8bb680b47d4`, 844 credits; Codex `gpt-6.1-sol` high,
runner `6ae61fb3ff57a9beee1f8711`, 192 credits). Claims checked against the code before acting.

Taken:

- No new version states; drafts are separate and a version is created only at render or approval (both).
- Planning is opt-in per request for API and MCP (`planId`); the admin default affects only the web dialog (Fable).
- Media by reference, snapshotted per version, because archives drop MP4s (Fable; verified `render-job.ts:58`).
- Render unchanged sets the target from the edit and updates captions, because finalize's ±25% check and
  `summary.json` captions would otherwise reject or contradict edits (both; verified).
- An explicit editing contract with beat-local timing, and the S8 round-trip spike (Codex).
- Preview bundles extracted by finalize; preview CSP, vendored runtime, message validation and residual-risk statement
  (both; verified the player's nested iframe and CDN default).
- A1 snapshot-only first; checkpoints hardened as A2; render percentage from `render-job` (both).
- Prompt inputs as labelled data; bounded sizes; injection fixtures for each new channel (both).
- E1 images-only single-request uploads; E2 upload sessions (both).
- Comment snapshots, addressed only on successful finalize, stills made by ffmpeg in the run (Codex; Fable for the
  stills).
- Cleanup and expiry for every new store, a new migration, a policy and API matrix covering REST, MCP and CORS, the
  per-feature test matrix (both).
- Gateway as an optional capability with per-call usage accounting; exact model allowlist (Codex).
- Fact fix: skill references are ≈150 KB, not 346 KB (Fable).

Not taken:

- Archiving input MP4s inside source archives (Codex): by reference is simpler and keeps one copy.
- A deterministic beat-to-HTML compiler as the default (Codex): kept as the fallback if S8 fails, since it narrows
  creative range.
- A short planning agent run instead of the Gateway (Codex): the questions flow needs seconds, not minutes; S1 still
  measures Gateway cost.
- Fable's note that Enterprise plans lack AI Gateway: true in general, but the owner confirmed our team has access.
