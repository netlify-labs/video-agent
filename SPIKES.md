# Phase 0 spike results

Runs started with `spikes/start-run.ts` against project `netlify-video-agent` on branch `spike/phase-0`
(minimal HyperFrames project + `netlify-agent-kit@0.3.1`). Logs are in `spikes/out-*.log` (not committed).

## S0. Workbench: done (2026-10-30)

- Hello run `6ae508ea7aeaf1eebda6042e`: 45 s, 5 steps, **14.4 credits**, default agent Claude (claude-opus-5-5).
- In the run: Node v24.22.2, FFmpeg 7.0.2 static, FFprobe static, `npx hyperframes --version` 0.8.222, clean `git status`.

## S2. Hand-back: option A works (2026-10-30)

Run `s2` (148 s, 36.5 credits):

| Step | Result |
| --- | --- |
| `netlify blobs:set` 2 MB / 20 MB / 100 MB to a site store | OK in 1.0 s / 1.3 s / 2.5 s (~40 MB/s) |
| Write to a second store (`videos`) | OK (27 s for the first write: store creation latency, single sample) |
| `blobs:list`, `blobs:get` round trip | OK, SHA-256 matches |
| 100 MB upload killed after 1 s, then retried | Retry OK |
| Outbound HTTPS POST | 200 |

Consequences:

- **Upload mode `blobs` is the default** (`UPLOAD_MODE=blobs`). The signed-upload edge path stays unbuilt unless a deployer needs it.
- Runs can write **any** store on the site, so finalize's hash check against the authenticated callback manifest is load-bearing (already in the design).
- `netlify` isn't on `PATH` in non-interactive shells inside the run. `render-job.ts` and `prepare-revision.ts` resolve the CLI (`netlify`, then `npx -y netlify-cli`, then common global paths).
- Run environment variable **names** include `NETLIFY_AUTH_TOKEN`, `NETLIFY_API_TOKEN`, `NETLIFY_DB_URL`, `NETLIFY_DB_BRANCH`, `NETLIFY_SITE_ID`, `CONTEXT`, `DEPLOY_ID` and 19 `NETLIFY_AGENT_RUNNER_*` variables. Runs get their **own database branch** (`NETLIFY_DB_BRANCH`), confirming that previews and runs never see production writes live.

## S1. From scratch: quality is good; standard quality; ~3–8 minutes per video (2026-10-30)

Three from-scratch runs with the section 5 style prompt (neutral look, no brand context):

| Run | Brief | Aspect | Length asked → got | Total run | Credits | `check` rounds | Render (each quality) | File (standard) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | Launch video, "Org webhooks" | 16:9 | Auto → 22.5 s | 447 s | 206 | 3 | ~22 s | (uploaded) |
| b | Sales clip, deploy previews | 9:16 | 15 s → 15.0 s | 192 s | 92 | 1–2 | ~16 s | 1.0 MB |
| c | Docs tutorial, env vars | 1:1 | 60 s → 60.0 s | 405 s | 192 | 3 | ~35 s | 1.5 MB |

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

Production (`netlify-video-agent.netlify.app`, deploy `f89d1f4` and later) ran `scripts/e2e/phase2.ts` with an API key:
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
  permalink (`<deploy-id>--netlify-video-agent.netlify.app/api/health`) returns `404`. Agent-run previews deploy with
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
