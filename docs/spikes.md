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

### S9: voice providers (2026-11-01, one Agent Runner run and four draft deploys, since deleted)

**Runner (run `6ae78a43e2327820c2eebd42`, session `6ae78a43e2327820c2eebd44`, 100 s, 16.1 credits, nothing changed):**

| Check                                        | Result                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Image                                        | Ubuntu 24.04.5, x86_64, 4 CPUs, 15.6 GB RAM, 45 GB free in `~`                                   |
| Python / pip                                 | Python 3.14.3, pip 26.0.1 (mise); `git`, `cmake`, `gcc`, `make` present; no `uv`, no `espeak-ng` |
| `pip3 install --user kokoro-onnx soundfile`  | **7.2 s** (kokoro-onnx 0.4.7, onnxruntime 1.31.1); no externally-managed-environment error       |
| First `npx hyperframes tts` (model download) | **8.1 s** for 4.2 s of speech (af_heart); `~/.cache/hyperframes` grows to 599 MB                 |
| Second `tts`, model cached                   | **2.3 s** for 2.4 s of speech (about real time on 4 CPUs)                                        |
| Output                                       | WAV, ~48 KB per second of speech; ffprobe length matches the `--json` `durationSeconds`          |
| `npx hyperframes transcribe --model tiny.en` | **Fails at once**: `whisper_unavailable` (suggests `hyperframes models install parakeet`)        |

So Kokoro costs about 15 s the first time in a run (install + model) and about real time per line after that, only
in runs that use a voice. Word timings don't come from the runner: Kokoro returns none and `transcribe` has no engine
there (Parakeet's install time is unmeasured; whisper.cpp would be built from source).

**AI Gateway (draft deploys `6ae78a61…`, `6ae78a7e…`, `6ae78aa1…`, `6ae78ae6…` of this project, deleted after):**
draft deploys do get the Gateway variables (`OPENAI_*`, `ANTHROPIC_*`, `GEMINI_API_KEY`, `GOOGLE_GEMINI_BASE_URL`,
`TYPESAFE_*`, `NETLIFY_AI_GATEWAY_*`, all pointing at `/.netlify/ai`).

| Call through `/.netlify/ai`                                                   | Result                                                                     |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `POST /chat/completions` (gpt-4o-mini, control)                               | 200 in 0.5 s                                                               |
| `POST /audio/speech` (gpt-4o-mini-tts, tts-1), also under `/v1` and `/openai` | **404** (HTML page)                                                        |
| `POST /audio/transcriptions` (whisper-1, gpt-4o(-mini)-transcribe), multipart | **400** "Invalid Content-Type header value, must contain application/json" |
| Chat completions with audio output (gpt-4o-mini-audio-preview)                | **400** "not a valid model ID"                                             |
| Gemini TTS (gemini-2.5-flash-preview-tts, gemini-3.8-flash-tts)               | **400** "unable to find suitable provider" (`unknown_model`)               |

The Gateway has no speech or transcription path today, so server-side TTS through it isn't possible.

**Decision:**

- **Generate the voice in the run**, with `scripts/voice.ts` behind a `VoiceProvider` interface: **Kokoro** (`npx
hyperframes tts`, free, installed on demand only when a video has a voice-over) by default; **ElevenLabs** when the
  deployer sets `ELEVENLABS_API_KEY` (site variables reach runs), using its with-timestamps endpoint for exact word
  times. Gateway OpenAI TTS is out until the Gateway proxies `/audio/speech` (re-check then; the interface takes it
  as a third provider). A direct OpenAI key isn't offered: `OPENAI_API_KEY` is the Gateway's own variable.
- **Timings without transcription:** the script speaks each caption phrase as its own clip and joins a beat's phrases
  with measured pauses, so every caption cue starts and ends exactly where its audio does (sample-accurate). Word
  times inside a phrase come from the provider when it has them (ElevenLabs) and are otherwise spread by letters
  (marked `estimated`), good enough for a highlight, never used for cue boundaries.
- Voice files are files the agent made (`video/assets/voice/`), so the source archive and frozen edit bundles keep
  them like any composition file; a revision reuses each beat's audio while its line, voice and speed are unchanged.

## Voice-over spikes

### S10: browser sync and capture harness (2026-11-03, `spikes/s10`, `spikes/s10/make-media.sh && npx playwright test -c spikes/s10`)

One instrumented page (no app integration), served by `spikes/s10/server.ts`. The server type-strips the TypeScript
with Node's `stripTypeScriptTypes`, so the spike adds no bundler and no dependency. It reuses `src/lib/peaks.ts` and
`timeline.ts` unchanged.

- **Media** (`make-media.sh`, generated, git-ignored): H.264 30 fps MP4s of 30 s and 10 min. Each is black with a
  white flash for 3 frames at 1 s and then every 4 s, plus a 15-bit binary frame counter. Each has a 48 kHz WAV
  stem: a quiet 220/330 Hz bed plus 50 ms 2 kHz beeps that start on the flash frames to the sample. There is also
  `fake-mic.wav`, with a beep every 2.000 s.
- **Picture:** a `<video muted>` with `requestVideoFrameCallback` anchors `(mediaTime, expectedDisplayTime)`.
- **Clocks:** the page keeps three maps onto `performance.now()`. The picture map comes from the rVFC anchors. The
  render map pairs `(currentTime, perf)` at the first sight of each new `currentTime`, and input samples go through
  it. The output map comes from `getOutputTimestamp()` and schedules the monitor. `outputLatency` is never added to
  `getOutputTimestamp()`; it is used only in the labelled fallback when that call is missing.
- **Monitor:** the stem plays in the same single `AudioContext`, positioned from the anchors through the output map.
- **Capture:** `getUserMedia` (EC/NS/AGC configurable, default all off) → `AudioWorkletNode` (2,048-frame
  transferable blocks with their `currentFrame`, posted straight to the worker over a `MessagePort`) → worker. The
  worker does gap fill, a streaming **windowed-sinc polyphase resample** to 24 kHz (Blackman, 16 zero crossings,
  cutoff 0.45 × the lower rate, a 256-phase table with linear interpolation between phases, exact integer timing),
  `PeaksBuilder`, an onset detector, PCM16 encoding, a **streaming SHA-256** (our own; `lib/sha256.ts`), and an
  IndexedDB write per 0.5 s chunk **from the first chunk**. Each write updates a take record with the running PCM
  hash. A MediaRecorder runs on the same stream for comparison.
- **Fit:** `t = a + b·sample` by least squares over every anchor, reported as RMS and max residual and slope in
  ppm. The take stops on: residual above the threshold (default 10 ms) for 3 consecutive anchors, slope beyond the
  tolerance, `seeking`, `waiting` or a frame gap over 300 ms (stall), a hidden tab, `devicechange`, or track
  `ended`. The report keeps the clean sample count.
- **Measurement and calibration:** beeps or claps in the take are matched to the nearest flash, and the report
  gives the start, middle and end offset error raw and with each calibration. The calibrations are (a) 8 scheduled
  clicks through speakers: input latency = render-map time of the captured onset − output-map time of the click;
  (b) 8 claps on the flashes, robust mean with outliers dropped; (c) a manual slider.
- **Stress:** memory (`measureUserAgentSpecificMemory`, else `performance.memory`); stop → file hash → assemble from
  IndexedDB → POST `/upload`, which re-hashes; recovery after a reload; a 32-take audition under a 200 MB decode
  budget (10 s windows, 30 s ahead and 5 s behind the playhead, LRU).
- **Reports and checklist:** every report is downloadable and POSTed to `spikes/s10/out/<ts>-<kind>.json`.
  `analyze.ts` prints the tables (`--markdown` for this file). `spikes/s10/CHECKLIST.md` is the owner run.

**Automated results** (Playwright 1.64, Chromium 156 Chrome for Testing, headless, macOS, context 48 kHz). The mic
is **synthetic**. Chromium's `--use-fake-device-for-media-stream` (with `--use-file-for-fake-audio-capture`) never
resolves `getUserMedia` on this agent host, headless or headed, even with `--use-fake-ui-for-media-stream` and the
microphone permission granted. The browser log shows the fake device opened and the stream started, and the
renderer promise still hangs. So the page loops `fake-mic.wav` through a `MediaStreamAudioDestinationNode`, and
everything from `MediaStreamAudioSourceNode` on is the real path. The flags remain in the config (`S10_MIC=device`)
for a host where they work. Headless rVFC timestamps have no real vsync, so residuals here show only the pipeline's
own error.

| Check                                                                                        | 30 s take                     | 10 min take (`S10_LONG=1`, full 600 s)         |
| -------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------- |
| Captured samples = `ceil(frames × 24000 / 48000)`                                            | 720,128 = 720,128             | 14,400,256 = 14,400,256                        |
| Fill-in / no-input quanta                                                                    | 0 / 0                         | 0 / 0                                          |
| Worker file SHA-256 = one-shot SubtleCrypto of the assembled WAV = server's                  | yes                           | yes                                            |
| Streamed PCM hash = one-shot; running hash in the IndexedDB record                           | yes; yes                      | yes; yes                                       |
| Peaks (level 0 bins = ceil(samples / 1024); max diff vs recompute)                           | 11 levels, 704 bins; 0        | 15 levels, 14,063 bins; 0                      |
| Pipeline consistency: captured beep spacing vs the file's 48,000 samples                     | 14 intervals, 0 samples error | 299 intervals, 0 samples error                 |
| Stop → worker done (flush + writes + file-hash pass)                                         | 92 ms (file hash 61 ms)       | 171 ms (file hash 164 ms, 28.8 MB)             |
| Stop → uploaded (adds assemble from IndexedDB + POST to localhost)                           | 207 ms                        | 285 ms (604 ms in a 22 MB run)                 |
| IndexedDB write per chunk p50 / p99 / max, max pending                                       | 5.8 / 26 / 26 ms, 2           | 0.35 / 18 / 38 ms, 2                           |
| Fit residual RMS / max; slope                                                                | 0.002 / 0.005 ms; +31.7 ppm   | 8.9 / 18.5 ms; −43 ppm (one-frame step, below) |
| Render map residual RMS / max                                                                | 1.5 / 3.0 ms                  | 1.5 / 3.1 ms                                   |
| Output latency implied by `getOutputTimestamp` vs reported `outputLatency + baseLatency`     | 30.2 vs 32.3 ms               | 30.2 vs 32.3 ms                                |
| Monitor vs picture, mean / max                                                               | −0.5 / 1.0 ms                 | +1.9 / 20.6 ms (drift, below)                  |
| MediaRecorder (webm/opus, 129 kbps): `start` event / decoded sample 0 on the take's timeline | +53 ms / +4.8 ms              | +58 ms / +13.5 ms                              |
| Memory during the take (`measureUserAgentSpecificMemory`)                                    | 1.7 MB                        | 2.2 MB at 48 s → 5.5 MB at 587 s               |

| Other automated check                                                                                                        | Result                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stop conditions (simulated at about 3 s: seek, hidden tab, `devicechange`, track `ended`, residual with a 0.01 ms threshold) | each stopped with its own reason; clean part about 72,500 samples                                                                                             |
| Recovery after a reload at about 5.5 s                                                                                       | 132,000 samples (11 chunks) recovered, running hash matches, clock record has 120 anchors and a fit, 3 ms                                                     |
| Audition: 32 × 10-min takes, 8 active, 200 MB                                                                                | peak 199.6 MB (decode-all would be 1,758 MB); 1,400 window decodes at 2.2 ms; 1,182 evictions; JS heap peak 204 MB (Chromium counts AudioBuffers in the heap) |
| Resampler (2 s of 1 kHz + 15 kHz, 48 and 44.1 kHz in)                                                                        | −91 dB error against the ideal 1 kHz, so the 15 kHz tone is gone; the count is exact; block-wise = one-shot                                                   |
| Onset detector on synthetic 2 kHz beeps                                                                                      | +1 sample (0.04 ms) late, every time                                                                                                                          |
| Calibration code paths (a), (b)                                                                                              | run; the numbers are meaningless with a synthetic mic: (a) hears no clicks, and (b)'s "claps" are file beeps                                                  |

**API matrix** (Playwright browsers; real Safari and Firefox are in the owner checklist):

| API                                                     | Chromium 156                | WebKit 27.2 (Playwright) | Firefox |
| ------------------------------------------------------- | --------------------------- | ------------------------ | ------- |
| `requestVideoFrameCallback`                             | yes                         | yes                      | not run |
| `getOutputTimestamp`                                    | yes (live values)           | yes (live values)        | not run |
| `outputLatency` / `baseLatency` (headless, fake output) | 27.0 / 5.3 ms               | 15.6 / 2.7 ms            | not run |
| AudioWorklet, module Worker, IndexedDB                  | yes                         | yes                      | not run |
| MediaRecorder types                                     | webm opus/pcm, mp4 aac/opus | webm opus, mp4 aac/opus  | not run |
| `measureUserAgentSpecificMemory` / `performance.memory` | yes / yes                   | no / no                  | not run |
| `AudioContext.setSinkId`                                | yes                         | no                       | not run |
| Storage quota                                           | 10,240 MB                   | 1,000 MB                 | not run |

Playwright's Firefox build (firefox-1555) isn't installed on this machine and wasn't installed for this spike, so
the config adds the Firefox and WebKit projects only when their executables exist.

What this changes or tells the plan:

- **Schedule the monitor from about 10 anchors, not the first.** Frames just after `play()` are presented late.
  Scheduling from the third anchor put the monitor 28.8 ms off for the whole take. The median of
  `mediaTime − expectedDisplayTime` over 10 anchors (about 0.5 s) brings it to −0.5 ms.
- **The picture and audio clocks drift about 33 ppm apart** (headless; every run). The fit's slope absorbs this for
  the take. The monitor doesn't: it drifted to 18–21 ms within 8–10 minutes and never reached the one-frame
  resync. Phase 3 needs a resync at about half a frame, or a `playbackRate` trim on the video. The owner run
  measures the real-hardware ppm.
- **One-frame steps in the anchors.** In all three 10-minute runs, the anchors stepped by exactly one frame
  (−33.3 ms) and stayed there, at 388 s, 459 s and 496 s: the picture lost a frame against the audio clock. With
  the stop rule, two runs stopped at 459 s and 496 s. Fitted as one line across the step, the third run had a
  residual RMS of 8.9 ms and a slope of −43 ppm. A single global line can't represent this. The options are to stop
  there (the plan, losing the rest of the take) or to fit piecewise, splitting where 3 or more consecutive anchors
  sit at a steady whole-frame offset. Whether real Chrome, Safari and Firefox step like this is in the owner run.
- **Chromium's worklet `currentFrame` glitches**: 2 to 29 times per run it reported one quantum low and then skipped
  a value (F−128, F−128, F+128) while the data stayed continuous. The worker trusts the block count and fills only
  real gaps of more than 2 quanta. Sample counts matched in every run.
- **The streaming hash covers the PCM, not the file.** SHA-256 of a WAV can't be streamed during a take, because
  the 44-byte header holds the length and comes first. The worker streams SHA-256 over the PCM and, at stop, hashes
  header + chunks read back from IndexedDB in 64-chunk batches: 164 ms for 10 minutes. Per-chunk gets cost 2–4 ms
  each, so batch them. The `uploadFile` option can take that file hash.
- **Worklet, not MediaRecorder.** MediaRecorder's `start` event comes 53–58 ms after `start()`, and its decoded
  sample 0 lands 4.8–13.5 ms after the worklet take's start, varying by run. It has no sample index, it is lossy,
  and it keeps the whole blob in memory (9.7 MB of Opus for 10 minutes). The worklet path is exact (sample
  counts, beep spacing) and bounded.
- **Memory is small.** Memory during a 10-minute take stays at 2–6 MB. The growth (about 0.37 MB a minute) is
  the harness's anchor log. The audition budget holds at 200 MB against 1.76 GB for decoding every take.

**Firefox** (2026-11-03, Playwright Firefox 157, headless, mock build, the record-flow take). Takes stopped about 2 s
in with `residual` ("3 anchors beyond 10 ms, worst 157 ms"), intermittently, whenever the main thread was busy; a
page script blocking it 30-60 ms every 100 ms reproduces it every time. What the anchors look like:

- The steady anchors are very clean: `mediaTime − expectedDisplayTime` holds to ±0.7 ms (0.01 ms resolution,
  although `performance.now()` itself is 1 ms here).
- But in up to one callback in five (12 of the first 63; 4-24 per 9 s under load) rVFC reports a **lookahead**: a
  `mediaTime` 8-12 frames (233-400 ms) ahead of the steady offset, with `presentedFrames` jumping by as many (13 → 23),
  one or two in a row, and the next callback back on the steady offset with an earlier `mediaTime` (0.733 then
  0.600). Firefox reports a queued frame, not the one on screen. Chromium never does this.
- The fit's warm-up (60 anchors, unchecked) took them in: the least-squares line sat ~77 ms off, so the first checked
  good anchors all breached and the take stopped.
- `getOutputTimestamp` works, but its `performanceTime` is `now − outputLatency` (21.9 ms) and `contextTime` trails
  `currentTime` by the same amount, so the output map comes out equal to the render map (the monitor's concern, not
  the take's fit).

What changed: `PictureClock` holds each anchor back three callbacks (`LOOKAHEAD_HOLD`) and drops any anchor whose
`mediaTime` is later than a newer one's (`lookaheadAnchors`). The picture monitor, the online fit and the final fit
only see the rest, and `TakeFit.lookaheads` counts the dropped ones. A forward-playing picture never shows a frame and
then an earlier one, so the rule doesn't depend on the browser. `anchors` and the anchor listeners still get every
anchor at once, because the stem monitor and the teleprompter take medians over them and need no delay. As a second
guard, the fit's warm-up is trimmed when it fills: anchors more than the residual limit from the warm-up's median
offset leave the fit as outliers. The residual limit (10 ms), the step rule and the slope rule are unchanged, and a
15 ms drift or a 2500 ppm slope still stops a take with lookaheads in it (unit tests). Firefox's `presentedFrames`
jumps still count as skipped frames, so `skippedFrames` overstates Firefox's real frame loss.

#### Pending: owner hardware matrix (`spikes/s10/CHECKLIST.md`)

The checklist runs Chrome, Safari and Firefox on macOS, about 28 minutes per browser, with built-in, USB and
Bluetooth inputs on speakers, wired headphones and Bluetooth headphones. It covers calibrations (a) ×3, (b) ×2 and
(c), a 10-minute loopback take, earcup-on-mic loopback for headphone routes, hidden-tab, reload-recovery and
unplug stops, and the audition run. Then `npx tsx spikes/s10/analyze.ts --markdown` replaces this list. The run
settles:

- **The calibration default:** (a) speaker loopback reused for headphones on the same input, (b) clap-on-flash, or
  (c) manual. Chosen from repeatability (sd and range per route) and from how far (b) − (a) moves on headphone
  routes.
- **The residual-stop threshold** (proposal 10 ms; the largest residual over clean real-hardware takes), plus
  whether one-frame anchor steps happen on real browsers and so whether the fit must be piecewise.
- **Qualified setups for the ≤ 1 frame promise:** every browser and route whose start, middle and end errors stay
  within 33.3 ms, and the 10-minute drift per browser.
- Real `getOutputTimestamp` and `outputLatency` behaviour on Bluetooth routes, Safari's and Firefox's memory and
  MediaRecorder numbers, and whether any supported browser fails muted-MP4 mode (the only trigger for the iframe
  fallback).

### S13: speech cleanup chain, light and off (2026-11-03, `spikes/s13`, `npx tsx spikes/s13/run.ts [--sweep]`)

Eight synthetic takes in `test/fixtures/narration/` (macOS `say` voices degraded with ffmpeg: quiet laptop, noisy
room with a 120 Hz fan, hot USB mic, near-clipping, harsh sibilant headset, silence-only, and a quiet/loud punch
pair; how each was made is in its README). No real recordings: they need consent, and the A/B listening with the
owner that the bead asks for is still to do, so the parameters were tuned by measurement only and kept
conservative. `scripts/lib/narration-cleanup.ts` measures the raw take (an energy speech gate on the 150 Hz-5 kHz
band, BS.1770 gated loudness of the speech regions, which matches ffmpeg's ebur128 within 0.1 LU, and the RMS of the
gaps), runs the chain once without the trim to measure it, then once with the trim. ffmpeg runs with `-threads 1
-filter_threads 1` and bitexact output. Gaps, speech loudness and 4-9 kHz energy are measured on the raw take's
regions; the output is sample-aligned with the input.

**v1 light chain** (`cleanupFilter` in `src/lib/narration-cleanup.ts`):

```
highpass=f=80,
apad=pad_len=600, afftdn=nr=12:nf=<gap RMS + 10, clamped -80..-20>:tn=0, atrim=start_sample=600, asetpts=N/SR/TB,
volume=<pre>dB,           # speech to -24 LUFS (limits -12..+24 dB)
deesser=i=0.4:m=0.5:f=0.5:s=o,
acompressor=threshold=0.063096(-24 dBFS):ratio=2:attack=10:release=120:knee=4:makeup=1:detection=rms,
volume=<trim>dB           # speech to -18 LUFS, held so the true peak stays at or under -1 dBTP (limits ±12 dB)
```

`off` is a true bypass: no ffmpeg, the take's bytes are used as they are.

**Results, ffmpeg 9.0.2** (light; speech loudness on the raw take's speech regions; SNR = speech LUFS minus gap RMS):

| Take             | Raw speech / TP         | Light speech / TP | Gap floor raw → light | SNR change | 4-9 kHz change | Pre / trim (dB) |
| ---------------- | ----------------------- | ----------------- | --------------------- | ---------- | -------------- | --------------- |
| quiet-laptop     | -40.5 LUFS / -24.9 dBTP | -18.0 / -3.9      | -78.9 → -67.0         | +10.6      | +2.1           | +16.5 / +9.6    |
| noisy-room       | -23.2 / -6.7            | -18.0 / -1.2      | -53.2 → -55.4         | +7.4       | +0.4           | -0.8 / +9.9     |
| usb-hot          | -15.2 / -1.4            | -18.0 / -4.2      | -84.3 → -90.3         | +3.2       | +0.5           | -8.8 / +9.6     |
| near-clip        | -7.5 / +2.0             | -18.0 / -6.6      | -73.9 → -85.2         | +0.8       | -2.3           | -12.0 / +7.0    |
| sibilant-headset | -22.6 / -8.4            | -18.0 / -4.8      | -69.2 → -70.9         | +6.3       | **-5.3**       | -1.4 / +10.8    |
| punch-quiet      | -38.1 / -21.4           | -18.0 / -2.2      | -75.4 → -66.4         | +11.1      | +2.7           | +14.1 / +10.0   |
| punch-loud       | -18.6 / -1.0            | -18.0 / -1.7      | -76.6 → -84.7         | +8.7       | +2.7           | -5.4 / +10.3    |
| silence-only     | no speech               | no gain, warning  | -76.3 → -90.4         | n/a        | n/a            | 0 / 0           |

| Check                                       | Result                                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Sample count, input = output                | equal on all 8 takes, light and off (e.g. noisy-room 251,819 → 251,819); `cleanTake` throws otherwise    |
| Time shift (cross-correlation, ±2,000)      | 0 samples (three takes -1: the high-pass's phase); a click at 1.000 s and 3.000 s lands on the sample    |
| Same-run determinism (process twice)        | identical PCM sha256 on all 8 takes                                                                      |
| `off`                                       | PCM sha256 equals the input's on all 8 takes                                                             |
| ffmpeg 6.0 (2023 static build) vs 9.0.2     | same graph, **identical PCM sha256** on all 8 takes                                                      |
| Punch pair                                  | 19.5 LU apart raw, 0.0 LU after                                                                          |
| Wall time (two chain passes + measurements) | 0.1-0.3 s per 4-11 s take on an M-series laptop (about 2.5% of real time, so ~15 s for a 10-minute take) |

**Tuning (sweep over the 7 speech takes, `--sweep`):**

| Variant                                 | SNR change avg / worst | 4-9 kHz avg / headset | Speech target error max | Peak-limited takes                  |
| --------------------------------------- | ---------------------- | --------------------- | ----------------------- | ----------------------------------- |
| **v1 light**                            | +6.9 / +0.8 dB         | +0.1 / -5.3 dB        | 0.0 LU                  | none                                |
| Plan order (gain only at the end)       | +5.7 / -6.6            | -2.6 / -6.2           | 10.6 LU                 | none                                |
| afftdn nf = gap RMS (+0)                | +2.4 / -2.6            | +0.3 / -5.3           | 0.0                     | none                                |
| afftdn nf = gap +15                     | +8.2 / +4.0            | -0.1 / -5.3           | 0.0                     | none                                |
| afftdn nf -50 (its default, unmeasured) | +8.1 / +2.6            | -0.5 / -5.3           | 0.0                     | none                                |
| afftdn nr 6 / nr 20                     | +2.8 / +10.6 avg       | +0.1 / -5.3           | 0.0                     | none                                |
| De-esser off / 0.3 / 0.5 / 0.6          | +7.3 … +6.5 avg        | +2.1 … -5.6 / 0 … -12 | 0.0                     | none                                |
| Compressor peak detection               | +7.3 / +1.1            | 0.0 / -5.4            | 0.3                     | noisy-room, punch-loud              |
| Pre-target -20 LUFS (more compression)  | +5.1 / +0.8            | -0.8 / -7.8           | 0.0                     | none                                |
| Speech target -16 LUFS                  | +6.9 / +0.8            | +0.1 / -5.3           | 1.7                     | noisy-room, punch-loud, punch-quiet |

So:

- **The plan's chain works with three changes, all inside "S13 tunes these defaults":**
  1. **afftdn delays its output by 600 samples** (a quarter window, 25 ms at 24 kHz; the same in 6.0 and 9.0)
     while keeping the sample count, so it silently drops the last 25 ms and shifts the take. The graph pads 600
     samples at the end and trims them from the front (`AFFTDN_DELAY`, checked with a click test in
     `test/narration-cleanup.test.ts`). That trim removes the filter's latency, not content.
  2. **Per-take gain is split**: most of it goes before the de-esser and compressor (speech to -24 LUFS, the
     compressor's threshold), so every take is de-essed and compressed alike. With gain only at the end, a quiet
     laptop take passes the compressor untouched and the ±12 dB trim can't reach the target (10.6 LU short),
     while a hot take is squashed. A trim after the compressor sets the final level (+7 to +11 dB here: 6 dB
     from -24 to -18 LUFS plus the compressor's ~4 LU).
  3. **Speech target -18 LUFS** (gated, speech regions), not -16: speech peaks run about 14.5 dB over its loudness
     after the chain, so -16 hits the -1 dBTP ceiling on 3 of 7 takes and misses by up to 1.7 LU. **For S12:**
     with that peak-to-loudness ratio, -14 LUFS at -1 dBTP needs about 1.5 dB of limiting somewhere; mastering is
     one gain (§6.3 step 7, peak wins), so the bus pre-limiter (step 3) has to do it, or the delivered mix lands
     near -15.5 LUFS with a warning.
- **afftdn needs a measured noise floor.** Its default (-50) treats quiet speech as noise: on the quiet takes it
  removes 3 dB of 4-9 kHz (consonants) and barely helps the noisy room (+2.6 dB). The gap RMS + 10 dB keeps the
  speech band unchanged (within 0.7 dB before compression) and gains +7 to +11 dB of SNR on noisy and quiet takes;
  +15 starts to take consonants on the noisy room. nr 12 (ffmpeg's default) is the conservative choice; nr 20
  measures better (+10.6 dB) but its musical-noise risk needs ears, so it's left for the A/B.
- **De-esser 0.4** after the pre-gain cuts the harsh headset's 4-9 kHz by 5.3 dB and leaves normal takes within
  -2.3 to +2.7 dB (the rise is the compressor lifting consonants relative to vowels). 0.5 and up start to cut
  normal takes.
- **Clean, hot takes gain least** (near-clip +0.8 dB SNR, usb-hot +3.2): the compressor lowers speech peaks but
  not the room tone, and afftdn has little to remove. Their gap floors end at -85 and -90 dBFS.
- **Silence-only takes**: no speech regions, so no gain and a `no_speech` warning; the chain still denoises
  (-76 → -90 dBFS).
- **ffmpeg 6.x compatibility:** every filter and option (`highpass`, `apad pad_len`, `afftdn nr/nf/tn`,
  `atrim start_sample`, `asetpts`, `volume precision`, `deesser i/m/f/s`, `acompressor`, `ebur128 peak/framelog`)
  exists in ffmpeg 6.0, and 6.0 and 9.0.2 give the same PCM, so Ubuntu 24.04's 6.1 should too. Cross-version
  equality is still only best-effort (plan §6.3); the receipt records the version.
- **Still open:** the blind A/B with the owner on real (consented) recordings, which can move nr and the de-esser.
  The phase-2 script tests use these fixtures.

**Heavy preset** (opt-in, `cleanup: 'heavy'`, va-2qq.7.2): light's chain with `adeclick` before the denoisers and
RNNoise after afftdn, with the vendored `rnnoise-models` "somnolent-hogwash" model (`scripts/lib/rnnoise/sh.rnnn`,
speech over recording-room noise; not subject to copyright; sha256 pinned and checked before use):

```
highpass=f=80, adeclick,
apad=pad_len=600, afftdn=..., atrim=start_sample=600, asetpts=N/SR/TB,     # as light
apad=pad_len=720, aresample=48000, arnndn=m=<sh.rnnn>, aresample=24000,
atrim=start_sample=240:end_sample=<240 + take samples>, asetpts=N/SR/TB,
volume=<pre>dB, deesser=..., acompressor=..., volume=<trim>dB                # as light
```

| Take             | SNR change light → heavy | 4-9 kHz change light / heavy | Gap floor heavy | Heavy speech / TP |
| ---------------- | ------------------------ | ---------------------------- | --------------- | ----------------- |
| quiet-laptop     | +10.6 → +10.8            | +2.1 / +1.9                  | -67.2           | -18.0 / -3.8      |
| noisy-room       | +7.4 → **+12.3**         | +0.4 / +0.3                  | -60.3           | -18.0 / -1.4      |
| usb-hot          | +3.2 → +4.2              | +0.5 / +0.5                  | -91.3           | -18.0 / -4.2      |
| near-clip        | +0.8 → +0.9              | -2.3 / -2.2                  | -85.3           | -18.0 / -6.2      |
| sibilant-headset | +6.3 → +6.8              | -5.3 / -5.3                  | -71.4           | -18.0 / -4.7      |
| punch-quiet      | +11.1 → +11.3            | +2.7 / +2.5                  | -66.6           | -18.0 / -2.4      |
| punch-loud       | +8.7 → +8.8              | +2.7 / +2.7                  | -84.8           | -18.0 / -1.8      |
| silence-only     | n/a                      | n/a                          | -90.5           | no speech         |

- **Sample count** equal on all 8 takes (e.g. noisy-room 251,819 → 251,819); punch pair 0.0 LU apart, as light.
- **Delay:** arnndn runs at 48 kHz only and delays by one 10 ms frame (480 samples, 240 at 24 kHz); an impulse
  through the padded, cut RNNoise stage lands on its own sample, and a chirp burst through the whole heavy chain
  cross-correlates at 0 (an impulse can't be used there: adeclick removes it, which is its job). Cross-correlation on
  the takes: 0 to -3 samples (light: 0 to -1).
- **Determinism:** arnndn fills its last frame with uninitialised memory, and that frame's output reaches one frame
  back, so with a one-frame pad the take's last ~10 ms differed in about 1 run in 8 (float output; noisy-room and
  punch-loud). Padding three frames puts it all in the cut tail: identical PCM sha256 in 16 of 16 runs, and on all 8
  takes twice in the table run.
- **RNNoise alone** (afftdn replaced) lost SNR on every take but the noisy room (-4.3 to -0.4 dB; noisy room +9.3; it leaves the quiet
  takes' hiss that the pre-gain then lifts), and moving the pre-gain before it didn't fix that, hence afftdn first.
  Heavy gains most where noise isn't steady (noisy room +4.9 dB over light) and stays within 1 dB of light on clean
  takes; the speech band is unchanged (4-9 kHz within 0.2 dB of light).
- **Model:** `bd` ("voice") measured within 0.7 dB SNR of `sh` on every take (`RNNOISE_ALT=... npx tsx
spikes/s13/run.ts`). Wall time 0.4-1.3 s per take, about 2-3× light. Not run on ffmpeg 6.0 (no build at hand);
  `adeclick` and `arnndn` exist since 4.2 and 4.3. Heavy needs ears on real takes like light does.

### S11: speech-to-text on the runner (2026-11-03, `spikes/s11`, run `6ae99c77bed4b69e1b6179d1`, 48 credits)

Kokoro-spoken inputs with a known transcript (20 phrases, two voices) were concatenated into 60 s, 90 s and 600 s
clips; phrase starts are exact, word starts are estimated within a phrase. Runner: Ubuntu, 4 CPUs, 15.3 GB, Node 24,
static **ffmpeg 7.0.2**.

| Provider                                         | Result                                                                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Parakeet (`hyperframes models install parakeet`) | Installs in **3.4 s** (704 MB into `~/.cache/hyperframes`); `parakeet-tdt-0.6b-v3-int8`, sherpa-onnx, **CC-BY-4.0**  |
| Parakeet, 60 / 90 / 600 s                        | WER **0.6 / 0.8 / 1.2 %**; **0.10× / 0.08× / 0.06×** real time; peak ~1.9 GB                                         |
| Parakeet phrase starts                           | Consistently **~240 ms early**; with that offset removed, median error **34-48 ms**; phrase ends 430-485 ms late     |
| Outer deadline kill                              | SIGTERM at the deadline, but `npm exec` and a worker thread survived: **children not reaped**                        |
| whisper.cpp v1.9.5                               | **Clone failed** on the runner (exit 1, no stderr). Locally its DTW timestamps were the most accurate (51 ms median) |

So Parakeet is the local provider: about 36 s for 10 minutes of narration, well inside the budget. Captions add a
fixed 240 ms to Parakeet's word starts (it reports them early) and leave ends alone (they are already
430-485 ms late; an end is kept at least 50 ms after its start) (re-measure when the model changes). The deadline must kill the whole
tree (setsid plus a recursive kill), not just the group leader. whisper.cpp would need a vendored source tarball;
it isn't needed for v1. Parakeet's CC-BY-4.0 licence is credited in the README.

### S12: render qualification (2026-11-03, `spikes/s12`, runs `6ae99c7736f6fef837ecc5bb` and `6ae99e7176bcf173e806d8ea`, 65 + 22 + 44 credits)

| Case       | Result                                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| bus90      | 90 s, 2,700 frames exact; all **13 beeps at 0 ms** error in the final AAC                                                                                                                                                                              |
| bus600     | 600 s, 18,000 frames exact; render **7.1 min**; all **82 beeps at 0 ms**. A first attempt was cancelled (`render_cancelled_parent_exited`) because the launching shell exited: long renders must run fully detached                                    |
| automation | 100 and 400 points honoured. **600 points: silently cut to the first 512**, no warning text                                                                                                                                                            |
| remux      | One master gain by re-encoding only the audio: −21.5 → **−14.0 LUFS**, video packets byte-identical, beeps unmoved                                                                                                                                     |
| hold       | All 180 pre-encode frames identical to the base render in both methods; after H.264 only 152-157 match exactly (PSNR ≥ 80 dB). The appended-beat method gives held frames equal to the last base frame; extending the last beat does not (PSNR ~41 dB) |
| leftovers  | Every render leaves headless Chrome processes outside its process group                                                                                                                                                                                |

So: keep automation at ≤ 400 points and treat > 512 as an error ourselves (HyperFrames won't warn). Master by audio
re-mux. Hold the final frame as an appended beat, and compare frames before encoding in the guard. A 10-minute
narration fits the 22-minute run: render ~7 min, cleanup ~2 s, STT ~36 s. Runs must reap Chrome processes after
rendering.

## Publish destination spikes (docs/plans/2026-11-04-publish-destinations.md §8)

### P1: writing a large file into another site's Blobs from outside Netlify (2026-11-05, netliclaw)

A 40 MB file went into a scratch site's `site-files` store from outside Netlify with a token (the Netlify CLI's
`blobs:set`, same API as `@netlify/blobs`): 111 s over a home connection; from a Lambda in us-east-1 it will be far
faster. site-vendor's copy streams the source to `/tmp` while hashing and uploads from a file-backed `Blob`
(`fs.openAsBlob`), so memory stays flat and a retry starts again from the file. The per-object limit is 5 GB; our cap is
500 MB. Conditional writes (`onlyIfNew`, `onlyIfMatch`) back site.json's compare-and-swap.

### P2: per-site repos (2026-11-05, decision)

Not needed in v1. Every video site is linked to `netlify-labs/video-site-template` (private) at a pinned commit; its
content lives in Blobs, so sites never rebuild after the first build. An agent run lands by `publish` (its deploy
becomes production) rather than committing, so it needs no repo of its own. A later re-link to a new template commit
would replace agent-made design changes, so the template commit only moves on purpose. Per-site repos can come later
if people want agent edits in git.

### P3: the template's edge function on a real vended site (2026-11-05, netliclaw, site deleted after)

`/site.json` 200; the page rendered; `/v/<pub>/<sha>.mp4` HEAD 200 with `accept-ranges: bytes`; `Range: bytes=0-1023`
→ 206 with the right bytes; a range 41 MB in → 206 with the right bytes in about 2 s (Blobs have no ranged read, so the
function skips the prefix); past the end → 416. With the site password on, `/`, `/site.json` and `/v/*` all answer 401,
Range requests too. Every file in `netlify/edge-functions` is bundled as a function, so helpers live in `lib/`.

### P4, P5 (YouTube): deferred by the owner (2026-11-05) until a Google Cloud project and OAuth client exist.

### P6: the agent run on a vended site

Waits for site-vendor's deploy (it runs with the tenant's token there). The code lands by `publish`, checks that
production still serves the video, and rolls back to the previous deploy if not.

## Redo-a-scene spikes (docs/plans/2026-11-04-regenerate-beat.md §7)

### B1: a prelude-less `@scope` styles its own scene only (2026-11-05, `npx tsx spikes/b1/b1.ts`, no credits)

The fixture (`test/fixtures/scope/at-scope`) has a white `.card` in three scenes and in a root layer. Scene 2 holds
`<style>@scope { .card { background: red } }</style>`; scene 3 holds the fallback form
`@scope ([data-va-beat="three"]) { .card { background: blue } }`. HyperFrames' own `snapshot` (the CLI render-job and
`hold-still.ts` use; HeadlessChrome 152 locally) captured each scene, and one pixel of each card was sampled.

| Scene                                       | Card in the scene | Card in the root layer |
| ------------------------------------------- | ----------------- | ---------------------- |
| 1 (no style)                                | white             | white                  |
| 2 (`@scope { … }`)                          | red               | white                  |
| 3 (`@scope ([data-va-beat="three"]) { … }`) | blue              | white                  |

Both forms scope to their scene: scene 2's rules reach neither scene 1 nor the root layer. **The prelude-less form
stays the accepted one** (`scopedStyleProblems`, va-8cy4.2.2); the prelude form is kept only behind `allowPrelude` as
a fallback. B2's redone scene also used a prelude-less `@scope` and rendered as intended.

### B2: do frozen scenes render the same after a scoped change? (2026-11-05, `spikes/b2`, `npx tsx spikes/b2/b2.ts [--leak]`, no credits)

A contract-v1 composition with music and four scenes: intro 3 s, features 3.85 s (115.5 frames, authored and never
relaid), proof 3 s, outro 3 s. It was rendered locally (`hyperframes render --quality standard`, HeadlessChrome 152
on macOS; the runner's may differ), then again with features redone (new text, colours, animation and an `@scope`
style) and lengthened by 1.37 s, snapped to 5.233 s as the splice does, so proof and outro start 1.383 s later. Frames
were sampled every 0.5 s at the same moment of each scene (`scripts/e2e/lib/ssim.ts`). Whole-frame SSIM comes from
ffmpeg's `ssim` filter; "tile" is the lowest SSIM over a 4×4 grid (`tileSsim`). `--leak` also changed one line of the
outro's text (`docs.netlify.com/webhooks` → `…/hooks`), a small change outside the scope.

| Aspect | Scene    | Change                      | Frame SSIM min / median | Tile SSIM min |
| ------ | -------- | --------------------------- | ----------------------- | ------------- |
| 16:9   | intro    | none (same start)           | 0.9996 / 1.0000         | 0.9935        |
| 16:9   | features | redone                      | 0.9059 / 0.9068         | 0.6329        |
| 16:9   | proof    | none (shifted)              | 0.9932 / 0.9963         | 0.9800        |
| 16:9   | outro    | none (shifted)              | 0.9940 / 0.9964         | 0.9760        |
| 16:9   | outro    | one line of text (`--leak`) | 0.9887 / 0.9893         | 0.9374        |
| 9:16   | intro    | none                        | 0.9995 / 1.0000         | 0.9917        |
| 9:16   | features | redone                      | 0.9073 / 0.9074         | 0.6909        |
| 9:16   | proof    | none (shifted)              | 0.9932 / 0.9964         | 0.9815        |
| 9:16   | outro    | none (shifted)              | 0.9941 / 0.9965         | 0.9813        |
| 9:16   | outro    | one line of text (`--leak`) | 0.9889 / 0.9894         | 0.9383        |
| 1:1    | intro    | none                        | 0.9990 / 1.0000         | 0.9858        |
| 1:1    | features | redone                      | 0.8336 / 0.8337         | 0.4404        |
| 1:1    | proof    | none (shifted)              | 0.9906 / 0.9956         | 0.9684        |
| 1:1    | outro    | none (shifted)              | 0.9908 / 0.9952         | 0.9697        |

What it means:

- **Frozen scenes render the same, give or take the encoder.** Scenes before the change score ≥ 0.999 on whole
  frames. Shifted scenes score ≥ 0.990: the parent's proof started at 6.85 s, half a frame off the grid (authored, never
  relaid), so matched moments are up to half a frame apart in a moving animation, plus H.264 at new GOP offsets.
- **Whole-frame SSIM can't see a small leak.** One changed line of text scores 0.989–0.990, in the same range as an
  honest shifted scene at 1:1 (0.9906). A whole redone scene is far lower (0.83–0.93).
- **Tiles can.** The worst 4×4 tile drops to 0.937 for the one-line leak, against ≥ 0.968 for honest frozen scenes and
  ≤ 0.74 for a redone one.

**Thresholds for the live gate** (`scripts/e2e/regen-beat.ts`, va-8cy4.3.9), per frozen scene over its sampled frames:
`SSIM_MIN = 0.98` (whole frame, catches drift of a whole scene) and `SSIM_TILE_MIN = 0.955` (worst tile, catches a
small change), with frames sampled at the same moment of each scene. The gate's caption check (other scenes' cues equal
the parent's) still catches text changes directly; tiles are for what captions don't cover. These come from one
synthetic fixture with flat colours and simple motion: video clips, grain or gradients that move will score lower, so
the gate logs every value and the thresholds get revisited after live gate part 1 (LT-1). Nothing here fell below the
~0.97 "investigate determinism" line from the plan.

## Looks spikes (docs/plans/2026-11-04-looks.md §10)

### K3: the API function reads the build's look archives (2026-11-05, a draft deploy and `netlify functions:serve`, no credits)

A worktree with the `clean` look, `[functions."api"]` and `[functions."k3-debug"]` `included_files =
["looks-build/*.tar.gz"]`, and a debug function (never merged) that reads `looks-build/clean.tar.gz` from a few
candidate paths.

- **Deterministic:** two `npm run build`s of the same commit wrote byte-identical `looks-build/clean.tar.gz`
  (sha256 `23ab4395…7d82`, 4,275 bytes), the sha256 `src/generated/looks.ts` records.
- **Draft deploy** (`netlify deploy --build`, alias `k3-looks-spike`, deploy `6aec39f8e7372cfb360f3cf6`; branch
  deploys are limited to `main` on this site): `process.cwd()` is `/var/task`, and
  `join(process.cwd(), 'looks-build', 'clean.tar.gz')` exists with the catalog's sha256. Paths relative to the
  module (`/var/task/netlify/functions/…`) don't.
- **`netlify functions:serve`** (local): `process.cwd()` is the project root; the same path resolves, same sha256.
- **Bundle size:** `api` 2,723,960 bytes without the archive (the agent-run preview of the same base) and 2,728,365
  with it: +4.4 KB for one look, about the archive's size.

So phase 2.2 reads `join(process.cwd(), 'looks-build', '<id>.tar.gz')`, and `included_files` goes on
`[functions."api"]` only (not `[functions]`, which would add the archives to every function). No Blobs fallback needed.

### K2: does a LOOK.md change the output, and what does it cost? (2026-11-05, `spikes/k2`, five Agent Runner runs, 1,083 credits)

Draft looks `clean` and `kinetic` (`spikes/k2/looks/`) were committed at `context/look/` on spike branches
(`spike/k2-none|clean|kinetic`, never merged). Each prompt was the production `buildPrompt` plus the §4.6 look lines,
rendering locally for the run's preview deploy instead of render-job (`spikes/k2/prompts.ts`). Owner ceiling: 900, then
"fix the deploy issue first, then rerun the launch brief".

**First pair (729 credits, wasted):** none 374, kinetic 355. Both run deploys failed: root npm `workspaces` (CLI phase
1) made netlify-cli refuse to deploy from the repo root in CI ("Projects detected"), and the agents spent credits
fighting it. Fixed on main in `20df76a` (no root workspaces). Runs `6aec2348d23c74a7e621c0f0`,
`6aec2348ea92bbe0293fdb24`.

**Launch brief, after the fix** (16:9, 20 s, the Lumen brief in `looks/PROMPTS.md`):

| Look | Run | Credits | Tokens | Time | Contract | hyperframes check |
| --- | --- | --- | --- | --- | --- | --- |
| none | `6aec295d7eb4e01d9139fbc9` | 141.0 | 890 K | 4.6 min | ok | 0 errors |
| clean | `6aec295db6f2ac7dad417f3d` | 110.0 | 690 K | 3.9 min | ok | 0 errors |
| kinetic | `6aec295d5f269da95f634157` | 103.1 | 673 K | 3.6 min | ok | 0 errors |

Contact sheet (6 frames each): `spikes/out/k2/contact-sheet.png` (gitignored; videos in `spikes/out/k2/videos/`).

- **Different?** `kinetic` is unmistakable: huge uppercase words with letter rises, one accent word, an inverted
  accent scene. `clean` is close to no look, as intended ("today's behaviour written down"), but plainer: left text
  beside a drawn card, one idea per scene, where no look built a richer search demo with highlighted results.
- **Cost:** with a look the run read less and decided faster: clean −22 % and kinetic −27 % against no look, on one
  sample each. Well inside the plan's "about 5 % more" bar; one sample is noisy.
- **Copying:** neither look run reused the example's words ("Orbit", its lines) or media.
- **Brand vs look:** the kinetic run followed the brand where they disagreed (tracking −0.02em, not the look's
  −0.04em; a dark brand teal instead of a full accent fill), as §3 says.
- **Owner verdict (2026-11-05, relayed):** go ahead; **the default look stays None**. `clean` ships as an option.

### K1: inlining registry blocks into contract scenes (2026-11-05, `spikes/k1`, `npx tsx spikes/k1/run.ts [--render] [case…]`, no credits)

Each case in `spikes/k1/cases/<block>/` is a contract composition: an intro scene plus one scene holding the block,
rewritten by hand. The harness runs the contract validator, `hyperframes check` (0.8.222), the editor's own edit
operations through `applyEdits` (a text edit on the block's text and a retime of its scene: the same code the browser
editor and the server run), both checks again, and with `--render` a draft render of both versions. Frames of every
edited render were looked at: the new text and timing show.

| Block | Inlinable | Effort | Notes |
| --- | --- | --- | --- |
| `lt-clean-bar` | yes | 10 min | Direct port; the role line raised from 27 to 28 px |
| `beat-freeze-cut` | yes | 15 min, full rewrite of 27 KB | Ids to classes, 14 editable texts, six labels raised to 28 px; one `line_unread` warning by design (a 0.47 s flash label) |
| `editorial-flash-overlay` | yes | 8 min | Has no text of its own: the scene's headline swaps in under the flash, which now hits at 0.6 s as the transition into the scene; the overlay needs `data-layout-allow-overflow` |
| `chromatic-radial-split` | yes | 12 min | WebGL kept; its two panels stay in the DOM (hidden, tagged) and are drawn into textures when the scene is built; the shader's progress is a tweened value (seek-safe), with a crossfade fallback. Canvas text is one line: labels must stay short |
| `camcorder-hud` | yes | 8 min | The counter fills itself from the timeline and scales by `data-duration / data-va-authored-duration`, or a retimed scene shows the wrong time |
| `code-diff` | yes | 15 min | Baked Shiki tokens became static token spans with syntax colours as roles; one `data-va-text` per code line, and a text edit keeps the token colours |
| `data-chart` | yes | 15 min | The SVG is static markup (it was built with `createElementNS`); counting labels now fade in; editing a value doesn't change its bar |
| `bar-chart-race` | yes | 15 min | The driver is a tweened value in the scene's vaBeat; rows carry their data in `data-*`; names and titles are editable, values and ticks are drawn by the script |
| `code-slice-hero` | **no** | assessed only | WebGL scene whose headlines are drawn into textures (no DOM text to edit), built asynchronously after a font load, redrawn on a window `hf-seek` event, helpers call `document.createElement`, and 42 KB with its helpers. **Replace by hand** in `terminal`: a DOM code hero with per-character spans flipped in by a staggered `rotateX` |

**Mounted with `data-composition-src` inside a scene** (`cases/mounted-lt-clean-bar`): the contract validator and
`hyperframes check` both pass and it renders, but its text isn't in `index.html`, so the editor can't edit it, and a
retime doesn't reach it: `relayout` leaves the mount's own `data-duration` and its timeline isn't under the scene's
time-scale, so after shortening the scene the block never plays its exit and is cut at the scene's end. Inlining stays
the rule (plan §4.5). `look:check` could refuse `data-composition-src` in examples; the contract doesn't see it today.

**The Building blocks pattern** (for each look's LOOK.md):

1. Markup inside the `<section data-va-beat>`; ids become classes (several scenes may use the same block); every CSS
   selector scoped to `[data-va-beat="<id>"]`.
2. The timeline is rewritten inside `vaBeat('<id>', (tl, el) => …)`, selecting only inside `el`. Initial states are
   `tl.set(…, 0)` or `tl.fromTo`, never `gsap.set` outside the timeline.
3. No `document.` anywhere in a scene script: the contract refuses it even for `createElement`. Helper elements (ticks,
   grid lines, a scratch canvas) go in the scene's markup; to split text into spans, create them with
   `el.ownerDocument.createElement`.
4. Every visible text has its own `data-va-text` and `data-va-label`; a `<br>` inside a text becomes one element per
   line; code gets one text per line. Scripts never write the text of a `data-va-text` element (an edit would be
   overwritten): text a script draws (counters, values) starts empty and has no text id.
5. Anything that shows time or progress scales by `data-duration / data-va-authored-duration`, so a retime keeps it
   right. Script-driven blocks animate a tweened value (`tl.fromTo(driver, { t: 0 }, { t: END, onUpdate })`), which
   seeks.
6. Block variables become `data-*` attributes on the scene or its rows.
7. Upstream colours become the brand's roles; tints are `color-mix(in srgb, var(--va-color-<role>) N%, transparent)`
   inside gradients and shadows (only a role's own value must be a literal).
8. No jsDelivr GSAP, no Google Fonts: the vendored GSAP and the brand's fonts or the look's font stack. Every reading
   text at 28 px or more (inside an SVG, in viewBox units that still render at 28 px). Full-bleed overlays get
   `data-layout-allow-overflow`. A standalone transition block is retimed to lead into its scene.

**Fonts (changes plan §3):** in the HyperFrames render, the planned `terminal` stack
`ui-monospace, "SF Mono", Menlo, "DejaVu Sans Mono", monospace` came out as a proportional sans; a stack starting
with `"JetBrains Mono"` rendered monospace, and Georgia rendered as a serif. So a look's font stack must lead with a
family the renderer has, and `terminal`'s becomes `"JetBrains Mono", ui-monospace, Menlo, monospace` (to confirm on
the runner in K2 or with fonts in looks, phase 4.3).

### K4: licences of the registry items the starter looks use (2026-11-05, research only, no credits)

Read every file of each item at `heygen-com/hyperframes@v0.8.222` (`registry/<blocks|components>/<name>/`): its
`registry-item.json` (which files `add` installs), the files themselves (headers, notices, bundled assets, outside
URLs), and the commit authors of its folder. The repo is Apache-2.0 (`LICENSE` at the tag) with no root `NOTICE` and
no per-item licence or `LICENSE` file, so every item's own code is Apache-2.0. Credit line for vendored items:
"HyperFrames contributors (HeyGen), Apache-2.0", recorded per item in `registry.lock.json` by `look:vendor`.

Three things ride along with the code and need handling when a look vendors or inlines an item:

- **GSAP from jsDelivr.** 19 of the item files load `https://cdn.jsdelivr.net/npm/gsap@3.14.2/...`. Inlined into a
  scene, they use the run's `vendor/gsap.min.js` instead (the project already ships GSAP under its standard licence),
  and `look:check` refuses outside URLs in the example anyway.
- **Google Fonts links** in `data-chart`, `beat-freeze-cut` and `chromatic-radial-split` (Inter, Space Mono, Bebas
  Neue, JetBrains Mono, Lato, Gelasio; all OFL). Dropped when inlining: the brand's fonts or the look's font stack
  apply (§3), and v1 looks ship no fonts.
- **Bundled third-party files** in `code-slice-hero`: `assets/gsap-3.14.2.min.js` ("Copyright GreenSock. All rights
  reserved", GSAP Standard License) and `assets/Geist-Bold.ttf` (OFL-1.1, Vercel). Neither is vendored: GSAP comes
  from `video/vendor/`, and `.ttf` isn't an allowed look file type (fonts return in phase 4.3).

`camcorder-hud` and `editorial-flash-overlay` carry `demo-backdrop.jpg` (no stated source), but only their
`demo.html` uses it and `add` doesn't install it, so nothing to vendor.

| Item | Type | Licence | Authors (commits) | Source | Verdict |
| --- | --- | --- | --- | --- | --- |
| `browser-device-stage` | component | Apache-2.0 | Miguel Ángel | [folder](https://github.com/heygen-com/hyperframes/tree/v0.8.222/registry/components/browser-device-stage) | keep |
| `blur-in` | component | Apache-2.0 | Miguel Ángel | [folder](https://github.com/heygen-com/hyperframes/tree/v0.8.222/registry/components/blur-in) | keep |
| `bottom-up-letters` | component | Apache-2.0 | Miguel Ángel | [folder](https://github.com/heygen-com/hyperframes/tree/v0.8.222/registry/components/bottom-up-letters) | keep |
| `agent-cursor` | component | Apache-2.0 | Miguel Ángel | [folder](https://github.com/heygen-com/hyperframes/tree/v0.8.222/registry/components/agent-cursor) | keep |
| `grain-overlay` | component | Apache-2.0 | James Russo, Miguel Ángel | [folder](https://github.com/heygen-com/hyperframes/tree/v0.8.222/registry/components/grain-overlay) | keep |
| `before-after-wipe` | component | Apache-2.0 | Miguel Ángel | [folder](https://github.com/heygen-com/hyperframes/tree/v0.8.222/registry/components/before-after-wipe) | keep |
| `lt-clean-bar` | block | Apache-2.0 | Kiyeon Jeon | [folder](https://github.com/heygen-com/hyperframes/tree/v0.8.222/registry/blocks/lt-clean-bar) | keep (inline) |
| `beat-freeze-cut` | block | Apache-2.0 | Miguel Angel Simon Sierra | [folder](https://github.com/heygen-com/hyperframes/tree/v0.8.222/registry/blocks/beat-freeze-cut) | keep (inline, drop the Google Fonts link) |
| `editorial-flash-overlay` | block | Apache-2.0 | ukimsanov | [folder](https://github.com/heygen-com/hyperframes/tree/v0.8.222/registry/blocks/editorial-flash-overlay) | keep (inline) |
| `canopy-part-title` | block | Apache-2.0 code; leaf textures of unstated origin | Miguel Ángel | [folder](https://github.com/heygen-com/hyperframes/tree/v0.8.222/registry/blocks/canopy-part-title) | **replace** |
| `code-diff` | block | Apache-2.0 | Miguel Ángel, WaterrrForever | [folder](https://github.com/heygen-com/hyperframes/tree/v0.8.222/registry/blocks/code-diff) | keep (inline) |
| `code-slice-hero` | block | Apache-2.0 code; bundled GSAP (standard licence) and Geist (OFL) | Miguel Ángel | [folder](https://github.com/heygen-com/hyperframes/tree/v0.8.222/registry/blocks/code-slice-hero) | keep the HTML and `shadows.js`/`surface.js` only (inline) |
| `data-chart` | block | Apache-2.0 | James Russo, Miguel Ángel | [folder](https://github.com/heygen-com/hyperframes/tree/v0.8.222/registry/blocks/data-chart) | keep (inline, drop the Google Fonts link) |
| `bar-chart-race` | block | Apache-2.0 | Miguel Ángel | [folder](https://github.com/heygen-com/hyperframes/tree/v0.8.222/registry/blocks/bar-chart-race) | keep (inline) |
| `chromatic-radial-split` | block | Apache-2.0 | James Russo, Miguel Ángel | [folder](https://github.com/heygen-com/hyperframes/tree/v0.8.222/registry/blocks/chromatic-radial-split) | keep (inline, drop the Google Fonts link) |
| `camcorder-hud` | block | Apache-2.0 | ukimsanov | [folder](https://github.com/heygen-com/hyperframes/tree/v0.8.222/registry/blocks/camcorder-hud) | keep (inline) |

**`canopy-part-title` is replaced** (owner question Q5's default). Its two leaf textures
(`assets/leaf-surface-{color,normal}.webp`) have no stated source ("ported verbatim from the experiment"), and it
loads three.js `0.170.0` from jsDelivr at render time, a 58 KB WebGL scene that can't be inlined into a contract scene
and would need the network on every render. The `editorial` look (phase 4.2) gets a hand-written part title instead:
a rule, a section number and a serif headline in a slow pan; §5's table is updated to match.
