# Plan: storyboards, in-browser editing, pinned feedback, live progress and a media library

Draft 1 (2026-10-31). Builds on [`PLAN.md`](../../PLAN.md) (the v1 spec, all phases shipped except the owner-gated
items). Ideas from the 2026-10-31 idea round that the owner picked: #1 storyboard first, #2 edit without an agent
run, #3 feedback pinned to a moment, #13 uploads, #14 live progress.

## 1. What we're building and why

Today a person writes a prompt and waits 3–8 minutes and 90–210 credits for the first look at the agent's idea. If
the idea is wrong, every fix is another full agent run, and the only way to say what's wrong is free text.

| Feature                             | What people get                                                                                                                                                             | Why it matters                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **A. Live progress**                | While a run works: what it's doing in words ("Writing the end card", "Checking, round 2", "Rendering"), credits so far, and the composition playing live as it's written    | The wait is the worst part of the product; a stage name for 5 minutes feels broken |
| **B. Storyboard first**             | In about a minute, a playable draft: beats with on-screen text and timing, playing in the browser. Edit, re-plan or approve; only approval starts the render                | Catches wrong message, length or tone before paying for a render                   |
| **C. Edit in the browser**          | On a storyboard or a finished version: change text and timing in a form (later: click the text in the preview), see it instantly, then "Render" with no model work          | Typo and timing fixes stop costing a full agent run                                |
| **D. Comments and pinned feedback** | Anyone signed in can pause, click a spot, and leave a comment pinned to that moment. The owner picks comments and presses **Incorporate feedback** to make the next version | Precise revisions from the whole team, not just the author                         |
| **E. Media library**                | A **Media** page to upload logos, screenshots and clips; an **Add media** picker on New video, revisions and storyboards                                                    | Product videos need real product UI and logos                                      |

Non-goals here: audio (va-css.2), templates (va-css.3), spend limits (va-css.4).

## 2. Facts this plan relies on (checked 2026-10-31)

- **HyperFrames plays in the browser.** `hyperframes@0.8.222` (Apache-2.0) ships `dist/hyperframes-player.global.js`
  (113 KB), a `<hyperframes-player>` custom element with `src`/`srcdoc`, `controls`, `poster`, `playback-rate`, and
  play/pause/seek/durationchange events. It also ships the HyperFrames Studio (a browser editor) as a reference.
- **Compositions are attribute-driven HTML.** Clips carry `data-start`, `data-duration`, `data-track-index`; the
  root has `data-composition-id`, `data-width`, `data-height`. Timing edits are attribute edits.
- **The HyperFrames skill ships in the package** at `dist/skills/hyperframes/` (that's where netlify-agent-kit
  installs it from). `SKILL.md` is 7 KB; its references total about 346 KB of Markdown (≈90k tokens), too much to
  send whole on every call.
- **Run progress is already readable.** `nax-agent-runner-sdk` `getSnapshot()` returns, while running, `state`,
  `latestStep` and `usage` (`stepsCount`, `totalCreditsCost`); sessions also carry `currentTask`.
- **AI Gateway in Functions.** Netlify Functions get `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL` (and OpenAI, Gemini,
  OpenRouter) injected automatically, unless the project sets them. Credit-based plans only (the template already
  requires one); needs a production deploy; 200k-token context; billed at 180 credits per US$ of model usage; rate
  limit 450 credits/min (Personal), 1,800 (Pro). Not documented: whether **background** functions get it (spike S1).
- **Existing pieces to reuse:** the `uploads` Blobs store (unused so far), `sources` (each version's composition
  tarball), `prepare-revision.ts` (restores a composition into a run), signed file URLs and the files edge function,
  the run callback with its authenticated report, the per-minute sweep.

## 3. Shared foundation: a safe composition preview

Features A, B and C all play a composition in the app. Compositions are model-written HTML with scripts (GSAP), so
**they must never run on the app's origin**: a script there could read the API with the viewer's session.

- **Preview page:** `GET /preview/{draftOrVersion}?exp&sig` served by an edge function from Blobs, with
  `Content-Security-Policy: sandbox allow-scripts` (an opaque origin even when opened directly), no cookies read, and
  assets (fonts, logos, media) rewritten to short-lived signed URLs. The page loads the vendored player and the
  composition.
- **In the app:** `<iframe sandbox="allow-scripts" src="/preview/…">`. The parent drives it with `postMessage`
  (play, pause, seek, "replace composition" for live edits) and receives time updates and click positions back.
- **Player version:** the build copies `hyperframes-player.global.js` from the pinned `hyperframes` package, so the
  preview always matches the version that renders.
- **Fidelity note shown in the UI:** the browser preview is close but not frame-exact; the MP4 is the truth.

## 4. Feature A: live progress

1. **Narration from the runner:** `GET /api/v1/videos/{id}/progress` returns `{ stage, step, steps, credits,
updatedAt }`. The server calls `getSnapshot` at most every 5 s per run (cached), so many viewers cost one call.
   The web app polls it every 3 s while the page is visible.
2. **Checkpoints from the run:** the prompt asks the agent to run `npx tsx scripts/checkpoint.ts "<what I'm doing>"`
   at milestones (composition drafted, each check round, render started, render %). The script posts
   `{ message, composition? }` to `/api/internal/runs/{id}/checkpoint` with the run's existing callback credential.
   The composition snapshot (index.html + small assets, capped at 2 MB) goes to Blobs as the live draft.
3. **UI:** the stage track keeps its stages, plus a line of narration and a live preview of the latest checkpoint.
   It falls back to the snapshot's `latestStep` when the agent hasn't checkpointed.
4. Checkpoints are best-effort: a failed post never fails the run; finalize ignores them.

## 5. Feature B: storyboard first (AI Gateway)

**Flow:** New video has a **Plan first** switch. With it on, Create makes a version in a new `planning` state. A
background function calls a model through AI Gateway and writes a draft. The video page shows the storyboard (a beat
list plus the live preview), with three actions:

- **Edit:** the Feature C editor.
- **Re-plan:** "change the tone", another Gateway call with the current draft as input.
- **Approve and render:** queues an Agent Runner run that starts from the draft.

**The Gateway call (`storyboard-background` function):**

- **System prompt:**
  - the core `hyperframes` `SKILL.md`;
  - the template's composition rules (size, `data-va-*` marking, see §6);
  - `context/` and, when set, the brand zip (fetched from `BRAND_ZIP_URL` and cached in Blobs by ETag);
  - chosen media as images (vision), with their names and captions.
- **Tools:** `read_reference(name)` serves skill references on demand rather than sending all 90k tokens. `submit({
storyboard, html })` ends the loop. Prompt caching on the static part.
- **Output:** `storyboard.json` (beats: id, start, duration, on-screen text, visual notes) and `index.html`, stored
  as a draft. A static check runs server-side: parse, required attributes, beat timings consistent, total length,
  every asset reference resolvable. Spike S3: can parts of `hyperframes check` run in a function?
- **Model:** an admin setting, default Claude Sonnet. Typical cost to measure in S1; the estimate is roughly 20–60
  credits per plan, and the actual cost is shown on the storyboard.

**Approval:** the run gets the draft through `prepare-revision`'s path (restore a composition). It's told to keep the
approved text and timing, fix only what `hyperframes check` or rendering requires, and render. The agent still owns
the final, verified MP4, so quality and the finalize checks are unchanged.

**States:** `planning` → `plan_ready` (no queue slot held) → `queued` on approval. Unapproved plans expire after 7
days. `plan_failed` offers Try again, or Skip planning, which goes straight to a normal run.

**Fallback:** with no AI Gateway (Enterprise plans, or a disabled setting), Plan first is hidden and everything works
as today. Setup reports it.

## 6. Feature C: edit in the browser, render without the model

- **Marking:** the skill addendum requires every on-screen text node to carry `data-va-text="<id>"` and every beat
  clip to carry `data-va-beat="<id>"` (it already has `data-start`/`data-duration`). The runs prompt asks for the
  same, so finished versions are editable too.
- **Editor (step 1):**
  - A beat timeline: drag to resize, number inputs for seconds.
  - Text fields per `data-va-text`.
  - Edits apply to the composition in memory and stream to the preview via `postMessage`, with no network round trip.
  - Saving creates a draft. Changing the duration of beat _k_ shifts later clips by the same delta.
- **Editor (step 2):** click text in the preview to edit it in place. The preview page reports the clicked
  `data-va-text`; HyperFrames Studio's selection client is the reference.
- **Render only:** "Render" queues a run in **render-only** mode. The prompt says: "Restore this composition, change
  nothing, run `hyperframes check`, render". The runner still costs something, but far less than an authoring run;
  S4 measures it. Rendering can't run in Functions (Chrome and FFmpeg).
- **On finished versions:** **Edit** loads that version's composition from `sources`; saving makes vN+1, labeled
  "edited by Ada from v2".

## 7. Feature D: comments, pinned feedback, incorporate

- **Data:** `comments` (id, videoId, versionN, authorId, body, timeSec?, x?, y? (0–1), frameKey?, createdAt,
  resolvedAt, resolvedBy, addressedInN?).
- **Pinning:** on a ready version, pause and click the frame, then type. The client grabs the frame from the `<video>`
  to a canvas (same-origin signed URL, so the canvas isn't tainted) and uploads it as a JPEG. Markers show on the
  progress bar and as dots on the frame; clicking a comment seeks there.
- **Who:** everyone signed in can comment and read comments. Authors and admins can delete; the video owner and
  admins resolve. The owner gets an in-app notification badge.
- **Incorporate feedback:** the owner (or anyone, as a revision, matching today's "anyone can revise") selects open
  comments and presses the button. It builds a revision whose prompt lists each comment with its timestamp,
  position and author, and attaches the frame stills (downloaded into `video/feedback/` by `prepare-revision`).
  When the version is ready, those comments are marked "addressed in vN+1".
- **MCP:** `list_comments`, `add_comment`, and `revise_video` accepting `comment_ids`.

## 8. Feature E: media library

- **Media page** in the nav:
  - a grid with name, type, size, uploader and "used in N videos";
  - drag-and-drop upload;
  - an optional caption ("our dashboard, dark mode"), which the model sees;
  - delete by the uploader or an admin (soft delete; old versions keep working because runs copy the bytes).
- **Storage:** the `media` Blobs store; `media` table (id, name, caption, mime, bytes, sha256, width, height,
  durationSec, uploadedBy, createdAt, deletedAt). Types: PNG, JPEG, WebP, GIF, SVG, MP4. The size cap is an
  owner decision, proposed at 25 MB for images and 200 MB for video.
- **Upload path:** functions take at most about 6 MB per request, so uploads go in parts
  (`POST /media` → `PUT /media/{id}/parts/{n}` → `POST /media/{id}/complete`, which verifies the sha256). Spike S5:
  can an edge function stream a whole file to Blobs instead?
- **Safety:** sniff the type from the bytes; an SVG is served only as an attachment or inside the sandboxed preview;
  files are never served from the app origin as active content.
- **Add media:** chips on New video, Revise and the storyboard editor. Runs get signed URLs; `prepare-revision`
  (renamed `prepare-run`) downloads them into `video/assets/media/` and verifies hashes. The prompt lists each file
  with its caption. The storyboard call sends images as vision input.

## 9. Changes to existing pieces

| Area       | Change                                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data       | Version states `planning`, `plan_ready`, `plan_failed`; version `mode` (`author`, `render_only`); tables `drafts`, `comments`, `media`, `version_media`; `checkpoints` in Blobs |
| API        | `/progress`, drafts (get, put, approve, re-plan), comments CRUD, media upload parts, `mediaIds` on create and revise, internal `/checkpoint`                                    |
| Runs       | `scripts/checkpoint.ts`; `prepare-run` for drafts, media and feedback stills; render-only prompt; `data-va-*` rules in the prompt                                               |
| Edge       | `/preview/*` sandboxed page; the files edge function also serves media and frame stills                                                                                         |
| Settings   | Storyboard model; Plan-first default (on or off)                                                                                                                                |
| Setup page | AI Gateway available?                                                                                                                                                           |
| MCP        | `plan_video`, `approve_plan`, comment tools, media ids on create and revise                                                                                                     |

## 10. Order of work

```
S1–S6 spikes ──┬─► F0 sandboxed preview ──┬─► A live progress
               │                          ├─► B storyboard ──► C editor + render-only
               └─► E media library ───────┴─► (B and D use media when present)
                                              D comments + incorporate (needs F0 for pinning UI only)
```

Value per effort: A first (small, visible to everyone), then B with C, then D, then E. E can run in parallel once
the spikes are done.

## 11. Spikes

| #   | Question                                                                                                                                                    | Done when                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| S1  | Does a background function get AI Gateway env vars? Latency and credits for one storyboard with Sonnet (skill + context + brand, prompt caching on and off) | A measured call from production with credits       |
| S2  | Can `<hyperframes-player>` run inside a CSP-sandboxed, opaque-origin page with fonts and assets loaded from signed URLs, and accept `postMessage` control?  | A preview page plays a real composition in the app |
| S3  | What can validate a composition inside a Function (static parts of `hyperframes check`, or our own lint)?                                                   | A list of checks with timings                      |
| S4  | Time and credits for a render-only run on a 15 s and a 60 s composition                                                                                     | Measurements in SPIKES.md                          |
| S5  | Largest upload path that works: edge function stream to Blobs, or chunked function parts                                                                    | A 150 MB MP4 uploaded and hash-verified            |
| S6  | Do Gateway-written compositions (with `data-va-*`) render cleanly when the approval run "changes nothing"?                                                  | 5 prompts across formats, pass rate recorded       |

## 12. Risks

- **Model-written HTML in the browser:** mitigated by the sandboxed opaque origin, CSP, no cookies, and signed asset
  URLs. A security test asserts that preview pages can't read `/api/*` with the viewer's session.
- **Preview ≠ render:** the UI labels it; approval runs `hyperframes check`; S6 measures drift.
- **Gateway drafts that don't render:** the approval run may fix them (it's still an agent); S6 decides whether
  plans need a tighter lint.
- **Cost surprises from re-planning:** each plan and re-plan shows its credits; admins see Gateway spend in usage.
- **Uploads as an attack surface:** type sniffing, size caps, SVG isolation, and soft delete with an audit trail.
- **Skill drift:** the storyboard prompt reads the skill from the pinned `hyperframes` package, the same version the
  runs use.

## 13. Owner decisions needed

1. Plan first on by default, or opt-in?
2. Storyboard model default (Sonnet suggested); may admins pick Opus?
3. Who may press Incorporate feedback: the owner only, or anyone (like revisions today)?
4. Media: team-wide library (proposed) or per-person? Size caps?
5. Notifications for new comments: an in-app badge only (proposed), or also browser notifications and webhooks?
