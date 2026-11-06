# Plan v2: roles, plan with questions, comments, live progress, editing and media

Draft 4 (2026-10-31). Builds on [the v1 spec](2026-10-30-video-agent-spec.md). Draft 1 was reviewed by Claude Fable 5 and
Codex `gpt-6.1-sol` (high effort). Draft 2 adopted the owner's **plan with questions** flow. Draft 3 records a full
owner interview: it adds roles and privacy (Feature R), widens the editor and media scope, and fixes the order of
work. Draft 4 folds in a second Fable/Codex review round (§14 holds the binding implementation rules it produced). The
decision log at the end lists every decision.

## 1. What we're building and why

The goal is a real SaaS-like team product: people who make videos, people who only review them, and admins who run it.

| #   | Feature                               | What people get                                                                                                                                               |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R   | **Roles, privacy, approvals**         | Admin, Creator, Reviewer and Viewer roles; private videos; Approved or Changes requested per version; ownership transfer; personal and team webhooks          |
| B   | **Plan with questions**               | **Plan it first** beside Create: a few multiple-choice clarifying questions (write-in, skippable, sometimes none), then an editable brief appended to the run |
| D   | **Comments and incorporate feedback** | Comments pinned to a moment; the owner (or an admin) picks comments and makes the next version from them                                                      |
| A   | **Live progress**                     | Plain-language narration while a run works, then the composition playing as it's written                                                                      |
| C   | **Edit in the browser**               | On finished videos: text, beat timing, brand colours, reorder or delete beats, swap media; then **Render** with no new authoring                              |
| E   | **Media library**                     | Images, SVG logos, short MP4 clips and fonts, shared across the team; **Add media** on create, revise and plan                                                |

Non-goals: audio (va-css.2), templates (va-css.3), spend limits (va-css.4), email.

## 2. Facts this plan relies on (checked 2026-10-31)

- **HyperFrames plays in the browser.** `hyperframes@0.8.222` (Apache-2.0) ships `dist/hyperframes-player.global.js`, a
  `<hyperframes-player>` element that creates its **own nested iframe** and by default loads its runtime from
  `cdn.jsdelivr.net` (we vendor it). HyperFrames Studio, a browser editor, ships as a reference.
- **Compositions** use `data-start`, `data-duration` and `data-track-index` on clips, but animation timing also lives in
  GSAP timelines, so editing needs a contract (§8).
- **The HyperFrames skill** ships at `dist/skills/hyperframes/` (`SKILL.md` 7 KB; references ≈150 KB).
- **Run progress:** `getSnapshot()` returns `state`, `latestStep` and nullable `usage` (`stepsCount`,
  `totalCreditsCost`); the reconciler stores `latestStep` every minute. The SDK has no render-only mode.
- **AI Gateway** injects `ANTHROPIC_*`, `OPENAI_*`, `GEMINI_*`, `OPENROUTER_*` and `TYPESAFE_*` keys and base URLs into
  Functions. TypeSafe's `jev` models are decision models suited to fast routing. Usage is billed at 180 credits per
  US$. **Our team has Gateway access** (owner, 2026-10-31); other deployers may not, so planning
  is optional.
- **Code constraints:**
  - Status derives from the latest attempt (`src/domain/types.ts:30–48`).
  - Revisions inherit the parent's target length, and finalize rejects ±25% (`src/domain/videos.ts:243`,
    `src/domain/finalize.ts:117`).
  - Source archives drop `*.mp4` (`scripts/render-job.ts:58`).
  - Finished compositions exist only as tarballs (`src/domain/finalize.ts:154`).
  - The files edge function serves four fixed names.
  - `AGENTS.md` allows only two scripts outside `video/`.
  - Cleanup is explicit rows over closed store unions.
  - Captions come from `summary.json`.
  - Roles today are `admin` and `member` (`src/domain/policy.ts`).

## 3. Feature R: roles, privacy, approvals (built first)

### Roles

| Can…                                                                            | Admin     | Creator    | Reviewer                  | Viewer                 |
| ------------------------------------------------------------------------------- | --------- | ---------- | ------------------------- | ---------------------- |
| Watch videos, see comments and approvals                                        | ✓         | ✓          | ✓                         | ✓ (comments read-only) |
| Comment; approve or request changes (not on their own version)                  | ✓         | ✓          | ✓                         |                        |
| Create, revise, plan, edit (spends credits)                                     | ✓         | ✓          |                           |                        |
| Revise or edit **someone else's** video (adds a version they author)            | ✓         | ✓          |                           |                        |
| Owner powers: publish, unpublish, private, rename, delete, incorporate feedback | any video | own videos |                           |                        |
| Upload media                                                                    | ✓         | ✓          |                           |                        |
| API keys                                                                        | ✓         | ✓          | ✓ (read and comment only) | ✓ (read only)          |
| Users, roles, settings, ownership transfer, team webhook, queue                 | ✓         |            |                           |                        |

- **Joining:** new people join as **Creator**; `ADMIN_EMAILS` become Admin. Admins change roles on the Admin page.
  Today's `member` rows migrate to Creator.
- **Keys and MCP inherit the role:** a Reviewer's key can list, watch and comment through REST and MCP. Mutations
  outside the role return `forbidden` with the reason ("your role can't create videos"). The MCP tool list is
  filtered to what the role can do.
- **Disabled people:** their videos stay and published links keep working. Admins can **Transfer to…** another
  Creator, which moves owner powers. Until then, admins act as owner.
- One policy module enforces all of this in the domain layer, so REST, MCP and the UI agree. A role demotion takes
  effect on the next request (the live account check already re-reads users).

### Private videos

- A per-video **Private** toggle (owner or admin). A private video is visible only to its owner and admins: it's
  hidden from everyone else's Library, search, comments, API and MCP (404, not 403).
- **Private doesn't block publishing:** publishing is a separate, explicit owner act, and share links work as before.
- Videos are team-visible by default. **The Library defaults to Everyone (as today)**, with a **Mine** tab, and private
  videos show a lock.

### Approvals

- Any Reviewer, Creator or Admin, **except the version's author**, can mark a version **Approved** or **Changes
  requested** (one current verdict per person per version, changeable, with an optional note).
- It's a **signal only**: shown on the version and in the Library ("2 approved, 1 changes requested"); nothing is
  blocked.

### Notifications and webhooks

- **In-app:** an unread badge on the owner's videos and in the Library, for comments and approvals.
- **Browser notifications:** like today's "video ready", while the app is open.
- **Webhooks:**
  - **Personal:** in Settings, each person may set one signed webhook URL, for events on videos they own:
    `video.ready`, `video.failed`, `comment.created`, `version.approved`, `version.changes_requested`.
  - **Team:** admins set one signed webhook URL for all events on all videos.
  - Both reuse today's signing (`X-Video-Agent-Signature`), outbox, retries and SSRF checks.
  - The existing per-video `webhookUrl` on API create keeps working.

## 4. Feature B: plan with questions

**UX:** the Create button becomes a split button. **Plan it first** is the default; **Create now** is beside it. Planning
opens a side panel next to the prompt, not a modal.

1. **Routing call (fast, `jev`), its own request.** It classifies the request and returns:
   - `needsQuestions` (detailed prompts skip straight to the brief);
   - the model for the next call (Haiku, Sonnet or Opus);
   - a question template (`launch`, `tutorial`, `social`, `changelog`, `sales`, `other`);
   - suggested length and aspect ("for TikTok" means 9:16), pre-filled and editable.
2. **Questions (routed model), a second request**, so each stays well inside the Function deadline. 0–6 questions, guided by the template's checklist (audience, key message, length,
   call to action, tone, must-include, avoid). The model asks only about what the prompt leaves open, in its own
   words. Each question has 2–4 options, **Other** (write-in) and **Skip**. With 0 questions the panel says "Your
   prompt covers it" and goes to the brief.
3. **Brief.** A short, readable, editable brief (edits are saved to the plan with `PATCH /plans/{id}` and
   `If-Match`, and the run uses exactly the saved revision) (goal, audience, key message, beats with seconds, tone, call to
   action, must-include, avoid). **Create video** is one click away.
4. **Run.** The run prompt is **the person's original prompt, verbatim**, plus a fenced `Plan (from the questions)`
   section with the brief and the Q&A.

**Context for the planner:**

- an allowlisted, build-time digest of `context/` and the brand kit (`BRAND_ZIP_URL`), identified by hash;
- chosen media (captions, and images as vision input);
- **the person's own last 5 prompts and titles** (never other people's).
  All of it is passed as fenced, labelled data, never as instructions.

**Revisions:** **Plan it first** also appears on Revise. The router returns `needsQuestions: false` for small, precise
changes ("make the end card orange"), so it rarely gets in the way.

**API and MCP:**

- `POST /api/v1/plans` (route, then questions) and `POST /api/v1/plans/{id}/brief`.
- `planId` on create and revise.
- MCP `plan_video`, `plan_brief`, and `plan_id` on `create_video` and `revise_video`.
- Without `planId`, API behaviour is unchanged.

**Records and cost:**

- `plans` rows: route decision, questions, answers, brief, models, tokens and credits per call, expiry 24 h, single
  use.
- Gateway failures (unavailable, 429, timeout) fall back to **Create now** with a message. Setup reports Gateway as an
  optional capability that never blocks ordinary videos.
- **Admins** pick the default deep model from an allowlist and see usage **split into runs and planning**. **Creators**
  see **my usage this month**.

## 5. Feature D: comments, approvals UI, incorporate feedback

- **Comments:** text plus an optional pin (`timeSec`, and `x`/`y` normalized within the displayed video content,
  letterboxing excluded). Pins show on the progress bar and as dots, only on their own version.
  - Authors edit and delete their own; owner and admins resolve or delete any.
  - Viewers read only. Private videos hide their comments too.
- **Incorporate feedback** (owner or admin):
  1. Open comments on one ready version are listed with checkboxes, all checked, plus an optional note ("ignore the
     colour comments"). Resolved comments are excluded.
  2. A revision is created with `version_comments` snapshots (body, author, time, position) taken at queue time.
  3. The run's `prepare-run` makes frame stills with `ffmpeg -ss` and draws a dot at the pin.
  4. Comments are marked "addressed in vN+1" only when that version finalizes successfully.
     The action is disabled, with the reason, while another version is unfinished.
- **Approvals UI:** Approve and Request changes buttons with an optional note on each version; counts in the Library.
- MCP: `list_comments`, `add_comment`, `set_verdict`; `revise_video` accepts `comment_ids` (owner or admin).

## 6. Feature A: live progress

- **A1:** `GET /videos/{id}/progress`, a pure read.
  - It reads the runner snapshot at most every 5 s per run, through a shared Blobs cache across instances, and falls
    back to the stored step, marked `stale` when it is.
  - The page shows plain-language narration under the stage track, plus steps and credits so far as counts.
  - It polls every 3 s while visible.
- **A2:** `scripts/checkpoint.ts` (added to `AGENTS.md`) posts milestones ("Writing the end card", "Checking, round 2")
  and a composition snapshot to a hardened internal endpoint: the attempt token, latest running attempt only,
  sequence numbers, size and rate bounds, its own store and cleanup.
  - `render-job.ts` reports **Rendering N%** itself.
  - The page plays the latest snapshot in the sandboxed preview (§7). No raw logs.

## 7. Shared foundation F0: the sandboxed composition preview

- Finalize extracts each version's composition into `bundles/{job}/v{n}/` with a manifest. Extraction validates paths
  (no traversal or links) and entry counts and sizes, and excludes MP4s.
- `GET /preview/...?exp&sig` (edge) serves only manifest files of an immutable bundle, or a checkpoint bundle, with:
  - `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'none'; frame-src 'self'; form-action 'none'; base-uri 'none'`
  - `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`, `nosniff`.
    The player and runtime are vendored from the pinned package.
- The app embeds `<iframe sandbox="allow-scripts">` with a per-preview channel. It accepts only schema-valid messages
  from that iframe (`time`, `click{x,y,textId}`, `ready`, `error`) and sends only `play`, `pause`, `seek`,
  `apply-edits`. Signed URLs refresh before they expire without losing the playhead.
- **Residual risk, stated:** a composition can try to exfiltrate what it's given. It can't read the session or the API.
  The UI notes that the preview is close to the final video but not exact.

## 8. Feature C: edit in the browser

**Editing contract v1** (required for new videos by the prompt, `AGENTS.md` and a skill addendum; editability wins
over creative range):

- **Beats:** each is a clip with `data-va-beat`, `data-start`, `data-duration` and **its own beat-local GSAP
  timeline**. Beats don't depend on each other's timing, so they can be reordered and deleted.
- **Text:** unique `data-va-text` ids; `summary.json` captions are keyed to them.
- **Colours:** elements take colours from CSS custom properties named for brand roles (`--va-color-<role>`, for
  example `bg`, `text`, `accent`), declared once at the root and drawn from the brand palette.
- **Media slots:** `<img>`/`<video>` with `data-va-media="<slot>"` referencing `assets/media/<mediaId>`.
- **Root:** `data-va-contract="1"`.

**Editor v1, all on finished contract-1 videos** (others show **Edit** disabled with "Ask for a revision instead"):

- change text (fields, and clicking text in the preview);
- beat timing (drag edges, number inputs, keyboard nudges);
- brand colours (swap a role's colour within the brand palette);
- reorder or delete beats;
- swap a media slot for another library item.

**How edits apply:**

- An inert parser (no script execution) applies edits to the bundle. Text is set as escaped text nodes. Beat starts,
  root duration, caption cues and the new version's target length are recomputed together. Previews update instantly.
- **Each person gets their own draft** (`edits`, expiry 7 days), based on a version. If someone else renders first,
  the editor says "v5 now exists: start from v5, or render yours as v6".
- **Render** (Idempotency-Key) freezes the draft and creates **a new version labelled "edited from vN"**, with one
  queued **render-unchanged** run:
  - the run restores the frozen bundle and verifies its hash;
  - it runs `hyperframes check`; if that fails, it **stops**, and the UI explains why and offers **Revise instead**;
  - `render-job` re-hashes before rendering, and any difference fails the run.
- **Prior art:** OpenCut and Omniclip timelines (UI patterns); HyperFrames Studio (click-to-select). S7 researches
  rendering in the browser.

## 9. Feature E: media library

- **Types and limits:**
  - PNG, JPEG and WebP up to 5 MB (files over 4 MB use an upload session).
  - SVG up to 1 MB: **sanitized on upload** (scripts, event handlers and external references stripped), with the
    original kept for download. Runs and previews use the clean copy, served only inside the sandbox or as an
    attachment.
  - **MP4 clips** up to 100 MB and 2 minutes: H.264/AAC checked with ffprobe in the run that first uses them, plus a
    container check on upload.
  - **Fonts:** WOFF2, TTF or OTF up to 2 MB, with no licence checks (owner decision).
- **Uploads:**
  - Up to 4 MB: one request (Netlify's effective binary request limit is about 4.5 MB).
  - Over 4 MB: upload sessions. Sessions are uploader-bound with server keys, parts of at most 4 MB with hashes,
    idempotent completion, a whole-file hash, quotas and abandoned-part cleanup. Assembly happens outside the request
    path, either in a background function or by streaming in the run.
  - The server sniffs types from bytes, decodes images (40 MP limit), and quarantines files until they're verified.
- **Who:** Creators and Admins upload; everyone can view. The library is team-wide. The uploader or an admin can
  soft-delete. Bytes are kept while any version, plan, draft or queued attempt references them.
- **Use:**
  - **Add media** chips on create, revise, the plan panel and the editor's slot swap.
  - `version_media` snapshots id, hash, key and caption at queue time.
  - `prepare-run` downloads into `video/assets/media/` and verifies hashes.
  - Media is by reference, never inside `source.tar.gz`.
  - Fonts are offered to the agent in the prompt and copied into the project.
- **Media page:** a grid with thumbnails or posters, a "used in N videos" count, captions, drag-and-drop upload with
  progress and resume, and an empty state.

## 10. Cross-cutting

| Area                       | Change                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data (new migrations only) | `users.role` widened (`admin`, `creator`, `reviewer`, `viewer`; `member` → `creator`); `jobs.private`, `jobs.ownerId` transfer audit; `verdicts`; `user_webhooks`, settings team webhook; `plans`; `comments`, `comment_reads`, `version_comments`; `edits`; `media`, `media_uploads`, `version_media`; version `mode` (`author`, `render_unchanged`) and `editedFromN`; settings: plan model allowlist and default |
| Stores and cleanup         | `bundles`, `checkpoints`, `edits`, `media`, `media-parts`, `brand-cache`: each added to `BlobStoreName`, `CleanupRow.store` and delete paths; the sweep's expiry worker covers plans, edits, uploads and checkpoints; late writers recheck deletion                                                                                                                                                                 |
| Policy                     | One action matrix (§3) enforced in the domain layer for REST and MCP; private videos are 404 to non-owners; the setup gate stays on paid routes                                                                                                                                                                                                                                                                     |
| API                        | Everything in OpenAPI with errors and pagination; `If-Match`/`PUT` in CORS; idempotency on render, incorporate, upload completion and plan-to-create                                                                                                                                                                                                                                                                |
| Webhooks                   | New event types; personal and team destinations; same outbox, signing and retries                                                                                                                                                                                                                                                                                                                                   |
| Edge                       | `/preview/*` (sandbox CSP); `/media/{id}`, thumbs and posters (signed, fixed MIME, `nosniff`; SVG attachment or sandbox only)                                                                                                                                                                                                                                                                                       |
| Runs                       | `prepare-revision` → `prepare-run` (bundles, media, fonts, feedback stills); `checkpoint.ts`; contract and render-unchanged prompts; `AGENTS.md` updated in the same change                                                                                                                                                                                                                                         |
| Usage                      | Runs and planning split for admins; "my usage this month" for creators                                                                                                                                                                                                                                                                                                                                              |

## 11. Order of work

1. **R:** roles, private videos, approvals, ownership transfer, webhooks.
2. **B:** plan with questions (S1 first).
3. **D:** comments and incorporate feedback (uses R's permissions and approvals).
4. **A1:** live progress, snapshot only.
5. **S2 and S8, then F0, then C** (the editor), with **A2** after F0. S4 measures the render-unchanged cost.
6. **E:** the media library. Images and fonts first, then SVG and MP4 after S5. The editor's media swap waits for E.
7. **S7:** research only.

## 12. Spikes

| #   | Question                                                                                                                                                                                                                    | Done when                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| S1  | Gateway from a deployed Function: `jev` routing latency and cost, questions and brief with Haiku, Sonnet and Opus; 429 and timeout behaviour                                                                                | Numbers in docs/spikes.md and default models chosen                                                                            |
| S2  | The vendored nested player inside the §7 CSP in Chrome and Safari: play, seek, click to text id, fonts and media from signed URLs, `apply-edits`, URL renewal; no session or API access, forged messages ignored, no egress | An automated test passes in both browsers                                                                                      |
| S4  | Time and credits of a render-unchanged run (15 s and 60 s, with fonts and media), cold and warm; hash mismatch fails                                                                                                        | Numbers in docs/spikes.md                                                                                                      |
| S5  | Upload sessions at the limits (100 MB MP4, 1 MB SVG): assembly memory and time, resume, duplicates, hash mismatch, Range playback, cleanup; SVG sanitizer against a malicious corpus                                        | All pass, corpus in tests                                                                                                      |
| S7  | Browser render (WebCodecs plus faithful DOM-to-frames)                                                                                                                                                                      | Timeboxed; "no" is fine                                                                                                        |
| S8  | Contract-1 round trip: retime, reorder and delete beats, change text, swap a colour role and a media slot; captions follow; a fresh run renders unchanged                                                                   | Edits survive exactly with no model repair; side-by-side quality check against free-form videos is recorded (editability wins) |

## 13. Tests and release gates

| Feature | Unit + integration (PGlite, fakes)                                                                                                                                                    | Playwright (mock)                                                             | Live gate                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| R       | Full role × action matrix (REST and MCP), private 404s, self-approval refused, transfer, demotion takes effect, keys inherit role, webhook signing and fan-out                        | Role-specific UI (Reviewer sees no Create), private lock, Mine tab, approvals | Reviewer key via MCP can comment but not create                   |
| B       | Router and question zod validation, 0-question path, fenced inputs (prompt, answers, history, captions), plan ownership, single use and expiry, Gateway down/429/timeout, usage split | Split button, panel, skip, Other, 0 questions, brief edit, fallback           | Plan, answer, run on production; credits split                    |
| D       | Comment permissions incl. private and viewers, coordinates, snapshots, addressed only on success                                                                                      | Pins with letterboxing, checkboxes, note, unread badge                        | Incorporate run gets stills; only included comments addressed     |
| A       | Cache coalescing, stale, checkpoint ordering and bounds                                                                                                                               | Narration, hidden-tab pause, live preview                                     | Several viewers, bounded upstream calls                           |
| F0/C    | Patcher invariants (retime, reorder, delete, colour, media), inert parsing, per-person drafts, frozen render, hash check, check-fail stop                                             | All five edit kinds, "v5 exists" flow, unsupported versions                   | Edit, render; MP4 and VTT match                                   |
| E       | Sniff, decode, sanitize, sessions, quotas, references, soft delete                                                                                                                    | Upload, resume, errors, picker, empty library                                 | 100 MB clip and a font used in a video, revised after soft delete |

Existing CI (typecheck, lint, vitest, Playwright, `openapi:check`, migrations in PGlite) stays required.

## Decision log

**Round-2 review (2026-10-31), draft 4:** Fable 5 high (a runner, 787 credits) and Codex
`gpt-6.1-sol` high (a runner, 215 credits). Claims checked against the code: webhooks emit
only with an API key, and `webhook_events.api_key_id` is NOT NULL; the last-admin guard covers only `member`; signup
inserts `member`; idempotency replays before loading the job; `GET /videos/{id}` has no per-video check; the template
loads GSAP from a CDN; `targetDurationSec` is an integer.

- Taken: everything in §14.
- Adapted: Fable's "split `/plans`" became three requests (route, questions, brief) plus `PATCH`; Codex's
  identity-bound file capabilities became the lighter `accessEpoch` signature.
- Owner decisions:
  - Private is in-app hiding among trusted colleagues.
  - The team webhook gets full private details.
  - Pending deliveries are re-checked at send time.
  - A demoted author can cancel but not retry.
  - Poster fallback is fine for clip previews.

**Owner interview (2026-10-31), draft 3:**

- **Planning:**
  - Split button, **Plan it first** by default, and a side panel, not a modal.
  - The router may return 0 questions; a fast `jev` routing call picks the model, template and whether to ask, and
    suggests length and aspect.
  - Questions are model-written and guided by a checklist.
  - The original prompt is kept verbatim with the brief appended. The brief is shown, editable, and one click to go.
  - Revisions plan only for big changes. The planner sees the person's last 5 prompts and titles.
  - The default deep model is a fast Sonnet; admins can switch.
- **Roles:** Admin, Creator, Reviewer, Viewer. New people join as **Creator**. Reviewers and Viewers never spend
  credits. Keys and MCP inherit the role. Creators can revise others' videos (a new version they author). Leavers'
  videos stay, and admins can transfer them.
- **Privacy:** a per-video Private toggle (owner and admins see it); private videos can still be published. The Library
  defaults to Everyone, with a Mine tab.
- **Feedback:** everyone signed in comments; Viewers read only.
  - Owner or admin incorporates feedback: checkboxes, all checked, plus a note.
  - Approved or Changes requested is a signal only; nobody approves their own version.
  - Notifications: in-app badge, browser notification, personal and team webhooks.
- **Editor:** text, timing, brand colours, reorder or delete beats, and swap media in v1. Old videos say "Revise
  instead".
  - Edits make a new version, labelled "edited from vN"; each person has their own draft.
  - Render unchanged stops on a check failure.
  - Editability wins over creative range.
- **Media:** images, SVG (sanitized, original kept), MP4 up to 100 MB and 2 min, and fonts (no licence checks), all in
  the first release. Creators and admins upload; everyone views.
- **Progress:** plain-language narration plus a live preview, with no raw logs.
- **Cost:** split runs and planning on the admin usage page, plus "my usage this month".
- **Order:** R, B, D, A, then the editor, then media.

**Draft 2:** plan with questions replaced Gateway-written storyboards; our team has Gateway access.

**Reviews of draft 1** (Fable 5 high, 844 credits; Codex `gpt-6.1-sol` high, 192 credits). Taken:

- drafts outside version states;
- opt-in planning for API and MCP;
- media by reference, because archives drop MP4s;
- render unchanged fixing the target length and captions;
- the editing contract and S8;
- preview bundles, the CSP, vendored runtime and message validation;
- snapshot-first progress and hardened checkpoints;
- labelled prompt inputs;
- comment snapshots, addressed on success, with stills made in the run;
- cleanup for every store, new migrations only, the policy and API matrix, the per-feature tests;
- Gateway as an optional capability with usage accounting.

Not taken:

- archiving input MP4s (by reference instead);
- a beat-to-HTML compiler as the default (fallback only if S8 fails; the owner chose editability, so the contract
  stands);
- a planning agent run (the Gateway is seconds, not minutes).

## 14. Implementation rules from the round-2 review (binding)

These are part of the spec. Each feature's beads cite the rules that apply.

### Roles and privacy (R)

1. **Role migration:**
   - A forward data migration moves `member` to `creator`. `auth.ts` inserts `creator` for new users in the same
     change.
   - The last-admin guard covers demotion to **any** non-admin role and disablement, serialized so two concurrent
     changes can't remove the last enabled admin.
2. **Retry and cancel:**
   - Retry spends credits, so it needs Creator or Admin.
   - A demoted author may still **cancel** their own in-flight version (stopping spend), but not retry it (owner
     decision).
3. **One visibility loader:** `loadVisibleJob(repo, principal, id)` returns 404 for private videos the principal
   can't see, **before** any role check, idempotency replay, ETag or 304, file signing, progress, comments, verdicts,
   plans, drafts or preview access.
   - Lists and search filter visibility in SQL inside `listJobs`, before pagination.
   - Webhook payloads use a system-context DTO.
   - Admin and team stats stay admin-only. Personal usage is a separate query.
4. **Files for private videos:** signed URLs stay bearer capabilities, but URLs for private videos are short (10 min)
   and the files edge function rejects a URL issued before the video's last privacy or owner change. The job's
   `accessEpoch` is part of the signature and is bumped on every privacy toggle and transfer. Public publication
   links are unaffected.
5. **The privacy promise is stated plainly in the docs:** Private hides a video in the app among trusted colleagues.
   It isn't confidentiality from Creators, because runs can read project storage (v1 trust model; owner decision).
6. **Private toggles and transfers** bump `jobs.version`, so the ETag changes.
7. **Transfer:**
   - It moves job ownership only, never version authorship, key ownership or usage attribution. It's audited.
   - The target is a Creator or Admin.
   - It works whether the person is disabled before or after the transfer.
8. **Self-approval** is checked against `version.authorId` before any admin shortcut, and only on ready versions.
9. **New spend routes:** edit render and incorporate feedback join the paid-route setup gate. `/plans` instead checks
   Gateway availability and falls back to Create now; it never uses the runner setup gate.

### Webhooks and notifications (R)

10. **The outbox becomes event plus deliveries:**
    - A logical event row, plus one delivery row per destination (per-video API-key webhook, personal, team).
    - Each destination has its own signing secret: per-video uses the key's secret as today; personal is
      `user_webhooks.secret_enc`; team is a settings secret.
    - `api_key_id` becomes nullable. Uniqueness is on (event, destination), with atomic claims.
    - Events and deliveries are inserted with the mutation that caused them, so session-created videos emit events
      too.
11. **At send time,** each delivery re-checks that its recipient can still see the video; dropped deliveries are
    logged (owner decision). **The team webhook receives full details for private videos** (owner decision: admins
    can already see them).
12. **SSRF hardening before more webhook URLs:** pin the validated IP for the connection (keeping TLS hostname checks),
    normalize IPv4-mapped IPv6 in every notation, and test DNS rebinding.
13. **Notifications have their own feed:** a paginated endpoint with a read watermark, polled app-wide while the tab
    is visible (not tied to run polling), with visibility enforced. Comments and verdicts emit their events from
    their own features.

### Planning (B)

14. **Two requests:** `POST /plans` routes and returns `needsQuestions` with suggestions;
    `POST /plans/{id}/questions` generates questions; `POST /plans/{id}/brief` makes the brief.
    - Each has an absolute deadline (route 5 s, questions and brief 25 s), covering SDK retries, the one validation
      retry and persistence.
    - Each caps input and output tokens.
    - On any deadline or Gateway error the panel offers **Create now**.
    - Routing is deterministic around the model: model output is clamped to the allowlist, and defaults apply when
      it's missing.
15. **Accepted plan:**
    - `PATCH /plans/{id}` (with `If-Match`) saves the person's edited brief.
    - Create or revise with `planId` consumes that exact revision **once**, atomically across races.
    - It freezes the verbatim prompt, the accepted brief and Q&A, media hashes, context hash, and the effective length
      and aspect. An accepted length replaces the inherited target on revisions; the aspect must match the job.
    - Revision plans are bound to their job and base version, with visibility re-checked.
16. **Prompt boundary:** every untrusted field (the original prompt, which stays verbatim, and the brief, answers,
    history and captions) is framed with delimiter-safe encoding at the runner handoff, never as raw sections. Nothing
    is silently truncated; oversize input is rejected with a message.
17. **Durable usage:** per-call usage (router, questions, brief, validation retry, failed calls) goes in a
    `gateway_calls` table that outlives plan expiry, keyed by caller.
    - Credits come from provider token prices, including cache tokens, at 180 credits per US$. Estimates are labelled,
      and an ambiguous outcome is recorded as unknown.
    - "My usage this month" queries by caller.

### Editor (C)

18. **The contract is structural, not just a marker:**
    - Stable beat and composition ids. Each beat's GSAP timeline is registered through a defined seek adapter
      (HyperFrames requires registered timelines), with selectors scoped to the beat and no cross-beat references.
    - **All beats sit on one track.** Other tracks may only hold beat-independent layers, such as a background or a
      logo bug. The validator rejects anything else.
    - Conformance is validated, never assumed from `data-va-contract`.
19. **Timing semantics:**
    - Changing a beat's duration time-stretches its timeline. Holds and trims are explicit later options.
    - Caption offsets are beat-relative.
    - Deleting the last remaining beat is refused.
    - Times are quantized to frames (30 fps).
    - `targetDurationSec` becomes a frame-accurate decimal for edited versions, via a migration.
20. **Media slots:**
    - Each slot records its kind (image or video) and box.
    - A swap must match the kind, and gets an explicit fit (cover or contain).
    - A video longer than its beat is trimmed (loop is optional); slot audio is muted.
    - Fonts aren't slots.
21. **Frozen render inputs are version-owned:**
    - Render copies the draft's frozen manifest and bundle into version-owned storage, kept until the version is
      deleted, so retries after draft expiry still work.
    - The hash covers a canonical file manifest: composition files, `summary.json`, and per-media digests from
      `version_media`.
    - The `assets/media/` directory, check caches and render outputs are excluded.
    - `prepare-run` and `render-job` both verify the same manifest.
22. **Template dependencies are local:** GSAP and any other runtime script are vendored into the template's `video/`
    (today it loads GSAP from jsDelivr), so the preview CSP and offline renders work.

### Preview (F0)

23. **Manifest-scoped asset resolution:**
    - The preview page receives one signed capability for the bundle.
    - Relative subresources (CSS `url()`, fonts, nested scenes, `assets/media/*`) resolve through a path-scoped token
      in the URL path, not a query string, so they work without per-file signatures.
    - Media slots map to `/media/{id}` under that capability.
    - **If signed clip playback proves hard in S2, video slots show their poster in the preview** (owner decision).

### Media (E)

24. **Uploads:**
    - One request up to 4 MB, and parts of at most 4 MB.
    - Immutable part index, count and length; a changed duplicate part conflicts.
    - Quota reserved atomically when the session is created.
    - A completion lease, so retried completion can't race assembly or cleanup.
    - The assembly worker receives only the session id.
25. **Verification states:** `uploading` → `verifying` → `ready` or `rejected`.
    - **MP4s are checked at upload completion** with a bounded ffprobe (duration ≤ 2 min, dimensions, H.264 video, AAC
      or no audio) before anyone else can see or pick them. The run's ffprobe is a second line, recording results by
      hash so a bad file never wastes repeated runs.
    - Only `ready` media can be picked. Uploaders see their own pending items.
26. **SVG:**
    - A maintained allowlist sanitizer with bounded parsing.
    - The malicious corpus covers `<use href>`, `foreignObject`, CSS `url()` and `@import`, data: URIs, XML entities,
      and animation-driven link mutation.
    - Separate original and clean keys and hashes. Only the clean copy is referenced; originals are served strictly as
      attachments.
27. **Inheritance:** ordinary revisions and edits inherit the parent's `version_media` snapshot, including soft-deleted
    assets. The hydrated `assets/media/` directory is excluded from archives and rehydrated from snapshots.
    "Used in N videos" counts only videos visible to the viewer.

### Progress (A)

28. **A1's text is the SDK's step text,** not polished narration. The UI says "Working: <step>". Plain-language
    milestones arrive with A2's checkpoints.
