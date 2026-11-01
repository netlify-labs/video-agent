# Phase 0 spike results

Runs started with `spikes/start-run.ts` against project `our internal deployment` on branch `spike/phase-0`
(minimal HyperFrames project + `netlify-agent-kit@0.3.1`). Logs are in `spikes/out-*.log` (not committed).

## S0. Workbench: done (2026-10-30)

- Hello run `<runner id>`: 45 s, 5 steps, **14.4 credits**, default agent Claude (claude-opus-5-5).
- In the run: Node v24.22.2, FFmpeg 7.0.2 static, FFprobe static, `npx hyperframes --version` 0.8.222, clean `git status`.

## S2. Hand-back: option A works (2026-10-30)

Run `s2` (148 s, 36.5 credits):

| Step                                                      | Result                                                               |
| --------------------------------------------------------- | -------------------------------------------------------------------- |
| `netlify blobs:set` 2 MB / 20 MB / 100 MB to a site store | OK in 1.0 s / 1.3 s / 2.5 s (~40 MB/s)                               |
| Write to a second store (`videos`)                        | OK (27 s for the first write: store creation latency, single sample) |
| `blobs:list`, `blobs:get` round trip                      | OK, SHA-256 matches                                                  |
| 100 MB upload killed after 1 s, then retried              | Retry OK                                                             |
| Outbound HTTPS POST                                       | 200                                                                  |

Consequences:

- **Upload mode `blobs` is the default** (`UPLOAD_MODE=blobs`). The signed-upload edge path stays unbuilt unless a deployer needs it.
- Runs can write **any** store on the site, so finalize's hash check against the authenticated callback manifest is load-bearing (already in the design).
- `netlify` isn't on `PATH` in non-interactive shells inside the run. `render-job.ts` and `prepare-revision.ts` resolve the CLI (`netlify`, then `npx -y netlify-cli`, then common global paths).
- Run environment variable **names** include `NETLIFY_AUTH_TOKEN`, `NETLIFY_API_TOKEN`, `NETLIFY_DB_URL`, `NETLIFY_DB_BRANCH`, `NETLIFY_SITE_ID`, `CONTEXT`, `DEPLOY_ID` and 19 `NETLIFY_AGENT_RUNNER_*` variables. Runs get their **own database branch** (`NETLIFY_DB_BRANCH`), confirming that previews and runs never see production writes live.

## S1. From scratch: quality is good; standard quality; ~3–8 minutes per video (2026-10-30)

Three from-scratch runs with the section 5 style prompt (neutral look, no brand context):

| Run | Brief                        | Aspect | Length asked → got | Total run | Credits | `check` rounds | Render (each quality) | File (standard) |
| --- | ---------------------------- | ------ | ------------------ | --------- | ------- | -------------- | --------------------- | --------------- |
| a   | Launch video, "Org webhooks" | 16:9   | Auto → 22.5 s      | 447 s     | 206     | 3              | ~22 s                 | (uploaded)      |
| b   | Sales clip, deploy previews  | 9:16   | 15 s → 15.0 s      | 192 s     | 92      | 1–2            | ~16 s                 | 1.0 MB          |
| c   | Docs tutorial, env vars      | 1:1    | 60 s → 60.0 s      | 405 s     | 192     | 3              | ~35 s                 | 1.5 MB          |

Quality rubric (frames reviewed by hand): text legible at target size, requested text correct, no clipped
frames, coherent three-beat stories with an end card, restrained motion. All three pass. Auto picked a
sensible 22.5 s for a launch clip.

Decisions:

- **Default quality `standard`.** `looks`, `standard` and `delivery` rendered in the same wall-clock time; files are small (1–1.5 MB/min at 1080p), so there's no reason to lower quality. `RENDER_QUALITY` overrides it.
- **Default agent/model: the runner default** (Claude, claude-opus-5-5 at the time). No effort override.
- **Authoring deadline 22 min stays.** A 60 s video took under 7 minutes end to end; render time grows ~0.5 s per output second, so a 3-minute video should fit comfortably (unmeasured; first real 3-minute request will confirm).
- **Credits:** ~90–210 per video in these runs. The admin page shows actual usage per video.
- **Finding:** the agents did not put the JSON block in their final answer (the runner summarizes from a results file). The callback receipt is therefore the primary manifest path and the final-answer fallback is best effort; `render-job.ts` posts the callback with retries.

## S3, S4, S5, S6, S7: answered by the live deployment (2026-10-30)

Production (`our internal deployment`, deploy `f89d1f4` and later) ran `scripts/e2e/phase2.ts` with an API key:
create → v1 ready in **2:51** → signed download + Range → revise to v2 (**ready ~3 min later**, end card changed,
everything else kept) → publish → share page with `og:video` → unpublish → **404 immediately**. PASS in 5.9 minutes.
A second video made by a person through the web app finished too (221 credits).

- **S3 (callback and signals): done.** `render-job.ts` reached the production callback from the run; receipts arrived
  before the session went terminal, as designed; finalize used the receipt. Final answers did not reliably contain the
  manifest block (S1), so the receipt is the primary path.
- **S4 (serving): done for real sizes.** Signed `/files/…` returned `206` with `Content-Range: bytes 100-199/181877`;
  unsigned and expired URLs are refused (`403`); public `/v/{slug}.mp4` HEAD `200`, then `404` right after unpublish.
  Edge functions read the signing secret and publications from the `internal` Blobs store (strong reads), not the
  database. The 20 MB / 100 MB seek-latency measurement is still open; at 1–1.5 MB per minute of video, typical files
  are far below that.
- **S5 (SDK in Functions): done.** `nax-agent-runner-sdk` 0.3.0 bundles in the `api` and `sweep` functions; starts
  happen within one sweep tick (the e2e run went from queued to running in 16 s). Ambiguous-start reconciliation is
  covered by tests with the persisted start request; it has not been triggered in production.
- **S6 (previews and deploy context): mostly done.** The deploy-context guard holds: the published deploy's own
  permalink (`<deploy-id>--our internal deployment/api/health`) returns `404`. Agent-run previews deploy with
  only post-processing in their logs; whether the build command's UI skip ran is not visible there (open, harmless).
  Parallel runs: 3 S1 runs and the S2 run ran concurrently without interference.
- **S7 (Identity): done.** In the catch-all Hono function: sign-up with a `netlify.com` address, email confirmation,
  `getUser()` from the `nf_jwt` cookie, the live `admin.getUser` check, admin bootstrap from `ADMIN_EMAILS`, and API-key
  creation from the session all worked in production. `userValidate` (typed handler in `netlify/functions/identity.ts`)
  is deployed; outside domains are also refused by the API (tested). Invite-only acceptance through the deny-all hook
  is not yet exercised live.

## S8. Deploy button: blocked on a public repo

The button only works from a public GitHub/GitLab repo. Testing it means publishing a fixture copy of this template
publicly, which waits for the owner's decision to open-source (or approval for a throwaway public fixture).
`netlify.toml` already declares `[template.environment]`; `npm run setup` covers the same path from a clone.

## Plan v2 spikes

### S1: AI Gateway for planning calls (2026-10-31, deploy preview of `spike/s1-gateway`, since deleted)

AI Gateway env vars (`ANTHROPIC_*`, `TYPESAFE_*`) are injected in deploy previews and production on our team.

| Call                                                  | Model              | Latency (cold / warm)    | Tokens in / out                              | Notes                                                                                                                 |
| ----------------------------------------------------- | ------------------ | ------------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Router (`systemOne`, 4 choice questions, prompt only) | `jev-1.14.0`       | 0.1–0.3 s                | ~330 / ~60                                   | Typed answers with probabilities                                                                                      |
| Router with the brand/history context added           | `jev-1.14.0`       | 400 Invalid request body |                                              | Context plus 4 questions is rejected; context plus 1 question works. Keep router input to the prompt and short titles |
| Questions (0–6, JSON)                                 | `claude-haiku-4-5` | 7.3 / 6.1–7.2 s          | ~280 / ~900                                  | Valid JSON every run, sensible questions                                                                              |
| Questions                                             | `claude-sonnet-5`  | 16.4 / 15.7–16.0 s       | ~360 / ~1,460 (incl. 330–460 thinking)       | First content block is `thinking`; read the `text` block                                                              |
| Questions                                             | `claude-opus-5-5`  | 14.9 / 11.8–13.1 s       | ~365 / ~1,230–1,500 (incl. 150–350 thinking) | Same `thinking` block                                                                                                 |
| Brief (JSON)                                          | `claude-sonnet-5`  | 9.6 / 5.0–6.2 s          | ~330 / 420–840                               |                                                                                                                       |

Cost at list prices (estimates; 180 credits per US$): router well under 0.1 credit; Haiku questions ≈ 1 credit;
Sonnet questions ≈ 4 credits; Opus questions ≈ 6 credits; Sonnet brief ≈ 2–3 credits.

**Decisions for B:** the router runs on the prompt (plus the person's last titles) only, with snake_case keys and ≤4
questions. Questions default to **Haiku** (≈7 s); the router's `complex` answer escalates to the admin's deep model
(default Sonnet, ≈16 s). The brief uses the deep model (≈5–10 s). Read the first `text` content block. Both stay inside
the 25 s deadline with room for one validation retry on Haiku; Sonnet questions leave no room for a retry, so a retry
falls back to Haiku.

### S2: sandboxed composition preview (2026-10-31, `spikes/s2`, `npx playwright test -c spikes/s2`)

Passes in Chromium and WebKit (8/8): play, pause, seek, click → element id, apply-edits (text only), relative
subresources through one capability (CSS `url()`, `<img>`, vendored GSAP, a nested scene, the MP4 slot with Range),
capability renewal keeping the playhead, expired capability refused, encoded traversal refused. Negative: the
composition can't read `document.cookie` or storage, can't reach the parent, and every request outside its bundle
(`/api/v1/me`, another origin by `fetch`, `<img>` or `<script>`) is blocked by the CSP; forged messages from another
frame and off-channel commands are ignored.

What changed from the plan:

- **No nested `<hyperframes-player>`.** The player drives its composition through `contentDocument`, so it needs
  the composition in the same origin. Inside an opaque-origin sandbox, Chromium gives a `srcdoc` child the parent's
  origin but WebKit gives it a fresh one, and WebKit's `'self'` matches nothing in that child. Instead the
  composition is the sandboxed document: the edge serves `index.html` with the vendored runtime
  (`hyperframe.runtime.iife.js`) injected first and our bridge last. The bridge drives the runtime's
  `window.__player` (`play`, `pause`, `seek`, `getTime`, `getDuration`) and the app draws its own controls. Only the
  runtime is vendored; the player bundle isn't needed (it also tries to load the runtime from jsDelivr).
- **CSP sources are the capability path, not `'self'`:** `script-src <origin>/preview/<cap>/ 'unsafe-inline'`, and
  the same for style, font, img, media, frame and **connect** (the runtime fetches nested scenes). This works in both
  engines and is tighter than `'self'`: a bundle can't load another bundle, the app or `/api`.
- **`Access-Control-Allow-Origin: *` on bundle files:** the sandboxed document's origin is `null`, so nested-scene
  fetches are cross-origin. Bundle files are capability-gated and sent without credentials.
- **The session cookie does reach `/preview/*` requests** (same-site). The page can't read it or send it anywhere,
  so the edge function must authorize by capability only and never vary on cookies (tested: same bytes with and
  without the cookie). A separate preview origin would remove even that; not needed for v1.
- MP4 slots play under the capability (`media-src`, Range), so the poster fallback isn't needed.

### S8: edit round trip on a contract-1 composition (2026-10-31, `spikes/s8`)

A contract-1 fixture (three beats, a background layer on track 1, text, colour roles, an image slot and a video
slot) passes `hyperframes check` and renders. Beats are composition siblings (`data-va-beat` = `data-composition-id`)
registered through a vendored seek adapter, `vendor/va-contract.js` (`vaBeat(id, (tl, el) => …)`): the authored
animations sit in an inner timeline that the registered one time-stretches by `data-duration` /
`data-va-authored-duration`, so a retime needs no script change. Rendered and sampled frame by frame:

| Variant                                                                | Length | What the frames show                                                                          |
| ---------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| base                                                                   | 9.0 s  | intro 0-3, demo (video slot) 3-6, outro 6-9                                                   |
| intro stretched to 4.5 s                                               | 10.5 s | intro holds to 4.5 s, demo from 4.5 s; the intro title fades in 1.5× slower                   |
| reorder (outro before demo)                                            | 9.0 s  | outro 3-6, demo 6-9                                                                           |
| delete demo                                                            | 6.0 s  | outro 3-6, video ends at 6 s                                                                  |
| patcher output (stretch + reorder + text + accent colour + image swap) | 10.5 s | intro to 4.5, outro 4.5-7.5 in the new accent, demo 7.5-10.5; captions moved with their beats |

Findings that shaped contract v1 (`src/lib/contract.ts`, the validator and patcher):

- HyperFrames needs every `<video>` to have an `id` and its own `data-start`/`data-duration` (beat-local); the
  patcher keeps a video slot's duration equal to its beat's (longer clips are trimmed).
- Captions keep beat-relative keyed fields (`beat`, `textId`, `beatStart`, `beatEnd`) next to the absolute
  `start`/`end`/`text` render-job reads; the patcher recomputes the absolute ones (stretched with the beat).
- Times are frame-quantized (30 fps) and written with six decimals.
- Quality: the contract trades range for editability (beats sit back to back on one track; transitions belong to a
  beat, not between beats). A rendered-unchanged run with the canonical manifest is verified by the live editor e2e.

### S4: cost and time of a render-unchanged run (2026-11-01, `scripts/e2e/editor.ts` on production)

| Composition                    | Total (queued → ready) | Run   | Finalize | Credits | MP4    |
| ------------------------------ | ---------------------- | ----- | -------- | ------- | ------ |
| 16 s (retime + text + reorder) | 143 s                  | 133 s | 5 s      | 34.4    | 16.0 s |
| 60 s (every beat stretched)    | 187 s                  | 178 s | 5 s      | 33.6    | 60.0 s |

For comparison, an authoring run on the same video took 4-5 minutes and 240-250 credits. Render-unchanged cost is
flat (the agent only restores, checks and renders; most credits are the run's fixed overhead) and time grows by
about 1 s per extra second of video. The hash-mismatch stop is covered by `test/run-manifest.test.ts` (prepare-run)
and render-job's re-check; the live stop path was seen when a palette colour failed `hyperframes check` contrast:
the run stopped without rendering or editing, as designed.

### S5: upload sessions, MP4 checks and the SVG sanitizer (2026-11-01, `scripts/e2e/media.ts` on production)

| Check                                          | Result                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| One-request upload, 3.9 MB                     | 201                                                                                            |
| 4.4 MB                                         | 400 from the API ("upload in parts")                                                           |
| 6 MB                                           | 413 from Netlify before the function runs (the platform limit sits between 4.4 and 6 MB)       |
| 97.6 MB H.264/AAC clip, 70 s 1080p             | 24 parts of 4 MB, 2.7 MB/s from a laptop, 4 parts in parallel                                  |
| Duplicate / changed duplicate / corrupted part | 200 duplicate / 409 / 400                                                                      |
| Complete with a part missing                   | 409, then resumed from the session's part list                                                 |
| Two completions at once                        | both 202, one item, one assembly                                                               |
| Assembly in the background function            | 13.6 s to ready (join 24 parts, whole sha256, JS MP4 inspection)                               |
| Range playback through `/media`                | 206 at the start and mid-file, bytes match                                                     |
| Quota                                          | 10 × 100 MB sessions reserved, the 11th refused (429); cancelling freed it at once             |
| Malicious SVG                                  | stored, served clean (no script, handlers, foreignObject or external URLs) under a sandbox CSP |

The upload check of clips is JavaScript (box parsing: H.264 sample entry, AAC or no audio, length, size); runs check
again with ffprobe in `prepare-run`. Posters are captured in the browser at upload (owner decision: a poster
fallback is fine).

### S7: render in the browser (2026-11-01, `spikes/s7`, research only)

Three ready videos on production (a 60 s edited version, a 20 s and a 15 s video, all type and motion, no clips),
five frames each. Each frame is compared with the runner's MP4 frame at the same time (SSIM, 1 = identical):

| Path                                                                  | SSIM avg | SSIM min | Cost                                                              |
| --------------------------------------------------------------------- | -------- | -------- | ----------------------------------------------------------------- |
| `cdp`: browser paint (Playwright screenshot after `__player.seek(t)`) | 0.992    | 0.985    | n/a (needs CDP or an extension)                                   |
| `dom`: in-page DOM to image (html-to-image, SVG foreignObject)        | 0.989    | 0.982    | 60-130 ms a frame once warm; 1-2 s for the first (font embedding) |

WebCodecs encoders (H.264, VP9 and AV1 at 1080p30) are available in Chromium and WebKit.

So the answer is "yes for type and motion, with caveats". Seeking the HyperFrames player and grabbing frames is
faithful: SSIM 0.98-0.99 is about what the runner's own H.264 encoding costs. But a page can't screenshot itself, and
the in-page path has known gaps we didn't hit here. It can't draw `<video>` frames (clips would need decoding with
WebCodecs and compositing in a canvas), and it ignores some CSS (backdrop-filter, mix-blend-mode on some
browsers). It also needs every font and image inlined. Its cost is about 100 ms a frame on a laptop, so a 60 s
video at 30 fps takes about 3 minutes plus encoding, which is no faster than a render-unchanged run (S4). The
runner's checks (`hyperframes check`, contrast, render validation) wouldn't run either. A browser render could
serve a quick, unofficial "download draft" for clip-free compositions. It shouldn't replace the runner render. We
are not building it.
