# CLI, SDK and player: make videos from a terminal, from code, and on your own machine

- **Status:** draft 4 (2026-11-06): phase 0's spike results folded in (see "Draft 4" just below; the details are in
  `docs/spikes.md`, C1-C3). Earlier: draft 3 (2026-11-04). Reviewed three times: an independent review (Fable 5.1, "sound with changes"),
  the cross-plan seam review of all six 2026-11-04 plans, and a remote review (Fable 5.1 high, in a Netlify Agent
  Run at `19740d8`, "sound with changes"). Every claim was checked against the code (and the web for external facts)
  before being folded in; the review log is §16. No beads yet.
- **Ask (owner, 2026-11-04):** "We need a CLI for this" (idea #1, run the video loop locally with your own agent)
  and "we want proper CLI that uses proper SDK and we can add to docs section" (idea #14, which includes the
  player). One plan for all of it, because the CLI's remote commands are built on the SDK, and local mode is a CLI
  command.
- **Builds on:** the REST API and its OpenAPI spec (`src/app.ts`, `src/schemas.ts`, `ui/src/api/openapi.json`), API
  keys (`src/domain/auth.ts`, `src/domain/keys.ts`), signed webhooks (`src/lib/crypto.ts`), media uploads
  (`src/domain/media-uploads.ts`), the run prompt (`src/domain/prompt.ts`), the run manifest
  (`src/lib/run-manifest.ts`), the run scripts (`scripts/prepare-run.ts`, `scripts/render-job.ts`,
  `scripts/checkpoint.ts`, `scripts/voice.ts`, `scripts/lib/proc-tree.ts`), the docs pages (`ui/src/pages/docs/`),
  the share page (`netlify/edge-functions/public.ts`) and the `netlify-video` skill (`skills/netlify-video/`).
- **This plan is the hub for the other 2026-11-04 plans.** It owns the shared groundwork they build on: the
  `features` registry, `operationId`s, the SDK and its coverage test, the CLI catalog and exit codes, `packages/`
  workspaces and releases, local mode's runtime bundle, and the docs navigation (§12). Related plans:
  [`looks`](2026-11-04-looks.md) (`--look`, `restyle`), [`render-engines`](2026-11-04-render-engines.md)
  (`--engine`), [`regenerate-beat`](2026-11-04-regenerate-beat.md) (`scenes`, `redo`),
  [`github-action`](2026-11-04-github-action.md) (built on this SDK and CLI; owns `brief`),
  [`screen-recording-demo`](2026-11-04-screen-recording-demo.md) (owns `record`, `local demo`, big uploads).


### Draft 4: what phase 0 changed (2026-11-06)

- **Node.** Local mode runs on Node 22 and 24 (C1, macOS and Ubuntu); the floor stays 22.
- **Runtime.**
  - **Size:** 1.46 MB of bundled run scripts, split into chunks, plus the template.
  - **Install:** `npm ci` from the shipped lockfile into `~/.cache/video-agent/runtime/<version>`, 8 s online and
    2.3 s from cache on Ubuntu (C1).
  - **Refresh:** each run refreshes the scripts and template from the CLI, so a rebuilt CLI never runs stale bundles.
- **agent-kit with a redirected HOME works** (C1): ffmpeg, Chrome and the skills install into
  `~/.cache/video-agent/agent-kit-home`, so the fallback in §6.4 isn't needed.
- **Kokoro** (C3): a venv from the newest python3.13…3.10, `kokoro-onnx>=0.6`, `PIP_CONFIG_FILE=/dev/null`; Python 3.14
  is unsupported upstream. 1.5-2 s per cached line.
- **Agents that ship (Q8, C2).** Claude Code only. Codex was out of quota and Gemini's account tier is no longer
  supported, so neither ran. Their adapters exist but say "not supported yet".
- **Sandbox settings** are verbatim in `docs/spikes.md` C2: Claude Code's flags, its settings file (`//` absolute
  paths in deny rules, no `allowLocalBinding`), the deny-read folders, the env allowlist and the network allowlist
  (Openverse and its audio hosts, Google Fonts, Kokoro's model hosts).
- **New in the design, from C2:**
  - **The render broker.** `render-job` asks the CLI to render outside the agent's sandbox
    (`.render/<attempt>/render-request.json`), because rendering needs the loopback.
  - **The workspace's tsx wrapper.** The tsx CLI's IPC socket is refused in sandboxes.
  - **`NODE_USE_ENV_PROXY=1`.** Node's fetch otherwise ignores the sandbox proxy.
  - **`HYPERFRAMES_FONT_CACHE_DIR` in the workspace.**
- **Open (owner):** on macOS the host-side render's Chrome can still reach the person's local services from an
  agent-written composition (C2 finding 4). Accept that for v1 on macOS, or require Docker renders there.
- **Bead polish since draft 3:**
  - `videos.progress` replaces `versions.progress`.
  - The `x-sdk` `feature`/`fieldFeatures` keys.
  - The approve page has its own lookup route.
  - Release 7.2 is split into tarballs and the first npmjs publish.
  - The fixture agent is split into an adapter (5.14) and a CI job (5.17).

---

## 0. What we're building, in one page

Three npm packages, one private workspace package, and a few server changes:

| Package                            | What it is                                                                                                                                                                                                                                                | Who it's for                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `netlify-video-agent-sdk`    | A typed TypeScript client for a Video Agent deployment's REST API. Resource methods generated from the OpenAPI spec (`va.videos.create`, `va.versions.publish`, …), plus hand-written helpers for the jobs that need more than one request: wait, download, upload, verify webhooks. | Scripts, CI, backends, the GitHub Action, our own e2e scripts. |
| `netlify-video-agent`    | The `video-agent` command. Remote commands talk to a deployment through the SDK only. `video-agent local …` makes a video **on your machine** with the coding agent you already have (Claude Code, Codex or Gemini CLI), inside that agent's OS sandbox. No Netlify account needed. | People in a terminal, coding agents with a shell, CI.          |
| `netlify-video-agent-player` | `<video-agent-player>`, a small web component that plays a published video (poster, captions, credits, sized before it loads) on any page. A later phase of this plan, not a separate project.                                                          | Docs sites, blogs, changelogs, product pages.                 |
| `packages/action` (private)        | The GitHub Action, owned by the github-action plan. In the workspace so it builds and tests with the rest; never published to npm.                                                                                                                         | —                                                             |

In the app: `/docs/cli` and `/docs/sdk` join `/docs/api`, `/docs/mcp` and `/docs/skills` under a docs navigation
that scales to the other plans' pages; `video-agent login` gets an API key after you approve it in the browser; and a
few API additions the SDK needs (operation ids, a version and feature list, the oEmbed JSON the
share page already advertises).

**Positioning: make one locally, then deploy it for your team** (owner decision, 2026-11-04). Local mode is the
front door, not a replacement. "Make one on your laptop in three minutes" is what
gets a stranger to try the project. Everything that makes it a team product stays in the hosted app: sign-in and
roles, review and comments, the browser editor, publishing and share pages, the API and MCP, the queue, planning with
questions, one library for everyone. Every local run ends with one line pointing at the Deploy to Netlify button, and
the README says plainly which things need the hosted app (§6.7).

---

## 1. Facts this plan relies on (checked 2026-11-04)

### The API and its spec

- `npm run openapi:gen` builds the spec from the routes with in-memory fakes and no network
  (`scripts/gen-openapi.ts:1-11`), writes `ui/src/api/openapi.json`, then runs `openapi-typescript@7.13.0` to write
  `ui/src/api/schema.d.ts` (`package.json` scripts `openapi:gen`, `openapi:check`). CI runs `openapi:check`
  (`.github/workflows/ci.yml`), so a route change without regenerating fails the build.
- The UI's client is `openapi-fetch` + `openapi-react-query` typed by `paths` from `schema.d.ts`
  (`ui/src/api/client.ts:1-40`). It sends the session cookie, not a key.
- **The spec has no `operationId`s.** `grep -c operationId ui/src/api/openapi.json` is 0. Routes are created with
  `createRoute({ method, path, summary, description, tags, … })` (for example `src/app.ts:464-467`, tag
  `versions`). Every route already has a tag.
- The spec currently has 67 paths (66 under `/api/v1/`) and 91 operations (counted from `openapi.json` on
  2026-11-04; the reviewer counted 64 and 84 a few hours earlier, and other sessions are adding routes). It includes
  internal run routes `/api/internal/runs/{id}/done` and `/checkpoint` (`src/app.ts:2215`, `:2243`).
- Most lists page with `{ items, nextCursor }` (`src/schemas.ts:431`, `:909`), but not all: `RecordingListSchema` is
  `{ items }` with no cursor (`src/schemas.ts:911`).
- **Idempotency is checked on the exact body.** The server hashes `JSON.stringify(body)` and answers `409 conflict`
  when a key comes back with a different hash (`src/domain/videos.ts:280-284`); records live 24 hours per user and
  operation (`IDEMPOTENCY_TTL_MS`, `:54`).
- **The version DTO already carries some signed URLs.** `files` has signed `poster`, `gif`, the poster variants and
  the hover clip, with one expiry per DTO (`src/domain/videos.ts:955`, `:962-990`); `video`, `captions` (and narration
  audio and transcript) are only unsigned API `links` that 302 (`:942-946`).
- `Idempotency-Key` is accepted on create, revise, remix and similar posts (`src/app.ts:139`, used at `:334`, `:471`,
  `:498`, `:1233`).
- Rate limits answer `rate_limited` with `Retry-After: 60` (`src/app.ts:180`).
- **REST has no server-side wait, but it has ETags.** `GET /api/v1/videos/{id}` sets an `etag` that includes the
  signed URLs' expiry and answers `304` to a matching `If-None-Match` (`src/app.ts:410-424`). The MCP's `get_video`
  waits up to 8 s server-side, polling every 2 s until the etag changes (`src/mcp.ts:541-545`).
- Version statuses are `queued, running, finishing, ready, failed, cancelled, timed_out` (`src/schemas.ts:62`).
- Retry and cancel are per-version routes: `POST /api/v1/videos/{id}/versions/{n}/retry` and `/cancel`
  (`src/app.ts:539`, `:557`). `POST /api/v1/media/check` exists (`src/app.ts:1436`).
- `GET /api/v1/config` is public (skips auth, `src/app.ts:238`) and returns `PublicConfigSchema`
  (`src/schemas.ts:1496`): admission, `siteUrl`, `planningAvailable`, `mcpOAuth`, `authProvider`, `requiredTeams`, and
  feature flags such as `remixEnabled` and `narrationEnabled` (read in `ui/src/api/client.ts`). It has **no server
  version and no feature list.**
- The root `package.json` version is `0.0.0`, `private: true`, and never bumped, so it can't identify a deployment.

### Auth and keys

- API keys start with `nva_` (`src/domain/auth.ts:88`). A key acts as its owner with the owner's role; keys are
  checked first, then (only for the MCP, when OAuth is on) other bearer tokens through `otherBearer`
  (`src/domain/auth.ts:113-160`).
- **Keys can only be created from a signed-in web session:** `createKey` throws `forbidden` ("API keys can only be
  created from a signed-in session.") unless `p.kind === 'user'` (`src/domain/keys.ts:17-20`), and returns the key
  **and its `webhookSecret`** once (`:35`). `listKeys` and `revokeKey` (`:39`, `:44`) work with a key.
- Using a key re-checks its owner every time: account disabled, email domain no longer allowed
  (`src/domain/auth.ts:100-108`), and for Identity, that the user still exists and is confirmed (`:134-139`).
  Creating a key has no such check beyond the session that asks.
- Only `/api/v1/config` (and `OPTIONS`) skips the auth middleware (`src/app.ts:238`); every other `/api/v1` route needs
  a principal. Cookie-session writes go through `assertSameOrigin` (`src/domain/auth.ts:165`).
- Nothing reads `x-nf-client-connection-ip` yet (`grep` over `src` and `netlify`), so per-IP limits are new work.
- **OAuth tokens are bound to the MCP resource.** `resourceUrl = ${siteUrl}/mcp` (`src/auth/oauth.ts:33`); authorize
  and token both refuse another `resource` (`:254-256`, `:463-465`), and a grant only verifies for that resource
  (`:568`). So the REST API does not accept OAuth access tokens today.
- The OAuth server already allows loopback redirects on any port for native apps (RFC 8252 §7.3,
  `src/auth/oauth.ts:59-83`).
- Existing scripts use `VIDEO_AGENT_URL` and `VIDEO_AGENT_KEY` (`scripts/e2e/feedback.ts:2,10`,
  `scripts/e2e/headers.ts:2`, README "Starter music").

### Files, uploads and webhooks

- `GET /api/v1/videos/{id}/versions/{n}/{file}` **redirects (302) to a signed URL valid for 5 to 10 minutes**
  (`src/app.ts:676-707`). The files edge function accepts signed URLs of at most an hour (that's the longest the API
  mints, for the MCP and public videos; `netlify/edge-functions/files.ts:1,8`).
- `POST /api/v1/media?filename=…&caption=…` takes a body of up to 4 MB; bigger files go through upload sessions with
  parts of at most 4 MB, each with its own sha256, then `complete` (`src/domain/media-uploads.ts:2`, `:22`
  `PART_SIZE = 4 MB`, `:148-149`; `skills/netlify-video/references/connect.md:67-81`). An item must reach
  `status: ready` before it can be used.
- Webhook signatures are `t=<unix>,v1=<hex>` with hex = HMAC-SHA256 of `"<t>.<raw body>"`
  (`src/lib/crypto.ts:44-46`; README "The API"). Each delivery also carries `x-video-agent-event` and
  `x-video-agent-delivery` (`src/domain/webhooks.ts:189-191`); receivers dedupe on `eventId` (README).
- The share page advertises `<link rel="alternate" type="application/json+oembed" href="/v/{slug}.json">`
  (`netlify/edge-functions/public.ts:106`), **but the handler's path regex only serves `mp4|jpg|gif|vtt|webp|mp3|txt`**
  (`public.ts:53`), so `/v/{slug}.json` is a 404 today. Public files are served with
  `access-control-allow-origin: *` (`public.ts:87`).
- The embed snippet is plain `<video>` HTML built server-side (`src/domain/videos.ts:852-866`): sized box,
  `preload="metadata"`, WebP poster when present, captions track, CC BY credits as a figcaption.

### What a run assumes (local mode has to provide or change each)

- **The prompt is pure.** `buildPrompt(p: PromptInput)` (`src/domain/prompt.ts:110`) takes plain data (ids, request,
  aspect, length, callback and checkpoint URLs, token, upload mode, media list, sound, voice, plan, feedback, remix)
  and returns a string. It reads no database. The template version (`PROMPT_TEMPLATE_VERSION`, `prompt.ts:8`) is
  recorded on the attempt (`src/domain/reconciler.ts:457`), not written into the prompt text.
- `PromptInput.upload` is typed `{ mode: 'blobs' } | { mode: 'signed'; url: string }` (`prompt.ts:22`), and
  `buildPrompt` writes `--upload <url>` for `signed` (`:112`), **but `render-job.ts` only implements Blobs**: it
  always uploads with `netlify blobs:set uploads <attempt>/<name>` (`scripts/render-job.ts:358-381`) and then POSTs the
  manifest to `--callback` with the token (`:419-434`). The service always passes `{ mode: 'blobs' }`
  (`src/domain/reconciler.ts:225`, `:252`, `:343`).
- render-job also posts render progress to the checkpoint URL derived from the callback (`/done` → `/checkpoint`,
  `render-job.ts:196`), refuses to run without `ffmpeg`/`ffprobe` (`:64-68`), renders with an **unpinned**
  `npx -y hyperframes render --quality $RENDER_QUALITY` (`:202`) (on the runner it resolves to the repo's
  `hyperframes` devDependency), and writes `.render/<attempt>/manifest.json` (`:416`).
- `prepare-run.ts` runs when the prompt carries a run manifest hash (`prompt.ts:126-134`), and fetches every input
  with `netlify blobs:get` (`scripts/prepare-run.ts:53-55`). The manifest is `v: 1`; `verifyRunManifest` rejects any
  other `v`, checks the fields it knows and ignores unknown ones (`src/lib/run-manifest.ts:295-320`). The other
  2026-11-04 plans add optional manifest fields (`look`, `engine`, `scope`, `recording`) and prepare-run steps, in the
  order the render-engines plan fixes (§4.3 there).
- `checkpoint.ts` is best effort and never fails the run (`scripts/checkpoint.ts:1-5`).
- `repoRoot` is computed from the script's own location (`scripts/lib/run-tools.ts:12`), and every script finds
  `video/`, `.render/` and `context/` from it.
- **Stopping a run's processes:** killing the process group is not enough (in spike S11, `npm exec` and a worker
  survived a group SIGTERM). `scripts/lib/proc-tree.ts` runs a command detached, samples the whole tree while it
  runs, and on a deadline sends SIGTERM then SIGKILL to every pid it saw (`proc-tree.ts:1-6`).
- **Voice:** `scripts/voice.ts` picks ElevenLabs when `ELEVENLABS_API_KEY` is set, else Kokoro
  (`scripts/lib/voice-providers.ts:125-141`). Kokoro installs `kokoro-onnx` and `soundfile` with
  `python3 -m pip install --user`, falling back to `--break-system-packages` (`voice-providers.ts:19-34`). That is
  fine on a throwaway runner and not fine on someone's laptop.
- **Skills and tools on the runner come from `netlify-agent-kit`**, run as `postinstall`
  (`package.json` `"postinstall": "netlify-agent-kit install --strict"`, config under `netlifyAgent`). Off the runner
  `install` skips, but **`--force` "installs anywhere (your laptop included)"** (agent-kit README, `install` options
  and Troubleshooting). It installs FFmpeg, the `hyperframes`, `hyperframes-cli` and `media-use` skills (into
  `.claude/skills` and `.agents/skills`), HyperFrames' headless Chrome, and a generated `netlify-agent-kit` skill that
  tells the agent what's installed. Its FFmpeg is a pair of static builds (`ffmpeg-static`,
  `@ffprobe-installer/ffprobe`; README tools table). Outside the repo it writes tools to `~/.cache/netlify-agent-kit/` and links into
  `~/.local/bin` (README "What it changes"). Runners run `npm install` at the root (README, "Agent runner setup runs
  `npm install`…").
- The HyperFrames CLI has `doctor`, `browser` (the render Chrome) and `skills` (`npx hyperframes --help`, 0.8.222).
- The root `AGENTS.md` holds the run rules (work only inside `video/`, run `hyperframes check` to 0 errors, write
  `summary.json`, render with `render-job`, never ask questions, never print env vars, never commit).
- The repo requires Node 24 (`package.json` `engines.node: ">=24"`, `.nvmrc` = `24`).

### Agent CLIs (checked on the author's machine, 2026-11-04; runners don't have them, so C2 re-checks)

- **Claude Code** 2.1.280: `claude -p <prompt>` with `--output-format stream-json` (which **requires `--verbose`**
  with `-p`), `--permission-mode` (choices include `dontAsk`, `acceptEdits`, `plan`), `--settings <file-or-json>`,
  `--setting-sources <sources>`, `--strict-mcp-config`, `--max-turns`, `--max-budget-usd`, `--allowedTools`,
  `--add-dir`, `--dangerously-skip-permissions` (all in `claude --help`).
- **Codex** 0.157.1: `codex exec [PROMPT]` with `-s/--sandbox <mode>`, `-C/--cd <dir>`, `--add-dir`,
  `--skip-git-repo-check`, `--json` (JSONL events), `-o/--output-last-message <file>`, `-m <model>`, `-c key=value`
  overrides, and `--dangerously-bypass-approvals-and-sandbox`.
- **Gemini CLI:** `gemini -p <prompt>` (headless), `--approval-mode default|auto_edit|yolo|plan`, `-s/--sandbox`,
  `--include-directories`, `-o/--output-format text|json|stream-json`, and an undocumented `--policy`. Per Gemini's
  docs (checked by the reviewer; to confirm in spike C2), workspace-level policy files don't take effect, user
  policies live in `~/.gemini/policies`, and in headless mode a tool that would ask is denied, so `auto_edit` denies
  every shell command. Gemini's macOS sandbox uses Seatbelt, and its default profile (`permissive-open`) limits
  writes to the project but allows broad reads and all network; Linux uses Docker or Podman, where `127.0.0.1` is the
  container.
- **Sandboxes and the host's loopback.** Claude Code's sandbox wraps Bash commands only; `Read`, `Write`, `Edit`,
  `Glob` and `Grep` run in the Claude Code process under its permission rules. Its docs say that on Linux a sandboxed
  command's `localhost` is private to it (its own network namespace), and on macOS Seatbelt allows only the
  connection to the sandbox proxy; `sandbox.network.allowLocalBinding` (macOS only) reopens every localhost service.
  So a server on the host's `127.0.0.1` is unreachable from inside the sandboxes this plan requires.

### Docs pages and packaging

- Docs routes are `/docs/api`, `/docs/mcp`, `/docs/skills` (`ui/src/routes.tsx:31-34`, `:57-59`), each a page under
  `ui/src/pages/docs/` sharing `DocsLayout.tsx` (`DocSections`, `CatalogTable`). The MCP page's tool list comes from
  `src/mcp-catalog.ts`, and a test keeps that catalog in step with the server (README "Use it from AI tools").
- The skill is built by `scripts/build.ts:170-177` into `/skills/netlify-video.zip` with the site URL filled in.
- No `packages/` folder and no `workspaces` in `package.json` yet.

### npm names (checked 2026-11-04)

- **`video-agent` is taken:** someone published `0.0.0` (2025-09-23). It has no `bin`, so `npx video-agent` errors
  rather than running code today, but a later version could add one. We never document `npx video-agent`.
- **The `@video-agent` org exists and belongs to someone else** (registry org endpoint answers 200, no packages), so
  we can't publish there. That's why the packages are **unscoped** (owner decision, 2026-11-04):
  `netlify-video-agent` (the CLI, bin `video-agent`), `netlify-video-agent-sdk` and `netlify-video-agent-player`. All
  three were free on npm on 2026-11-04 (registry 404). Unscoped names need no npm org.

---

## 2. Gotchas the design has to handle

1. **Names.** Docs say `npm i -g netlify-video-agent` or `npx -y netlify-video-agent@1 …`, never
   `npx video-agent`. Publishing `0.0.0` placeholders of the three names comes first (spike C4), to hold them and
   because trusted publishing needs the packages to exist (§10).
2. **No operation ids.** Phase 1 adds an `operationId` to every route, plus the SDK name the generator uses (§4.1),
   with a test that they're present and unique.
3. **OAuth won't work for REST.** Tokens are bound to `/mcp` (§1). The CLI gets an **API key** through a device-style
   approval in the web app (§5.2), which works on every deployment, with Identity or Sign in with Netlify.
4. **Keys can't make keys.** `createKey` refuses anything but a web session (`keys.ts:17-20`), so the SDK and CLI have
   no `keys create`; the device flow mints the CLI's key server-side, and `keys list`/`revoke` work with a key.
5. **render-job only knows Blobs and HTTPS callbacks.** Local mode needs `--upload local` (keep the files, skip the
   upload), and the callback must reach the CLI. A loopback server can't: inside the sandboxes §6.5 requires, the
   agent's `localhost` isn't the host's (§1). So results come back through **files** in the workspace (a `file:`
   callback and checkpoint URL, §6.3 step 5), which every sandbox can write because the workspace is mounted at the
   same path. `allowLocalBinding` is never set.
6. **prepare-run only knows Blobs.** Local revisions and every feature that hooks into prepare-run (looks, engines,
   scoped revisions, recordings) need inputs restored. prepare-run gets a file-based fetch mode (§6.4), so there's one
   preparation path for runners and laptops.
7. **`repoRoot` is where the script lives.** The CLI ships bundled copies of the run scripts, so `repoRoot` must be
   overridable (`VA_REPO_ROOT`), or every path points into the CLI's install folder.
8. **Run tools must be pinned.** render-job's `npx -y hyperframes` is unpinned (`render-job.ts:202`). On a laptop
   without the repo's `node_modules` it would fetch `hyperframes@latest` (and `tsx`) on every run, with the user's own
   `~/.npmrc` credentials. Local mode pre-installs pinned tools in a cache folder and puts them first on `PATH` (§6.3).
9. **Kokoro would change the user's Python.** Local mode makes a venv under the cache folder and points the voice
   provider at it (`VA_PYTHON`). It never uses `--user` or `--break-system-packages` on a laptop.
10. **A local agent with a shell can reach everything you can.** A tool allowlist is not a boundary: `Write` plus
    `Bash(npx tsx scripts/*)` is arbitrary code, and `Read`/`cat` reach `~/.ssh`, `~/.aws`, `~/.netlify` and the CLI's
    own config (which holds an `nva_` key). The user's own agent config also loads into the run unless suppressed:
    hooks, MCP servers (their connectors), plugins and memory files. Combined with inputs a stranger can influence
    (a brand kit, media captions, Openverse titles), that's an exfiltration path. **The OS sandbox is the boundary**
    (§6.5).
11. **Codex's sandbox blocks the network by default.** A run needs the network for Openverse music and sound effects,
    the agent's own API and (first time) model downloads. Local mode enables it inside the sandbox with a domain
    allowlist where the agent supports one.
12. **Deployments drift.** Forks deploy whenever they like, so an SDK release will meet older servers. The SDK reads
    `GET /api/v1/config` once (new `version` and `features`, §5.1) and refuses a feature the server doesn't list with
    a clear error instead of a confusing 404.
13. **The oEmbed link is a 404.** The player needs the share page's metadata, which is what `/v/{slug}.json` should
    have served all along. It's a small fix, so it lands early (phase 1), before the player.
14. **CC BY credits must travel with the video.** The embed snippet and the share page always show them
    (`src/domain/videos.ts:852`, `public.ts`). The player shows them too, with no option to hide them.
15. **Node versions.** The repo needs Node 24. The SDK and remote CLI target Node 22+ (Node 20 reached end of life on
    2026-04-30). Local mode needs whatever the run scripts need: Node 24 until spike C1 shows 22 works.
16. **Big media.** `media upload` switches to upload sessions above 4 MB, hashes each part, resumes after a failure,
    and waits for `ready` (or reports `rejected` with `rejectReason`). Screen recordings are the big case.
17. **Signed file links are short.** File routes 302 to storage URLs valid for 5 to 10 minutes (`src/app.ts:680`).
    Downloads must start right after the redirect, and the redirect target must be fetched **without** the
    `Authorization` header. Poster, GIF and preview variants are already signed in the DTO, so they need no redirect.
17a. **Retries must resend the same bytes.** The idempotency check hashes the body (§1), so a retry that
    re-serializes differently (key order, an added default) becomes a `409 conflict` instead of a replay.
17b. **Not every list has a cursor** (`RecordingListSchema`, §1).
18. **Runner install time.** Runners `npm install` at the root, which installs every workspace's dependencies. The
    packages declare no devDependencies of their own (all hoisted to the root) and almost no runtime ones.
19. **Lockfile.** Adding workspaces changes `package-lock.json`. Use `npx npm@11 install` (local npm 10 strips the
    libc fields the lockfile needs).

---

## 3. Package layout and the monorepo

```
packages/
  sdk/       netlify-video-agent-sdk     src/, src/generated/{schema.d.ts,resources.ts}, test/
  cli/       netlify-video-agent     src/, src/catalog.ts, src/brief/ (github-action plan), runtime/ (bundled run scripts + template), test/
  player/    netlify-video-agent-player  src/, test/
  action/    (private, github-action plan)     never published to npm; excluded from Changesets
```

- Root `package.json` gains `"workspaces": ["packages/*"]`. The root stays the app (private, Node 24). The Netlify
  build and agent runs run `npm ci`/`npm install` at the root as now.
- **Dependencies:** every devDependency (esbuild, TypeScript, Vitest, Playwright, Changesets) is hoisted to the root;
  packages declare none, so a runner's install gains almost nothing. Phase 1 measures it anyway (§11).
- Each package builds with esbuild to ESM (`dist/index.js` + `.d.ts` via `tsc --emitDeclarationOnly`). The SDK and
  player have **no runtime dependencies**: `openapi-fetch` (MIT, small) is bundled into the SDK's `dist`. The CLI
  bundles the SDK and its own code into one file, so `npx -y netlify-video-agent@1` installs one small
  package. **The one exception is `video-agent record`** (screen-recording plan): it needs Playwright, which the CLI
  installs into its cache on first use and `doctor` lists; nobody else pays for it. The local runtime is a separate
  folder inside the CLI package (§6.3).
- ESM only. Node 22.12+ can `require()` ESM, so CommonJS callers still work.
- Root scripts: `build:packages`, `test:packages`; `typecheck` adds `tsc -b packages/*/tsconfig.json`; ESLint, the
  build and the tests cover every workspace, including `packages/action`.

**Why a monorepo, not separate repos:** the SDK's types come from this repo's routes, the CLI's local runtime is this
repo's run scripts, and the docs pages are this repo's UI. One commit changes a route, the SDK method, the CLI command
and the docs together, and CI checks them together.

---

## 4. The SDK: `netlify-video-agent-sdk`

### 4.1 Shape: generated resources, hand-written helpers

```ts
import { VideoAgent, verifyWebhook, isVideoAgentError } from 'netlify-video-agent-sdk'

const va = new VideoAgent({
  url: 'https://acme-video.netlify.app', // or env VIDEO_AGENT_URL
  apiKey: process.env.VIDEO_AGENT_KEY, // nva_…
  userAgent: 'release-bot/1.2', // added to the SDK's own User-Agent
})

const video = await va.videos.create({ prompt: 'A 20-second launch video for webhooks', aspect: '16:9' })
const ready = await va.videos.wait(video.id, { onProgress: (p) => console.log(p.stage, p.step) })
await va.files.download(ready, { file: 'video', to: './webhooks.mp4' }) // Node; returns a Response elsewhere
const pub = await va.versions.publish(video.id, ready.latestVersion)
console.log(pub.url, pub.embed)
```

Three layers, from most to least generated:

1. **`va.raw`**: an `openapi-fetch` client typed by the generated `paths`, with auth, base URL, retries and errors
   added. Every route is callable, fully typed: `va.raw.GET('/api/v1/stats')`.
2. **Generated resource methods.** `scripts/gen-sdk.ts` (run by `openapi:gen`) reads each operation's SDK name and
   writes `packages/sdk/src/generated/resources.ts`: one namespace per resource, one thin typed method per operation.
   New routes appear in the SDK with no hand-written change.
3. **Hand-written helpers** where one call isn't enough or a nicer signature matters. They live beside the generated
   namespaces and may replace a generated method of the same name.

**How generated names are chosen (so they read well).** Every route sets two things in `createRoute`:

- `operationId`: unique, camelCase, verb first (`createVideo`, `reviseVideo`, `retryVersion`, `listLooks`,
  `setMediaTrace`). Used by the REST reference and docs anchors.
- `x-sdk`: `{ resource, method }` (`{ resource: 'videos', method: 'create' }`), or `false` for routes the SDK doesn't
  expose as a method (internal run callbacks, the web app's edit routes, admin routes; still reachable through `raw`).
  The generator never derives names from paths or operationIds, so names are a decision a reviewer sees in the route's
  diff, not an accident of the URL.

**Generated signature rule:** path parameters positionally in path order, then one `input` object (body fields and
query fields merged; the generator fails if a body field and a query field share a name), then `opts`
(`{ idempotencyKey?, signal?, headers? }`). So `va.versions.publish(id, n, { transcript: true })`,
`va.videos.list({ mine: true, search: 'webhooks' })`, `va.versions.retry(id, n)`. Routes with a binary body (the
small media upload) are always hand-written.

**The surface today and what other plans add.** Each feature plan adds its routes with `operationId` and `x-sdk` in
the same PR, and the coverage test (§4.4) refuses a route without them. Names other plans rely on:

| Resource    | Methods (G = generated, H = hand-written helper)                                                                                                                                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `videos`    | `create` G (with `look`, `engine`, `recording`, `context`, `externalRef` as each plan lands), `get` G, `list` G (with `externalRef`), `listAll` H (async iterator over `nextCursor`; offered only for operations whose response has `items` and `nextCursor`, so it's a type error elsewhere, since some lists have no cursor), `wait` H, `revise` G (with `scope`, `look`), `remix` G (with `look`, `recording`), `redoScenes` H (`(id, { beats, prompt, …opts })`, sugar for `revise` with `scope: { beats }`; regenerate-beat plan), `favorite` G |
| `versions`  | `retry` G (`(id, n)`), `cancel` G (`(id, n)`), `publish` G, `unpublish` G, `setVerdict` G, `captions` G, `progress` G                                                                                                                                                  |
| `files`     | `url` H (poster, GIF, poster variants and the hover clip come signed in the DTO, `videos.ts:955-990`, so no request; video, captions, narration audio and transcript follow the 302 once), `download` H (`(video, { file, version?, to? })`, same split) |
| `plans`     | `create` G (with `look`), `questions` G, `brief` G (when `config.planningAvailable`)                                                                                                                                                                                 |
| `comments`  | `list` G, `add` G, `addBatch` G                                                                                                                                                                                                                                       |
| `media`     | `upload` H (`(file, { caption?, role?, onProgress? })`: single POST ≤ 4 MB or a multipart session, hashes parts, resumes, waits for `ready`), `uploadRecording` H (`(file, { trace?, onProgress? })`, screen-recording plan), `setTrace` G, `getTrace` G, `check` G (`({ hashes })`), `list` G, `get` G, `delete` G |
| `music`     | `search` G, `import` G, `importAndWait` H (follows the `202` job until `done`/`failed`)                                                                                                                                                                              |
| `looks`     | `list` G (looks plan)                                                                                                                                                                                                                                                 |
| `engines`   | `list` G (render-engines plan)                                                                                                                                                                                                                                        |
| `keys`      | `list` G, `revoke` G. **No `create`:** keys are made from a web session or by `video-agent login` (§5.2).                                                                                                                                                            |
| `me`, `config` | `me.get` G, `me.usage` G, `config.get` H (cached; exposes `features` and `version`), `config.supports(feature)` H                                                                                                                                                  |
| top-level   | `verifyWebhook({ secret, body, signature, toleranceSec = 300 })` H, `parseWebhook({ secret, body, headers })` H (verifies, then returns the typed event with `eventId`, the `x-video-agent-event` type and the `x-video-agent-delivery` id, so receivers can dedupe redeliveries) |

**Why this split:** the reviewer argued for generating the resource layer; draft 1 hand-wrote it. Generation wins for
coverage and drift (a new route is in the SDK the day it merges, typed, with no second place to forget), and the
`x-sdk` name keeps the result readable. Hand-written code stays only where it earns its place: multi-request flows
(wait, uploads, downloads, music jobs), sugar other plans asked for (`redoScenes`), and things that aren't HTTP calls
(webhooks, feature checks). An API report (§4.5) makes every rename visible.

### 4.2 Behaviour

- **Auth:** `apiKey` option, else `VIDEO_AGENT_KEY` when `process` exists. A key in a browser bundle is the caller's
  choice; the docs warn against it and point at `ALLOWED_ORIGINS` (README configuration table) for CORS.
- **User-Agent:** `video-agent-sdk/<version> (+<userAgent option>)`, so a deployment's logs show who calls.
- **Redirects:** authenticated requests use `redirect: 'manual'` and never follow a redirect with the key. The one
  exception is file routes, which 302 to signed storage URLs (`src/app.ts:676-707`): `files.url` and `files.download`
  read `Location` and fetch it **without** `Authorization`, at once, because the link lives 5 to 10 minutes.
- **Idempotency:** `create`, `revise`, `remix` and `redoScenes` send an `Idempotency-Key`: the caller's
  (`opts.idempotencyKey`), or a generated UUID. Retries of the same call reuse the key, so a lost response never makes
  two videos. The body is serialized **once** and the same string is sent on every retry, because the server replays
  only when the body's hash matches and answers `409 conflict` otherwise (`src/domain/videos.ts:280-284`); keys live
  24 hours per user and operation (`:54`). A `409` on a retry is reported, never retried.
- **Retries:** GETs, and POSTs that carry an idempotency key, retry on network errors, 429 (honouring `Retry-After`,
  capped at 60 s) and 5xx, with jittered backoff, at most 3 times by default (`retries` option). Other POSTs never
  retry.
- **Errors:** every non-2xx becomes `VideoAgentError { status, code, message, retryAfterSec?, requestId? }`, using the
  server's `{ error: { code, message } }` body (the shape the UI reads, `ui/src/api/client.ts` `ApiErrorBody`) and
  Netlify's `x-nf-request-id` response header. Codes are the server's (`forbidden`, `not_found`, `conflict`,
  `remix_disabled`, `rate_limited`, …). Helper: `isVideoAgentError(e, 'remix_disabled')`.
- **Waiting:** `videos.wait(id, { version?, timeoutMs?, intervalMs?, onProgress, signal })` polls
  `GET /api/v1/videos/{id}` with `If-None-Match`, treating `304` as "no change" (a tiny response), every 3 s for the
  first minute, then 8 s (`intervalMs` overrides). **No timeout unless given:** a run may use the runner's full 25
  minutes, a retry re-queues, and with `MAX_ACTIVE_RUNS` at 3 a queued video on a busy deployment can wait longer than
  any fixed default, so a default that gave up would fail healthy CI jobs. `signal` and `timeoutMs` (the CLI's
  `--timeout`) stop it. `onProgress` gets the status (including `queued`), and stage and step from `/progress`, when
  the etag changes. (A server-side wait, `rest_wait`, is designed in §14.) It resolves on `ready` and throws `VideoAgentError` code `video_failed` (with the version's status and
  error) on `failed`, `cancelled` or `timed_out` (`src/schemas.ts:62`).
- **Feature detection:** `va.config.get()` is fetched once. Methods for newer features check
  `features` (§5.1) first and throw `VideoAgentError` code `unsupported_by_server` naming the feature and the server's
  version.
- **Webhooks:** `verifyWebhook` uses WebCrypto (`crypto.subtle`, HMAC-SHA256), so it runs in Node, Deno, Bun, Workers
  and Netlify Edge Functions. It parses `t=…,v1=…`, compares in constant time, and rejects timestamps outside
  `toleranceSec`. It needs the **raw body** string; the docs show how to get it in Express, Hono, Next.js and Netlify
  Functions.
- **Runtime:** `fetch` option (default `globalThis.fetch`) for tests and unusual runtimes. No Node-only imports in the
  main entry; `download(…, { to })` uses a dynamic `node:fs` import only when `to` is given. Written for any runtime
  with `fetch` and WebCrypto; **tested on Node 22 and 24 in v1** (Deno, Bun and browsers in "Not in v1", §14).
- **Logging:** a `logger` option (`(event, fields) => void`) receives `request` events: method, path, status, ms,
  attempt number, request id. Never headers or bodies. The CLI turns this into `--verbose`.

### 4.3 Types and generation

- `npm run openapi:gen` writes the spec as now, runs `openapi-typescript` **once** into
  `packages/sdk/src/generated/schema.d.ts`, then runs `scripts/gen-sdk.ts` into `generated/resources.ts`.
  `ui/src/api/schema.d.ts` becomes a one-line re-export of the SDK's file, so the UI and the SDK can't disagree.
  `openapi:check` checks both generated files.
- Exported convenience types: `Video`, `Version`, `Media`, `Plan`, `Comment`, `WebhookEvent`, derived from `paths`
  the way `ui/src/api/client.ts` derives `Video` and `Version` today.

### 4.4 Keeping the SDK in step with the API

- **Same commit, same CI.** A route change regenerates the spec, types and resources; the SDK's helpers typecheck
  against them, so a renamed field breaks the build in the same PR.
- **Coverage test.** Every operation has a tag, a unique `operationId` and an `x-sdk` value (a name or `false`), no two
  operations share an SDK name, and `generated/*` is current. A new route fails until someone decides its name.
- **Breaking-change check.** A CI job runs [`oasdiff`](https://github.com/oasdiff/oasdiff) `breaking` between
  `main`'s `openapi.json` and the PR's (pinned version, run with `npx`/a release binary in the job) and posts the
  result as a **warning** in v1. From the SDK's 1.0 it becomes blocking unless the PR has the `api-breaking` label and
  a changeset with a major bump. The API is additive within `/api/v1`; that's the policy.

### 4.5 SDK tests

- **In-process integration, no network:** the tests build the real app with fakes, as `gen-openapi.ts` does
  (`createApp(makeDeps(...), { isLive: () => true })`), and pass `fetch: (req) => app.fetch(req)` to the SDK. Every
  generated method and helper runs against the real routes, schemas and policy. Creating a video exercises the queue
  with the fakes' runner; `wait` is tested by moving the fake attempt to `ready`, `failed` and `timed_out`, and by
  checking 304 handling.
- **Unit:** retries and backoff (fake timers), `Retry-After`, idempotency key reuse across retries, error mapping,
  `listAll`, upload part slicing and hashing (against `media-uploads.ts`'s rules), redirect handling (no
  `Authorization` on the storage fetch), webhook verification against signatures made by the server's own
  `webhookSignature` (`src/lib/crypto.ts:44`), including tampered body, wrong secret, old timestamp and malformed
  header.
- **Generator:** `gen-sdk.ts` on a small fixture spec (positional params, merged input, name clash failure,
  `x-sdk: false`).
- **API report:** the built `.d.ts` is snapshotted (`api-extractor`-style report committed as
  `packages/sdk/api.md`), so every added, renamed or removed public name shows in review. The names the other plans
  rely on (§4.1 table) are asserted by a test.
- **Runtime:** the built `dist` is smoke-tested on Node 22 and 24 (import, construct, call a stub `fetch`).
- **Logging:** tests run with a logger that records events, so a failing test prints the request trail.

---

## 5. Server changes

### 5.1 API groundwork (phase 1)

1. **`operationId` and `x-sdk` on every route** (§4.1), plus the coverage test. Every later route in any plan carries
   both.
2. **`version` and `features` in `GET /api/v1/config`.**
   - `version: { commit, promptTemplate, release }`: `commit` from Netlify's `COMMIT_REF` at build time, `promptTemplate`
     = `PROMPT_TEMPLATE_VERSION`, `release` = the template release tag when the build has one (our releases), else
     `null`. (The root `package.json` version is `0.0.0` and private, so it can't serve.)
   - `features: string[]`, a registry this plan owns. A feature's string appears only when the deployment has it
     **and** it's switched on. Strings (snake_case): `remix`, `narration`, `planning`, `rest_wait`, `cli_login`,
     `looks`, `engines`, `scoped_revision`, `screen_recording`, `context`, `external_ref`. Phase 1 ships the array and
     the strings for what exists today (`remix`, `narration`, `planning`, plus `cli_login` when it lands); each other
     plan adds its own string in its own PR. Nobody else adds the array. `rest_wait` stays reserved for the
     server-side wait in §14.
3. **No server-side wait in v1.** The SDK's `If-None-Match` polling (§4.2) is cheap: an unchanged video answers a
   bodyless `304`. The `?wait` design (and its cost measurement) is in §14.
4. **Request ids:** errors include Netlify's `x-nf-request-id` in the SDK error and CLI output, so an admin can find
   the request in the function logs. No new id scheme.
5. **`oasdiff` warning job** in CI (§4.4).
6. **`/v/{slug}.json`** (§5.3), early, because it's small and fixes a broken advertised link.

### 5.2 `video-agent login`: approve in the browser, get an API key

A device-style flow (modelled on RFC 8628) that ends in an ordinary API key. It needs no OAuth configuration, works
with Identity and with Sign in with Netlify, and the key shows up (and can be revoked) on the API keys page like any
other.

```
CLI                                            Server                                    Browser (signed in)
POST /api/v1/cli/logins {label, host} ───────► stores login: device code hashed, user
◄── {loginId, deviceCode, userCode,              code, 10-minute expiry, client IP
     verificationUrl, intervalSec}
prints "Open https://site/cli/approve and enter ABCD-EFGH", opens the browser at /cli/approve
                                                                     GET /cli/approve  (the person TYPES the code)
                                                                     "Video Agent CLI on david-mbp wants an API key
                                                                      that acts as you (Creator)." [Approve] [Deny]
                                               ◄──────────────────── POST /api/v1/cli/logins/approve {userCode} (session)
                                               records user_id, status approved
POST /api/v1/cli/logins/{loginId}/token
     {deviceCode}  (every intervalSec) ──────► pending | denied | expired | slow_down
                                               approved → mints the key now (createKeyForUser),
◄── {apiKey, keyId, webhookSecret, user}       re-runs the key-owner checks first (disabled, domain,
     (once)                                    Identity confirmed); status claimed
saves the key (and the webhook secret) to the config file
```

- **Data:** a `cli_logins` table: `id`, `device_code_hash`, `user_code` (8 characters from an unambiguous alphabet,
  shown as `ABCD-EFGH`), `label` (at most 64 printable ASCII characters), `host` (the same), `client_ip`, `status`
  (`pending|approved|denied|claimed|expired`), `user_id`, `api_key_id`, `failed_attempts`, `created_at`,
  `expires_at`. The device code is compared with `safeEqual` on its sha256, as keys are (`auth.ts:129`). **No key is
  ever stored:** approve records only who approved; the token endpoint mints the key on the first successful claim
  through an internal `createKeyForUser(userId, name)` (the part of `createKey` after the session check,
  `keys.ts:21-35`), returns the key **and its webhook secret** once (`createKey` returns both; without the secret a
  CLI-made key could never verify webhooks), and marks the login `claimed`. The sweep deletes rows an hour after they
  expire.
- **Claim-time checks.** The token endpoint has no principal, so before minting it loads the approver's row and
  answers `denied` if the account is now disabled, no longer in an allowed domain, or (Identity) gone or unconfirmed,
  using the same helpers `principalFromRequest` uses for a key's owner (`auth.ts:100-108`, `:134-139`). Approving and
  then being offboarded never yields a working key.
- **Routes and middleware:** `POST /api/v1/cli/logins` and `POST /api/v1/cli/logins/{id}/token` join `/api/v1/config`
  in the auth middleware's exemptions (`src/app.ts:238`). `POST /api/v1/cli/logins/approve` needs a `user` principal
  (a web session, not a key) and `assertSameOrigin`, like every cookie-session write.
- **The code is typed, never prefilled.** The verification URL has no code in it, and the approve page asks the person
  to type the code their terminal shows (RFC 8628 §5.4: a prefilled link is what a phisher sends). Codes expire in 10
  minutes and work once.
- **The page says what it does:** the host and label the CLI sent (escaped, length-capped: they come from anyone on
  the internet), the IP address the request came from and when, and that the key will act as you with your role. A
  login started by a stranger is then recognisable.
- **Limits:** creating logins is unauthenticated, so it's capped per client IP (Netlify's
  `x-nf-client-connection-ip`; 10 pending per IP) and globally (500 pending), so one client can't lock everyone out.
  Nothing in the app does per-IP limiting yet, so the helper and its store (counting pending `cli_logins` rows by
  `client_ip` is enough) are part of phase 3.3.
  Each person can approve at most 10 logins an hour; 5 wrong codes from one session lock approving for 15 minutes.
  Polling faster than `intervalSec` answers `slow_down`.
- **Role:** the key gets the approver's role, like every key. A Reviewer's CLI can watch, comment and approve; a
  Viewer's can read.
- **Admin switch:** `cliLoginEnabled` (on by default) in admin settings, like `remixEnabled`. Off, the routes answer
  `409 cli_login_disabled` and the CLI says "create a key on the API keys page and run `video-agent login --key`".
- **Headless:** `video-agent login --no-browser` prints the URL and code only (SSH, containers).
  `video-agent login --key nva_…` (or `--key -` to read it from stdin) skips the flow. In CI, set `VIDEO_AGENT_KEY`
  or pipe the key with `--key - --no-save`, so it never lands in a file or in argv. `video-agent logout --revoke`
  revokes the key it holds.
- **Why not widen OAuth:** OAuth for REST means a second token type on every route, refresh handling in the CLI, and
  it only exists on deployments that configured a Netlify OAuth app. Keys already have roles, revocation, last-used
  times and disable-on-offboard.

### 5.3 Share metadata for the player (phase 1)

`GET /v/{slug}.json` (extend the regex at `public.ts:53`): the oEmbed response the page already advertises
(`type: "video"`, `version: "1.0"`, `title`, `provider_name`, `width`, `height`, `thumbnail_url`, `html` = the embed
snippet) plus a `video_agent` object for the player: `mp4`, `poster`, `posterWebp`, `captions`, `durationSec`,
`credits`, `lqip`, `hover` (the hover clip, when the version has one). CORS `*`, short cache. Unpublished slugs 404 as
the page does.

---

## 6. The CLI: `netlify-video-agent`

### 6.1 Principles

- **Remote commands use only the SDK.** No private endpoints, no copy of request code. If the CLI needs something,
  the SDK gets it first, so scripts and the Action get it too.
- **Agent-friendly by default.** Every command takes `--json`: one JSON object on stdout, nothing else on stdout.
  Progress and prompts go to stderr. Stable exit codes (§6.2). `video-agent help --json` prints the whole catalog.
- **One catalog.** `packages/cli/src/catalog.ts` lists every command: name, summary, arguments, flags (with types
  and defaults), examples, the SDK methods it uses, the `features` string it needs (the command is hidden when the
  server doesn't list it), and whether it needs the hosted app. The router, `--help`, `help --json`, the `/docs/cli`
  page and the skill's `references/cli.md` all come from it, and a test keeps them in step (the `src/mcp-catalog.ts`
  pattern).
- **No framework.** `node:util` `parseArgs` plus the catalog router. One bundled file (plus `record`'s Playwright,
  §3).
- **Words.** People see "scene", "Look", "Restyle", "Redo this scene"; the API says `beat`, `scope`, `look`,
  `engine`. Flags follow the people words: `--scene`, `--look`, `--engine`.

### 6.2 Remote commands

| Command                                                                                                                                           | What it does                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login [--url] [--key] [--no-browser]`, `logout [--revoke]`, `whoami`                                                                             | Device approval (§5.2) or a pasted key.                                                                                                                                                                       |
| `create "<prompt>" [--prompt-file <f\|->] [--aspect] [--duration] [--sound] [--voice] [--media <id\|path>…] [--look] [--engine] [--recording <id\|file>] [--plan] [--title] [--idempotency-key] [--wait] [--out]` | Makes a video. `--media ./shot.png` uploads first. `--plan` prints the planning questions (with `--json`, as data) and exits; `--answers <file>` with `--plan-id` answers them and creates with the brief (an interactive terminal Q&A is in §14). `--wait` follows it; `--out` downloads when ready.                   |
| `revise <video> "<change>" [--from-version] [--comments <ids>] [--media …] [--scene <id\|label>…] [--look] [--idempotency-key] [--wait]`            | Next version. `--scene` (repeatable) limits it to those scenes (`scope: { beats }`, regenerate-beat plan).                                                                                                    |
| `redo <video> --scene <id\|label>… "<change>"`                                                                                                     | Sugar for `revise --scene` ("Redo this scene"). Hidden until the server lists `scoped_revision`.                                                                                                              |
| `scenes <video> [--version]`                                                                                                                      | Lists the version's scenes (id, label, start, length) from the version DTO, so you can pick one for `redo`.                                                                                                   |
| `remix <video> "<change>" [--look] [--recording …] [...]`                                                                                          | New video from another one.                                                                                                                                                                                   |
| `looks`, `restyle <video> <look>`                                                                                                                 | Lists looks; `restyle` is sugar for `revise --look` (looks plan). Hidden until `looks`.                                                                                                                       |
| `demo <file\|dir> "<prompt>" [...]`                                                                                                               | Sugar for `create --recording` (screen-recording plan). Hidden until `screen_recording`.                                                                                                                      |
| `record <url> [...]`                                                                                                                              | Records a scripted or hand-driven browser tour with a pointer trace (screen-recording plan, its phase 4; uses Playwright, installed on first use).                                                            |
| `brief pr\|release\|changelog …`                                                                                                                  | Builds a prompt from a pull request, release or changelog (github-action plan; module `packages/cli/src/brief/`). Pipe it: `video-agent brief pr 123 \| video-agent create --prompt-file -`.                  |
| `get <video>`, `list [--mine] [--search] [--external-ref] [--limit]`                                                                              | Read.                                                                                                                                                                                                          |
| `wait <video> [--version] [--timeout]`                                                                                                            | Follows a run with a progress line ("Making the video · step 4 · Writing the end card").                                                                                                                     |
| `download <video> [--version] [--file video\|poster\|gif\|captions\|narration\|all] [--out]`                                                       | Signed links, streamed to disk with a progress bar.                                                                                                                                                           |
| `publish <video> [--version] [--transcript]`, `unpublish`                                                                                         | Prints the share URL, MP4 URL and embed snippet (`--json` has all of them, plus the player snippet once phase 5 lands).                                                                                       |
| `cancel <video> [--version]`, `retry <video> [--version]`                                                                                         | Per-version controls (`versions.cancel`/`retry`); the version defaults to the latest.                                                                                                                         |
| `comments list\|add`, `verdict approve\|changes`                                                                                                   | Review.                                                                                                                                                                                                        |
| `media upload <file…> [--caption] [--role screen-recording --trace t.json]`, `media list`, `media get`                                             | Uploads with a progress bar; resumes; waits for `ready`. `--role screen-recording` uses `media.uploadRecording`.                                                                                             |
| `keys list\|revoke`                                                                                                                               | API keys. (Making one: the API keys page, or `login`.)                                                                                                                                                       |
| `open <video>`                                                                                                                                    | Opens the video page in the browser.                                                                                                                                                                          |
| `api <METHOD> <path> [--data json\|@file]`                                                                                                        | Raw call through `va.raw`, like `gh api`. The escape hatch for admin routes and anything without a command.                                                                                                  |
| `doctor`                                                                                                                                          | Checks Node, the config, the server's version and features, and (for local mode) the sandbox tools, ffmpeg, Chrome, agent CLIs, Python and the pinned runtime.                                               |

`<video>` is an id (`vid_…`), a web URL, or a share URL (resolved through the API).

**Config.** One profile in v1: `~/.config/video-agent/config.json` (`$XDG_CONFIG_HOME` honoured), mode 0600, `{ "url": "…", "apiKey": "nva_…", "keyId": "…" }`. Precedence: flags, then
`VIDEO_AGENT_URL` / `VIDEO_AGENT_KEY`, then the file. Several deployments: use env vars (named profiles are in §14).
A file rather than the OS keychain: it works on every platform and in CI (owner question 4).

**Exit codes, and the rule for new error codes.** Map by HTTP status first, then let specific codes override:

| Exit | Meaning                                             | From                                                                                         |
| ---- | --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 0    | ok                                                  |                                                                                              |
| 1    | error                                               | 5xx, network, anything unmapped                                                              |
| 2    | usage or invalid request                            | bad flags; 400 (`invalid_request`, `unknown_look`, `look_not_allowed`, …)                    |
| 3    | not signed in or key refused                        | 401                                                                                          |
| 4    | forbidden or not found                              | 403, 404                                                                                     |
| 5    | the video failed, was cancelled or timed out        | code `video_failed`                                                                          |
| 6    | timed out waiting                                   | `--wait`/`wait` hit `--timeout`                                                              |
| 7    | conflict or switched off                            | 409 (`conflict`, `not_editable`, `remix_disabled`, `look_disabled`, `engine_disabled`, `engine_unsupported`, `cli_login_disabled`, narration lock) |
| 8    | rate limited                                        | 429                                                                                          |
| 9    | the server doesn't support it                       | code `unsupported_by_server`                                                                 |

A new server code needs no CLI change unless it should override its status's exit code. With `--json`, an error is
`{ "error": { "code", "message", "requestId"? } }` on stdout too, so an agent can read it either way.

**Logging.** `--verbose` (or `VIDEO_AGENT_DEBUG=1`) prints JSON lines on stderr: every request (method, path,
status, ms, retry, request id) and each step. Keys are never printed; a test greps the output for `nva_`.

### 6.3 Local mode: how it works

```
npx -y netlify-video-agent@1 local "A 20-second launch video for our webhooks feature" --aspect 16:9
```

1. **Pick an agent.** `--agent claude|codex|gemini`, else the first one installed and signed in, in that order
   (`doctor` shows which). `--model` passes through. Only adapters that passed spike C2 ship (§6.5).
2. **Pinned runtime, once per CLI version.** `~/.cache/video-agent/runtime/<cli version>/` holds an `npm ci` of the
   exact versions the CLI was built with: `hyperframes`, `tsx`, `netlify-agent-kit` (from a lockfile shipped in the
   CLI package). Its `node_modules/.bin` goes first on the agent's `PATH`, and the workspace's `node_modules` (and
   `video/node_modules`) are symlinks to it, so every `npx hyperframes …` and `npx tsx …` in the prompt and
   `video/AGENTS.md` resolves to the pinned copy and never fetches. The child gets an empty `npm_config_userconfig`,
   so even a stray fetch never uses the user's `~/.npmrc` credentials. `doctor` reports the versions.
3. **Build a workspace** in `~/.cache/video-agent/runs/<run id>/` (deleted afterwards unless `--keep`):
   - `video/` from the template the CLI ships (the same files as this repo's `video/`).
   - `context/` copied from `--context <dir>`, else `./context` if the current folder has one, else the neutral
     default.
   - The root `AGENTS.md` (run rules) and `scripts/`: one-line shims (`import '<runtime>/render-job.mjs'`) to the
     bundled run scripts: `prepare-run`, `render-job`, `checkpoint`, `check-contract`, `voice`, `openverse`,
     `narration`, `engine.ts` and `scripts/lib/engines/*` (render-engines plan), `recording.ts` (screen-recording
     plan). The commands the prompt and `video/AGENTS.md` name (`npx tsx scripts/render-job.ts …`) work unchanged.
   - **Skills and tools: `netlify-agent-kit install --force` in the workspace**, the same installer the runner uses:
     the HyperFrames skills into `.claude/skills` and `.agents/skills` (where Codex and Gemini read them), the render
     Chrome, an FFmpeg check, and its generated environment skill. It runs with `HOME` pointed at
     `~/.cache/video-agent/agent-kit-home`, so its `~/.cache` tools and `~/.local/bin` links land in our cache, not
     the user's home; that folder's `.local/bin` joins the child's `PATH` (spike C1 confirms this works).
   - `--media ./shot.png:"New checkout page"` and `--look <id|path>` (an id resolves against looks bundled with the
     CLI at build time; a path points at a look folder, for contributors before their PR merges) become inputs.
4. **Write a local run manifest.** The CLI writes the inputs (media, a parent's `source.tar.gz` for revisions, the
   look folder, a recording) under `<ws>/.va-inputs/`, writes a `v: 1` run manifest pointing at them by key, and puts
   its sha256 in the prompt, exactly as the server does. prepare-run then sets `video/` up with its file-based fetch
   mode (§6.4). So looks, engines, scoped revisions and recordings prepare the same way locally as on the runner.
5. **No server: results come back through files.** The prompt's callback URL is
   `file://<ws>/.render/<attempt>/done`, so render-job's own derivation (`/done` → `/checkpoint`,
   `render-job.ts:196`) gives the checkpoint folder `file://<ws>/.render/<attempt>/checkpoint`. render-job already
   writes `manifest.json` (`render-job.ts:416`); with a `file:` callback it also writes `done.json` there instead of
   POSTing. `checkpoint.ts` with a `file:` URL writes `<seq>.json` (message, render percent, and the optional bundle,
   still capped at its own 2 MB, `checkpoint.ts:12`) into the checkpoint folder. The CLI watches the folder
   (`fs.watch`, with a 1-second poll as fallback) and prints milestones as they land. Files named in the manifest are
   only read from `<ws>/.render/<attempt>/` (names with `/`, `..` or an absolute path are refused). This works in
   every sandbox, because the workspace is mounted at the same path, and it needs no port and no token. A host
   loopback server would not: inside Claude Code's Linux sandbox and Gemini's Docker one the agent's `127.0.0.1`
   isn't the host's, macOS Seatbelt allows only the sandbox proxy, and the one setting that opens it
   (`allowLocalBinding`, macOS only) opens every localhost service too, so it is never set.
6. **Build the prompt** with the real `buildPrompt` from `src/domain/prompt.ts` (bundled into the CLI), with local ids
   (`loc_<ulid>`), the `file:` callback URL (step 5), the random token render-job and checkpoint still expect, `upload: { mode: 'local' }` (new, §6.4), sound, voice,
   length, aspect, media, look and engine. It's the prompt a hosted run gets, so a local video behaves like one made
   in the app.
7. **Run the agent headless in its sandbox** (§6.5), streaming its events to `agent.log` and a one-line status to
   the terminal.
8. **render-job runs inside the agent's turn**, as on the runner: check, contract check, render, master, poster, GIF,
   captions, source archive, previews, then the `file:` callback (`done.json`).
9. **Verify and copy out.** The CLI checks each file's sha256 against the manifest (what finalize does with the
   authenticated report), runs the same MP4 check, then copies outputs to `./videos/<slug>/v1/` (or `--out`):
   `video.mp4  poster.jpg  preview.gif  captions.vtt  source.tar.gz  manifest.json  summary.json  prompt.txt  agent.log  run.jsonl`,
   plus `./videos/<slug>/video.json` (prompt history, agent and model, the prompt template version, HyperFrames
   version, engine, look, timings).
10. Print where it is, how long it took, and one line: "Want this for your team, with review, editing and share
    links? Deploy Video Agent to Netlify: <link>".

Other local commands in v1:

- `local revise <dir> "<change>" [--from-version] [--scene …]`: the parent's `source.tar.gz` becomes an input
  (step 4), the prompt gets `revision: { parentN }` (and `scope` with `--scene`), output goes to `v2/`.
- `local demo <dir>` (screen-recording plan, its phase 4): a recording becomes an input; otherwise the same loop.
`local --engine remotion`, `local preview`, `local render`, `local init` and `local list` are designed in §14
(later). The runtime bundle takes whatever `scripts/` has at CLI build time, so `engine.ts`, `scripts/lib/engines/*`
and `recording.ts` join it when their plans land; local mode doesn't wait for them.

### 6.4 Changes to the run scripts (single source for runner and laptop)

The bundled runtime is built from this repo's `scripts/` and `src/lib/` at CLI build time, so a fix to render-job
ships to both. The changes keep runner behaviour the same:

1. `scripts/lib/run-tools.ts:12`: `repoRoot = process.env.VA_REPO_ROOT ?? <today's value>`.
2. `render-job.ts`: `--upload local` skips the Blobs uploads (`:358-381`) and the reference upload. A
   `--callback file://…` URL writes the manifest to `done.json` at that path instead of POSTing (the 410 "cancelled"
   branch doesn't apply), and `postCheckpoint` with a `file:` URL writes a numbered JSON file instead of a request
   (§6.3 step 5). `PromptInput.upload` gains `{ mode: 'local' }`, and `buildPrompt` writes `--upload local`. With an
   `https:` callback (the runner) nothing changes.
3. `prepare-run.ts`: a **file-based fetch mode**. Today `download(key, to, store)` runs `netlify blobs:get`
   (`prepare-run.ts:53-55`). With `--inputs <dir>` (or `VA_INPUTS_DIR`), it copies `<dir>/<store>/<key>` instead,
   refusing keys that escape the folder. Everything after the fetch (manifest verification, hashes, restore, media,
   feedback stills, the other plans' steps in render-engines' order) is the same code. This is also the file half of
   the `netlify dev` runner (§14).
4. `voice-providers.ts`: when `VA_PYTHON` is set, Kokoro uses that interpreter and installs into it (a venv the CLI
   made in `~/.cache/video-agent/kokoro-venv`); no `--user`, no `--break-system-packages`. Unset, the runner path is
   unchanged.
5. `render-job.ts` and `prepare-run.ts` fail fast with a clear message if anything would call the Netlify CLI when
   `VA_NETLIFY_CLI=off` (the CLI sets it in local mode; nothing should).
6. **Prompt test:** for the same `PromptInput`, the blobs prompt and the local prompt differ only in the `--upload`
   argument; and a fixture `PromptInput` for a plain blobs run produces exactly today's text (the "feature off means
   byte-identical" rule all six plans follow).

`PROMPT_TEMPLATE_VERSION` follows the shared rule: a PR that changes the template text adds 1 to the constant, in
merge order. Change 2 alters the text only for `local` runs, but it is still a template change, so its PR bumps the
constant.

### 6.5 Running the agent safely

**The OS sandbox is the boundary; the tool allowlist is not.** Each adapter does four things:

1. **Ignores the user's own agent config** (hooks, MCP servers, plugins, memory files, custom commands).
2. **Runs inside an OS sandbox:** writes only to the workspace and temp; reads denied on credential folders; network
   limited to an allowlist where the agent supports one.
3. **Gets an allowlisted environment:** `PATH` (pinned runtime first), `HOME`, `USER`, `LANG`, `TERM`, `TMPDIR`,
   `VA_*`, `RENDER_QUALITY`, an empty `npm_config_userconfig`, and that agent's own auth variables when set. Never
   `VIDEO_AGENT_*`, `NETLIFY_*`, cloud credentials or any other secret: local v1 speaks with Kokoro and searches
   Openverse anonymously (passing `ELEVENLABS_API_KEY` or `OPENVERSE_CLIENT_*` in with `--pass-env` is designed in
   §14).
4. **Has a spend and time limit:** a 30-minute timeout (`--timeout`), and the tree stopped on timeout or Ctrl-C with
   `scripts/lib/proc-tree.ts` (every pid seen, SIGTERM then SIGKILL), never by name or process group alone.

**Deny-read list** (every adapter): `~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.azure`, `~/.netlify`, `~/.npmrc`,
`~/.config/video-agent`, `~/.codex`, `~/.gemini`, `~/.claude` (except what the agent itself needs to authenticate,
which it reads before the sandboxed shell starts), `~/.docker`, `~/.kube`, `~/.gnupg`.

**Network allowlist** (where supported): `registry.npmjs.org` (Remotion's `npm ci`), `api.openverse.org` and the
hosts Openverse audio comes from (Jamendo, Freesound, Wikimedia Commons; `scripts/openverse.ts fetch` downloads from
them), the HyperFrames model hosts (Kokoro and Parakeet downloads, listed in C2), and the agent's own API host.
`registry.npmjs.org` joins it only for `local --engine remotion` (§14).

| Agent       | v1 command (to be confirmed in C2)                                                                                                                                                                                                                                                                                                                      | Escape hatch                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Claude Code | `claude -p <prompt> --verbose --output-format stream-json --permission-mode dontAsk --setting-sources "" --strict-mcp-config --max-turns <n> --settings <ws>/.va/claude.json`, where the settings file turns on Claude Code's sandbox (enabled, fail if unavailable, no unsandboxed commands, Bash auto-allowed inside it), sets `sandbox.network.allowedDomains` and `sandbox.filesystem.denyRead`, **and** adds `permissions.deny` rules for the same paths and for `Read`, `Glob` and `Grep` outside the workspace, because the OS sandbox covers Bash only and the file tools run in the Claude Code process. Allows `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`; denies `WebFetch` and `WebSearch`. Never sets `allowLocalBinding`. `--max-budget-usd` with `--budget` for API-key users. Linux needs `bubblewrap` and `socat` (`doctor` checks). | `--no-sandbox` (warns once, still scrubs env)   |
| Codex       | `codex exec -C <ws> --skip-git-repo-check --ephemeral --sandbox workspace-write -c sandbox_workspace_write.network_access=true -c 'shell_environment_policy.inherit="none"' -c 'shell_environment_policy.set={…allowlist…}' --json -o <ws>/.render/last.txt <prompt>`, plus deny-read permissions for the list above, and no user MCP config. | `--no-sandbox` → `--dangerously-bypass-approvals-and-sandbox` |
| Gemini CLI  | `gemini -p <prompt> --sandbox --approval-mode yolo -o stream-json` with a **custom Seatbelt profile on macOS** (the default `permissive-open` allows broad reads and all network, so it meets neither the deny-read list nor the allowlist) and Docker/Podman on Linux with only the workspace mounted (yolo only **inside** its sandbox, because headless `auto_edit` denies every shell command and workspace policies don't apply), with a workspace-only settings home so `~/.gemini/settings.json` MCP servers don't load. Never writes to the user's `~/.gemini/policies`. | `--no-sandbox` (yolo without its sandbox; warns) |

- **What leaves the machine:** the prompt and files go to the agent's own provider under the user's own account;
  Openverse searches and downloads when the video has music or sound effects; model downloads the first time. The CLI
  sends nothing to us: no usage telemetry.
- **What stays on disk:** `agent.log`, `run.jsonl` and `prompt.txt` in `./videos/<slug>/` hold the full prompt, which
  includes the brand kit text and media captions. Fine on the author's machine; `/docs/cli` says so, and to remove
  them before attaching them to a public bug report.
- **Exact flags and settings keys are a spike.** C2 runs each agent through a silent and a narrated-with-music video
  **inside its OS sandbox** and records the smallest settings that finish. An adapter that can't finish sandboxed
  doesn't ship in v1; the design stays for three. Gemini is the one most at risk (its default macOS profile doesn't
  meet the deny list, and a custom profile is untested), so expect v1 to ship Claude Code and Codex.

### 6.6 First run and `doctor`

`video-agent doctor` (and the first `local` run) checks, with a fix for each:

- Node version (24 for local until C1 says otherwise; 22 for remote).
- `ffmpeg` and `ffprobe`: provided by the pinned runtime's agent-kit install (static builds, §1); a system copy is used
  only when the runtime's is missing. `doctor` prints which one is active.
- The pinned runtime (installed, versions match the CLI), and HyperFrames' render Chrome in it.
- The sandbox: Claude Code's needs `bubblewrap` and `socat` on Linux; Codex's and Gemini's own checks.
- At least one agent CLI installed and signed in (a version call, never a prompt), and its version against the ones
  C2 tested.
- `python3` 3.10+ only when the run asks for an AI voice-over; the venv is created on first use (about 15 s per
  `docs/spikes.md` S9's measurement of the install).
- Playwright for `record`, when installed.
- `ffmpeg` and `ffprobe` also when `record` or `media upload --role screen-recording` will be used, not only for
  local mode: the recorder converts to H.264 with a 1-second keyframe interval before upload (screen-recording plan).
  The pinned runtime's static builds count; otherwise a system copy.
- Disk space for the cache (runtime, Chrome, Kokoro model).

Supported in v1: macOS and Linux. Windows through WSL; native Windows is in §14.

### 6.7 Local vs hosted, said plainly

| You get locally                                                                                          | Only in the hosted app                                                       |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| The same prompt, contract, checks, render, captions, music (Openverse), sound effects, AI voice-over       | Team sign-in, roles, private videos                                          |
| Revisions and "Redo this scene" from a local folder; looks; screen-recording demos                       | Review: comments on moments, approvals, incorporate feedback                 |
| Your agent, your subscription, no Netlify account                                                        | The browser editor (text, timing, colours, media, narration)                 |
|                                                                                                          | Publishing: share pages, embeds, GIFs, the player, unpublish                 |
|                                                                                                          | The API, MCP, webhooks, CLI remote commands, the GitHub Action               |
|                                                                                                          | Plan with questions (AI Gateway), a shared media library, the queue, usage  |

### 6.8 How agents use the CLI

- The `netlify-video` skill gains `references/cli.md` (from the catalog): when the agent has a shell, prefer
  `video-agent create … --json --wait` over the MCP polling loop; how to read exit codes; `media upload` instead of
  the curl recipe in `connect.md`; `local` when the person has no deployment.
- The recipes stay where they are; the CLI flow for a PR or a release is the github-action plan's `brief` command
  (`video-agent brief pr … | video-agent create --prompt-file - --wait`), documented once in `references/cli.md`.
  (CLI variants of every skill recipe are in §14.)
- MCP stays the path for chat clients without a shell (Claude web, ChatGPT).

---

## 7. The player: `netlify-video-agent-player` (phase 5)

In scope: the owner's #14 included it. It comes after the SDK and CLI because nothing else depends on it, but its
server half (`/v/{slug}.json`) lands in phase 1.

```html
<script type="module" src="https://acme-video.netlify.app/player.js"></script>
<video-agent-player src="https://acme-video.netlify.app/v/k3t9x2abcd"></video-agent-player>
```

- **Sources:** `src` is a share URL; the player fetches `/v/{slug}.json` (§5.3) for size, poster, captions, credits
  and the hover clip. Or set `mp4`, `poster`, `captions`, `width`, `height` directly (for private videos, with signed
  URLs from the SDK; those from `files.url` last 5 to 10 minutes, so set them right before playing).
- **Behaviour:** a box sized from the aspect ratio before anything loads (no layout shift); LQIP, then the poster;
  `preload="metadata"`; native controls by default (accessible, keyboard, picture-in-picture, fullscreen); captions
  track on, toggleable; the CC BY credit line under the video whenever the video has one (no attribute removes it);
  `autoplay muted loop` for GIF-like use. (Hover preview and a theming surface are in §14.)
- **API:** properties and methods mirror `HTMLVideoElement` (`play`, `pause`, `currentTime`, `muted`) and re-dispatch
  its events (`play`, `pause`, `ended`, `timeupdate`), plus `loaded` with the metadata.
- **Size:** under 6 kB gzipped, no dependencies, Shadow DOM.
- **Delivery:** npm (`import 'netlify-video-agent-player'`), any npm CDN, and the deployment itself serves
  `/player.js` (same build, copied by `scripts/build.ts`), so a fork's embeds don't depend on npm or a CDN.
- **Where it shows up:** the publish dialog and `publish --json` offer a "Player" snippet next to the plain HTML
  embed. The share page and the MCP card keep their own markup in v1.

Tests: Playwright component tests (sizing before load, captions, credits always shown, events, attribute changes, a 404 `src` shows a plain error), a size budget check in CI, and an axe accessibility check.

---

## 8. Docs pages, navigation and README

- **Navigation that scales.** Today's three tabs become a docs sidebar on wide screens and a select on narrow ones,
  grouped: **Build** (REST API, SDK, CLI), **AI tools** (MCP, Agent skills), **Guides** (Looks, GitHub Action, and
  later pages). One list in `ui/src/pages/docs/DocsLayout.tsx` drives it, so another plan adds a page with one entry
  and a route (`ui/src/routes.tsx` `BY_PATH`). Owned here (phase 6.1); other plans add pages only.
- **`/docs/cli`** (`ui/src/pages/docs/CliGuide.tsx`): install (`npm i -g netlify-video-agent`),
  `video-agent login --url <this site>` with the URL filled in (like `McpGuide` fills the MCP URL,
  `ui/src/pages/docs/McpGuide.tsx:39`), the command table from the CLI catalog (`CatalogTable`), JSON output and exit
  codes, environment variables, CI usage, a "Make videos on your laptop" section for `local` (with the sandbox
  explained), and a `#record` section (added by the screen-recording plan's phase 4).
- **`/docs/sdk`** (`SdkGuide.tsx`): install, a quickstart with this site's URL, the resource table, waiting and
  downloading, uploads, webhooks verification (Express, Hono, Next.js, Netlify Functions), errors and retries,
  `raw`, and the player snippet (once phase 5 lands). Links to `/docs/api` for request and response shapes.
- **Tests:** a unit test checks the CLI page's command table matches the catalog; a Playwright test opens both pages
  and checks the copied commands contain the site URL and the `netlify-video-agent` package names.
- **README:** a "Try it on your laptop" section near the top (three commands: install, `doctor`, `local "…"`), then
  "Bring it to your team" with the Deploy button; "From scripts" moves from curl to the SDK and CLI (curl stays as a
  short example); the MCP section links the CLI for agents with a shell.

---

## 9. Dogfooding

- `scripts/e2e/*.ts` and `scripts/seed-music.ts` move from hand-written `fetch` calls to the SDK. They're the first
  real users, and they already read `VIDEO_AGENT_URL`/`VIDEO_AGENT_KEY`.
- The GitHub Action uses the SDK and CLI (`brief`).
- Our own release notes can be made with `video-agent create` from CI once the Action exists.

---

## 10. Release and versioning

- **Changesets** (`@changesets/cli`) for the three public packages; `packages/action` is ignored (private, released
  by the github-action plan's own script). Each PR that changes a package adds a changeset; a release PR bumps
  versions and changelogs; merging it publishes. Packages version independently. The app is private and not
  published.
- **Trusted publishing** (OIDC, no npm token in secrets), set up in this order:
  1. Publish a `0.0.0` placeholder of each package by hand with 2FA (spike C4; no npm org needed for unscoped names):
     trusted publishing can only be configured for a package that exists.
  2. Configure each package's trusted publisher on npmjs.com (this repo, the release workflow file, and the allowed
     action, which npm requires for configurations made after 2026-05-20).
  3. The release workflow runs on GitHub-hosted runners only, with `id-token: write`, Node ≥ 22.14 and npm ≥ 11.5.1.
- **Nothing goes to npmjs before the repo is public.** The CLI bundles `buildPrompt`, `video/AGENTS.md`, the run
  scripts and the skills (§6.3), so publishing it would release all of that world-readable, before the going-public
  snapshot's review ([2026-11-02-going-public.md](2026-11-02-going-public.md)), and without provenance (which needs a
  public repo and package). Until then, internal testing uses `npm pack` tarballs (attached to a private release or
  installed by path). The first npmjs publish comes from the public repo, with provenance from day one (owner
  question 6). The C4 placeholders are empty `0.0.0` packages, only to hold the names and allow trusted publishing.
- **0.x until the public launch**, then 1.0. In 0.x, minors may break; from 1.0, semver, with the `oasdiff` job
  blocking breaking API changes without a major SDK bump (§4.4).
- **Compatibility:** each SDK release states the oldest server `version.commit` it's tested against; `features`
  does the rest. The CLI's `doctor` and first request warn when a feature is missing.
- **The CLI pins** the HyperFrames, `tsx` and `netlify-agent-kit` versions in its runtime lockfile (§6.3), and records
  the prompt template version in each local `video.json`, so an old local video can be re-rendered with the same
  tools.

---

## 11. Build order

Each phase ends with a gate. Some gates include a **live test** (a script that makes real videos on the production
site and checks them; costs credits). Every live test runs `--dry` first (it prints the steps and the projected credits
and spends nothing), then **asks the owner before each gate runs**, and stops at its `CREDIT_CEILING`, like
`scripts/e2e/remix.ts`. There is no blanket pre-approval (owner decision, 2026-11-04). Live gates delete what they made (test media, test videos where possible) in a `finally`.
Spike labels use `C` (the other plans use `K`, `E`, `B`, `D`, `A`; `docs/spikes.md` already has `S0`–`S13`).

### Phase 0: spikes (no credits)

- **C1: bundled runtime.** Bundle the run scripts (§6.3 list) with esbuild; build a workspace with shims,
  `VA_REPO_ROOT`, the pinned runtime and `netlify-agent-kit install --force` under a redirected `HOME`; run prepare-run
  `--inputs` and render-job `--upload local` on a fixture composition on macOS and Linux (Node 22 and 24) with
  `npm_config_offline=true` on the second run. Measure the runtime's size and first-install time. Pass: an MP4 with
  the same hashes as the repo's own render of the fixture, no network fetch of tools on the second run, nothing
  written to the real `~/.local/bin`.
- **C2: each agent headless, sandboxed.** With Claude Code, Codex and Gemini CLI, run the real prompt for a silent
  15 s video, then a narrated one with music, **inside the agent's OS sandbox** with the §6.5 settings. Record:
  finished or not, minutes, which commands or hosts were blocked, the final settings, and that a canary file in a
  deny-read folder (tried with `cat` **and** with the agent's own Read tool), a canary env var, and a canary server on
  the host's `127.0.0.1` were all unreachable (the last confirms the `file:` handoff is the only path back). Pass: the
  agent finishes both sandboxed and the canaries held. Spends the tester's own subscriptions, not Netlify credits.
- **C3: Kokoro in a venv** on macOS (Apple silicon) and Ubuntu: create, install, speak one line, time it; list the
  model download hosts for C2's allowlist.
- **C4: names.** Publish empty `0.0.0` placeholders of `netlify-video-agent`, `netlify-video-agent-sdk` and
  `netlify-video-agent-player` by hand with 2FA (re-check each is still free first). No npm org.
- Gate: a short note appended to `docs/spikes.md` and this plan updated (draft 4).

### Phase 1: API groundwork (server; depends on nothing; blocks every plan's API additions)

1.1 `operationId` + `x-sdk` on every route, coverage test. 1.2 `version` and `features` in `/api/v1/config` (the
registry, §5.1). 1.3 `x-nf-request-id` surfaced in errors. (1.4, the server-side wait, moved to §14.) 1.5 `oasdiff` warning job. 1.6 npm workspaces (`packages/`, including `packages/action`), hoisted
devDependencies, build and test scripts, lockfile with npm 11; measure `npm install` time on the runner (one cheap
run, compared with the last week's setup times). 1.7 `/v/{slug}.json`.
Gate: typecheck, lint, vitest, `openapi:check`, Playwright; the run setup time within 5% of before; the oEmbed JSON
checked against a video made for testing, published for the check and unpublished in `finally` (no credits).

### Phase 2: the SDK (depends on 1.1, 1.2, 1.6)

2.1 Generation into `packages/sdk/src/generated` (types and resources), UI re-export. 2.2 Core: config, auth, `raw`,
redirects, errors, retries, logger, User-Agent. 2.3 Helpers: `wait`, `listAll`, `files.url`/`download`,
`media.upload`, `music.importAndWait`, `config.supports`. 2.4 Webhooks. 2.5 Coverage test and API report. 2.6 Node
22/24 smoke. 2.7 Move `scripts/e2e/headers.ts` and `seed-music.ts` to the SDK.
Gate: unit + in-process integration green; **live gate** `scripts/e2e/sdk.ts` against production: read-only checks
with `VIDEO_ID`, a media upload over 4 MB and its deletion (in `finally`), and (with `CREATE_OK=1`) one 10-second
video created, waited for, downloaded and verified (about 150 credits; `CREDIT_CEILING` default 300). Live gates run
by hand once per phase, never in CI.

### Phase 3: the CLI's remote commands (depends on 2)

3.1 Catalog, router, help, `--json`, exit codes, logging. 3.2 `login`, `logout`, `whoami`, `doctor` (remote part).
3.3 Server: `cli_logins` table and migration, the three routes and their auth-middleware exemptions,
`createKeyForUser` with the claim-time owner checks, the approve page (typed code, escaped label and host, IP shown,
`assertSameOrigin`), the per-IP and global caps (new: nothing in the app limits by IP yet), per-person approval
limits, the admin switch, sweep cleanup. 3.4 Video commands (create, revise, remix, get, list, wait, download, publish,
cancel, retry, comments, verdict, open). 3.5 `media upload`/`list`/`get`. 3.6 `api`, `keys list|revoke`.
Gate: CLI tests in-process (the CLI's `main(argv, io)` with the SDK pointed at the in-process app), `--help`
snapshots, a test that no output contains `nva_`; Playwright for the approve page (approve, deny, wrong code, expired,
lock after 5 tries, per-IP cap, an over-long or HTML label shown escaped); a domain test that approve-then-disable
claims as `denied` and that the claim returns the webhook secret; **live gate** `scripts/e2e/cli.ts`: login with `--key`, list, get, download a ready
version, publish and unpublish a video made for testing (unpublished in `finally`; no credits), and with
`CREATE_OK=1` one `create --wait --out` (about 150 credits), by hand once per phase, never in CI.

### Phase 4: local mode (depends on C1–C3 and 3.1 only; runs beside phase 2)

Local mode is the front door (§0), so it doesn't wait for the remote CLI or for other plans. The runtime bundle takes
whatever `scripts/` has at CLI build time: `engine.ts` and `recording.ts` join it when their plans land.

4.1 Run-script changes (§6.4) with the prompt tests. 4.2 Runtime bundle, runtime lockfile and template copy at CLI
build. 4.3 Pinned runtime install, workspace builder, local run manifest, the `file:` callback and checkpoint folder
watcher. 4.4 Agent adapters that
passed C2 (§6.5), with env allowlist, deny lists, budgets and proc-tree. 4.5 Verify-and-copy-out, `video.json`.
4.6 `local revise`. 4.7 `doctor` (local part). 4.8 A **fixture agent** (`--agent fixture`, hidden) that copies a
known composition into `video/` and runs the exact commands the prompt lists, for CI.
Gate: a CI job on Linux with ffmpeg and Chrome runs `video-agent local --agent fixture` end to end (runtime,
workspace, manifest, prepare-run `--inputs`, render-job `--upload local`, `done.json`, checkpoints, verify, outputs), checks the MP4
with ffprobe, the captions and the manifest hashes, and that no `NETLIFY_*` or `VIDEO_AGENT_*` variable reached the
child; then `local revise --agent fixture`. **Live gate** (manual, the tester's subscriptions): one silent and one
narrated video with each shipped agent, sandboxed, then `local revise` on each. Results recorded in this plan.

### Phase 5: the player (depends on 1.7; independent of 3–4)

5.1 The component. 5.2 `/player.js` from the build. 5.3 "Player" snippet in the publish dialog and in
`publish --json`.
Gate: Playwright component tests, size budget, axe.

### Phase 6: docs, navigation and README (depends on 3; the local section on 4)

6.1 The docs navigation (§8) and `/docs/cli`, `/docs/sdk`. 6.2 README sections. 6.3 Skill `references/cli.md`.
Gate: catalog-vs-docs test, Playwright on both pages, the skill zip still deterministic (`scripts/build.ts`).

### Phase 7: release (depends on 2, 3, 4; the player with 5)

7.1 Changesets, release workflow with trusted publishing (§10). 7.2 Internal `npm pack` tarballs until the public
snapshot; then the first npmjs `0.1.0` of the SDK and CLI from the public repo, with provenance (owner question 6). 7.3 Fresh-machine check: on a clean macOS user and a clean Ubuntu container, follow the
README's "Try it on your laptop" word for word. 7.4 The player's first release with phase 5.
Gate: the fresh-machine check passes; `npm view netlify-video-agent` shows the release (and provenance once
the repo is public).

Parallel work: phase 0 and phase 1 together; then 2, 4 and 5 together (4 needs C1–C3 and 3.1, the first step of
phase 3, which needs nothing from phase 2 to start); the rest of 3 after 2.

---

## 12. What other plans depend on here

| Other plan             | Needs from this plan                                                                                                                                 | Phase here |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| All                    | `features` registry and `version` (they add their own strings), `operationId` + `x-sdk` on new routes, the coverage test, workspaces               | 1          |
| looks                  | `looks.list`, `look` on create/revise/remix/plans; CLI `looks`, `--look`, `restyle`; `local --look`; the Looks docs page in the nav                | 2, 3, 4, 6 |
| render-engines         | `engines.list`, `engine` on create; `--engine`; `engine.ts` in the runtime bundle when it lands; `local --engine remotion --accept-remotion-license` later (§14) | 2, 3, 4    |
| regenerate-beat        | `scope` on revise, `videos.redoScenes`; CLI `scenes`, `revise --scene`, `redo`                                                                         | 2, 3       |
| screen-recording-demo  | `media.upload({ role })`, `media.uploadRecording`, `setTrace`/`getTrace`, `recording` on create/remix; CLI `demo`, `media upload --role`, `record` slot, `local demo`; `recording.ts` in the bundle; `/docs/cli#record` | 2, 3, 4, 6 |
| github-action          | The SDK (`versions.retry/cancel`, `files.download`, `media.check`, `videos.wait`, `externalRef`, `context`); `packages/action` in the workspace; the `brief` command slot | 1, 2, 3    |

---

## 13. Open questions for the owner

1. **Package names. Decided (2026-11-04):** unscoped `netlify-video-agent` (CLI, bin `video-agent`),
   `netlify-video-agent-sdk` and `netlify-video-agent-player`; no npm org. (The `@video-agent` scope is taken.)
2. **Local mode. Decided (2026-11-04):** ship it, framed as "make one locally, then deploy it for your team", with
   the deploy line after every local run and the README's local-vs-hosted table.
3. **CLI login on every deployment by default?** **Recommended:** yes, with the `cliLoginEnabled` admin switch.
4. **Where keys live:** a 0600 config file (recommended for v1), or the OS keychain where there is one?
5. **Should a local video be pushable to the team app** (`video-agent local push`, §14)? The strongest funnel, and
   real work. **Recommended:** not in v1; revisit after launch.
6. **Publishing before the repo is public:** internal `npm pack` tarballs until the public snapshot, then npmjs with
   provenance from the public repo (recommended), or publish 0.x to npmjs now from the private repo (exposes the prompt
   template, run scripts and skills before the going-public review)?
7. **`/player.js` served by every deployment** (recommended), or npm and CDN only?
8. **An agent that can't finish inside its sandbox in C2:** leave it out of v1 (recommended; Gemini is the likely
   one), or ship it with `--no-sandbox` as its only mode and a warning?
9. **A server-side wait (`rest_wait`, §14):** leave it out of v1 and let a later measurement decide (recommended), or
   build it now?

(Settled by the reviews: the server `version` source, now `COMMIT_REF` plus the template version; native Windows, now
§14; default safety, now the OS sandbox with `--no-sandbox` as the escape hatch. Question 4 stands; CI uses
`VIDEO_AGENT_KEY` or `--key - --no-save`, so the key never lands in a file there.)

---

## 14. Not in v1 (designed, kept for later)

- **`local preview <dir> [--version]`:** unpack the source and open `npx hyperframes preview --background`
  (HyperFrames Studio) on it. **`local render <dir>`:** a render-unchanged run without an agent (render-job only), the
  manual edit path after Studio. **`local init`:** write `./context/` (`BRAND.md` template, `brand.json`, `assets/`)
  and `video-agent.json` (defaults: agent, aspect, sound, output folder). **`local list`:** the videos under
  `./videos/`. (v1 has `local`, `local revise`, `local demo` and `--keep`; `./context` is picked up without `init`.)
- **Named profiles:** `profiles list|use|remove`, `--profile`, `VIDEO_AGENT_PROFILE`, config
  `{ "current", "profiles": { "<name>": { url, apiKey, keyId } } }`.
- **`webhooks verify --secret <s> [--signature <h>] < body`** (exit 0/1) for shell receivers; the SDK's
  `verifyWebhook` ships in v1. **`music search|import`** commands; the SDK's methods ship in v1.
- **Runtime matrix** beyond Node: Deno, Bun and a Vite-bundled browser smoke test in Playwright.
- **`local push`** to a deployment: an import API that takes a local `source.tar.gz` and outputs and verifies them with
  a render-unchanged run (owner question 5).
- **`LocalRunnerPort` for `netlify dev`:** `RUNNER=local`, only with `ALLOW_NON_PRODUCTION=true`; `start` spawns the
  local executor with the server's own prompt, `snapshot` reads the child's state, `stop` uses proc-tree. The file
  half (prepare-run `--inputs`) ships in v1; the other half is render-job's already-typed `signed` upload mode and
  dev-only upload/fetch endpoints, because `netlify blobs:get/set` talk to the linked project's real stores, not
  `netlify dev`'s emulated ones.
- **Native Windows** (WSL works). The config would live under `%APPDATA%`.
- **Server-side wait (`rest_wait`):** `?wait=<0-10>` on `GET /api/v1/videos/{id}` holds the request until the etag
  changes or the time passes, reusing the MCP's loop (`src/mcp.ts:541-545`), and honours `If-None-Match`. Netlify
  synchronous functions may run up to 60 s, so 10 s is safe. Each wait is billed function time, so measure it against
  `If-None-Match` polling (requests and GB-s per finished video) first; ship only on a clear win, advertised as
  `rest_wait`, and the SDK's `wait` then passes `wait=8`.
- **Interactive planning in the terminal:** `create --plan` asks each question with arrow-key choices, write-ins and
  skip, then shows the brief to accept. v1 prints the questions and takes `--answers <file>`.
- **`local --engine remotion`** (render-engines plan, after its phase 2 and the licence decision): refuses to run
  without `--accept-remotion-license` and prints that plan's licence notice once. The runtime bundle carries
  `engines/remotion/template/` (lockfile only; `npm ci` at run time with `registry.npmjs.org` on the sandbox's network
  allowlist).
- **`--pass-env NAME`** for `ELEVENLABS_API_KEY` and `OPENVERSE_CLIENT_*`: passes that one variable into the agent's
  environment and adds its host to the network allowlist. Out of v1 because it puts a secret where an injected
  instruction could read it; Kokoro and anonymous Openverse need none.
- **Player extras:** `hover-preview` (plays the muted hover clip on hover, like the Library, from `/v/{slug}.json`'s
  `hover`); a theming surface (`::part(video)`, `::part(credits)`, `--va-player-radius`, `--va-player-background`).
- **CLI variants of every skill recipe** (changelog, social cut, localise, review), beside the `brief` flow.
- Plan-with-questions locally; the browser editor locally; a Python or Go SDK; a React wrapper for the player
  (`<video-agent-player>` works in React 19 as is); admin commands beyond `api`; OAuth for REST; the OS keychain;
  telemetry of any kind.

## 15. Risks

- **Agent CLIs change flags and sandbox settings often.** Adapters are small; the live gate checks each flag we pass
  still appears in the installed CLI's `--help`; `doctor` reports the versions we tested.
- **Sandboxes differ by OS** (Seatbelt on macOS; bubblewrap on Linux; Docker/Podman for Gemini). C2 runs on both
  macOS and Linux; `doctor` explains what's missing.
- **Local runs fail in ways the runner doesn't** (old ffmpeg, no Chrome, Python quirks, sleeping laptops). `doctor`
  first, clear errors, `--keep` to inspect the workspace, `agent.log` and `run.jsonl` for bug reports.
- **The bundled runtime drifts from `scripts/`.** It's built from the same files at CLI build time, and the fixture
  agent CI job runs the bundle, not the repo copy.
- **Prompt injection through inputs** (brand kit, captions, Openverse titles, PDFs). The prompt fences them as data;
  the sandbox, deny lists, env scrubbing and network allowlist limit what an injected instruction can reach.
- **Device-flow phishing and lockout.** Typed codes, short expiry, the requesting IP on the approve page, per-IP and
  global caps, per-person approval limits, claim-time owner checks, the admin switch (§5.2).
- **A sandbox setting that quietly reopens the host** (`allowLocalBinding`, a broad Seatbelt profile). The adapters
  never set them, and C2's canaries test reads through the shell **and** through the agent's file tools.
- **No spend cap for subscription users of Codex and Gemini.** `--max-turns`/timeouts bound them; Claude Code API-key
  users get `--budget`.
- **Monorepo install time adds to every run.** Hoisted devDependencies; measured in phase 1.
- **Support load from strangers' laptops.** Supported matrix stated (macOS, Linux; the agents that passed C2; Node
  versions); everything else is best effort.
- **Netlify positioning.** Owner question 2.

---

## 16. Review log

### Draft 1 → 2

Independent review (Fable 5.1, "sound with changes"):

| Item | Decision | Why |
| --- | --- | --- |
| A1 `@video-agent` scope is owned; `video-agent` has no bin | **Adopted with changes** | Verified by the orchestrator (org endpoint 200). Names are now `@netlify-labs/video-agent-*` (addendum 16); C4 creates the org and placeholders; Q1 is labs vs `@netlify`. (Superseded by the owner's decision: unscoped `netlify-video-agent*` names, no org.) |
| A2 allowlist isn't a boundary; OS sandbox; ignore user agent config; `--verbose`; proc-tree | **Adopted** | Each point checked: `--verbose`, `--setting-sources`, `--strict-mcp-config`, `--max-turns`, `--max-budget-usd`, `dontAsk` exist in `claude --help` (2.1.280); `proc-tree.ts:1-6` says groups aren't enough. Exact Claude settings keys and Gemini policy behaviour are the reviewer's reading of the docs; C2 confirms them. `--yolo` renamed `--no-sandbox`. |
| A3 generate the resource layer | **Adopted with changes** | Generated from an explicit `x-sdk` name per route (not derived from paths or operationIds), so names read well; helpers stay hand-written; API report and a test pin the names other plans rely on. |
| A4 keys can't create keys; mint at claim; no prefilled code | **Adopted** | `keys.ts:17-20` confirmed. `keys create` removed; `createKeyForUser` at first claim; no key at rest; code typed on the page. |
| A5 pin and pre-install tooling; `netlify-agent-kit install --force` | **Adopted with changes** | `render-job.ts:202` is unpinned and `--force` works locally (README). Added a redirected `HOME` because agent-kit links into `~/.local/bin` and writes `~/.cache`; C1 verifies. |
| A6 local revise: (a) CLI restores vs (b) prepare-run file mode | **(b) adopted**, (a) rejected | Four other plans add prepare-run steps (looks, engines, scope, recording); one preparation path keeps them working locally with no second implementation, and it's the file half of the `netlify dev` runner. |
| A7 ETag + If-None-Match; 8–10 s wait | **Adopted** | `src/app.ts:410-424` and `mcp.ts:541-545` confirmed; wait capped at 10 s; cost measured first. |
| A8 signed links 5–10 min; manual redirect without Authorization | **Adopted** | `src/app.ts:680` says 5–10 minutes; the one-hour figure is the edge function's maximum. Player text fixed too. |
| A9 trusted publishing prerequisites; provenance needs public | **Adopted** | Ordered steps in §10; new owner question 6. |
| A10 version source; `x-nf-request-id` | **Adopted** | Root version is `0.0.0` (checked). `version: { commit, promptTemplate, release }`. Old Q9 removed. |
| A11 hoist devDependencies | **Adopted** | agent-kit README confirms runners `npm install` at the root. |
| A12 confine loopback paths, cap bundle | **Adopted** | §6.3 step 5. |
| Factual fixes (prepare-run :53-55, counts, oasdiff unspecified, "function time is cheap") | **Adopted** | Citations fixed; counts re-taken (67/91 now; the spec grew during the day); oasdiff named and pinned; cost claim replaced by a measurement. |
| Missed risks (user agent config, CLI key readable, npmrc, loopback, lockout, rest_wait cost, provenance, spend cap, ElevenLabs allowlist, live-gate cleanup) | **Adopted** | Each now in §2, §5.2, §6.5, §10, §11 or §15. |
| Over-built: player | **Rejected as "not in v1"; kept as phase 5** | The owner's #14 included the player. `/v/{slug}.json` moved to phase 1. |
| Over-built: three adapters | **Adopted** | Designed for three; ship those that pass C2 (Q8). |
| Over-built: local preview/render/init/list, profiles, runtime matrix, webhooks verify and music commands | **Moved to §14 with their design** | Not needed for the first working loop; nothing lost. |
| Over-built: oasdiff policy | **Adopted with changes** | Warning job in v1, blocking from 1.0. |
| Over-built: ULID request id, login key encryption | **Adopted** | Gone with A10 and A4. |
| Playwright for `record` vs "one small package" | **Adopted** | §3 states the optional, first-use dependency. |

Cross-plan seam review (changes for cli-and-sdk):

| Item | Decision | Why |
| --- | --- | --- |
| 1 `userAgent`; redirect rule | **Adopted** | §4.2. |
| 2 `versions.retry/cancel` | **Adopted** | Per-version routes (`src/app.ts:539`, `:557`). |
| 3 `files.url`/`files.download(video, { file, to })` | **Adopted** | §4.1. |
| 4 `wait` with If-None-Match, `rest_wait`, `timed_out` terminal | **Adopted** | §4.2. |
| 5 `media.check` | **Adopted** | Route exists (`src/app.ts:1436`). |
| 6 methods other plans need | **Adopted** | §4.1 table and §12; generated where they're one route, helpers otherwise. |
| 7 own the `features` registry; renames | **Adopted** | §5.1; `regenerate_beat` → `scoped_revision`. |
| 8 CLI commands (`scenes`, `revise --scene`, `redo`, `looks`, `restyle`, `record`, `local demo`, `media upload --role --trace`, `demo`, `--idempotency-key`, `brief`) | **Adopted** | §6.2; `regen`, `upload-recording`, `--recipe`, `--notes-file` dropped. |
| 9 runtime bundle adds engine and recording scripts, prepare-run file mode; `--accept-remotion-license` | **Adopted** | §6.3, §6.4. |
| 10 prompt test rephrased | **Adopted** | §6.4 item 6; the template version isn't in the prompt text (`reconciler.ts:457`). |
| 11 `packages/action` in the layout, ignored by Changesets | **Adopted** | §3, §10. |
| 12 exit-code mapping and the rule | **Adopted** | §6.2. |
| 13 docs nav that scales | **Adopted** | §8. |
| Shared rules 4 (template bump), 5 (manifest `v: 1`), 8 (spike labels `C`), 15 (words) | **Adopted** | §6.4, §6.3, §11, §6.1. |
| Addendum 16 (names), 17 ("telemetry" means usage only; pointer trace) | **Adopted** | Every `@video-agent/` replaced; `--trace`, `setTrace`/`getTrace`. |

### Review log (draft 2 → 3): remote review (Fable 5.1 high, Netlify Agent Run at `19740d8`)

Each claim was checked at today's code before it was adopted.

| Item | Decision | Why |
| --- | --- | --- |
| R1 loopback callback unreachable from the sandboxes; use a `file:` handoff | **Adopted** | render-job already writes `manifest.json` before posting (`render-job.ts:416`) and derives the checkpoint URL from the callback (`:196`), so `file://…/done` → `…/checkpoint` works with no other change. Claude Code's sandbox docs (and guides quoting them) confirm Bash-only scope and private localhost; Gemini's Linux sandbox is a container. `allowLocalBinding` is never set; C2 tests a host-loopback canary. |
| R2 decouple local mode from render-engines; move it up | **Adopted** | The bundle is built from whatever `scripts/` holds at build time, so the engines dependency was not real. Phase 4 now needs C1–C3 and 3.1 only and runs beside phase 2. Roadmap change recommended (wave 4 → 2). |
| R3 claim-time owner checks, return `webhookSecret`, cap label/host, middleware exemptions, `assertSameOrigin` | **Adopted** | `keys.ts:35` returns the secret; `auth.ts:100-108`, `:134-139` hold the owner checks; `app.ts:238` exempts only config; `assertSameOrigin` is `auth.ts:165`. The review's `auth.ts:124` for `safeEqual` is `:129`. Per-IP limiting named as new work in 3.3. |
| R4 resend identical bytes on idempotent retries | **Adopted** | `videos.ts:280-284` hashes the body; `IDEMPOTENCY_TTL_MS` at `:54`. |
| R5 `files`: DTO-signed vs 302 files | **Adopted** | `videos.ts:942-946` (links) and `:955`, `:962-990` (signed poster, GIF, variants, clip). |
| R6 `wait` with no default timeout; queue position | **Adopted with changes** | No default timeout. There is no queue-position field in the API (`grep` over `src/schemas.ts`, `src/domain/progress.ts`), so `onProgress` reports the `queued` status, not a position. |
| R7 Claude Code file tools bypass the OS sandbox; add `permissions.deny` | **Adopted** | Consistent with Claude Code's docs and guides: the sandbox covers Bash and its children. C2 canary tries `cat` and Read. |
| R8 Gemini macOS default profile doesn't deny reads | **Adopted** | Custom Seatbelt profile required, or Gemini doesn't ship (Q8 now names Gemini as the likely one). |
| R9 `listAll` only where there's a cursor | **Adopted** | `RecordingListSchema` at `schemas.ts:911` has none; §1 now says "most lists". |
| R10 FFmpeg from the runtime, not brew | **Adopted** | agent-kit README tools table (static `ffmpeg-static`, `@ffprobe-installer/ffprobe`). |
| Claims: `%APPDATA%` with Windows out of v1; agent CLI versions unverifiable on a runner; `x-nf-client-connection-ip` unread | **Adopted** | `%APPDATA%` moved to §14; §1's heading says where versions were checked; per-IP helper named as new work. |
| Security: publishing the CLI before the repo is public exposes the prompt and run scripts | **Adopted** | §10 now: `npm pack` tarballs internally; npmjs only from the public repo, with provenance. Q6 rewritten. |
| Security: show the requesting IP on the approve page | **Adopted** | §5.2. |
| Security: `parseWebhook` takes delivery headers and exposes event and delivery ids | **Adopted** | Headers at `webhooks.ts:189-191`. |
| Security: `agent.log`/`run.jsonl` contain the full prompt | **Adopted** | §6.5 note; `/docs/cli` says so. |
| Security: gates publish real videos; `CREATE_OK` gates per PR | **Adopted** | Gates use a test video unpublished in `finally`; live gates run by hand once per phase, never in CI. |
| Over-built: `rest_wait` | **Moved to §14 with its design** | `If-None-Match` polling already gets bodyless 304s; the string stays reserved in the registry. New Q9. |
| Over-built: interactive `--plan` | **Moved to §14** | v1 prints the questions and takes `--answers`. |
| Over-built: `local --engine remotion` | **Moved to §14** | It needs engines phase 2 and the licence decision anyway. |
| Over-built: player `hover-preview` and theming | **Moved to §14** | The player itself stays in scope (phase 5): sized box, poster, captions, credits, native controls. |
| Over-built: `--pass-env` | **Moved to §14** | Kokoro and anonymous Openverse need no secret; passing one is what §6.5 otherwise forbids. |
| Over-built: CLI variants of skill recipes | **Moved to §14** | `references/cli.md` plus the Action's `brief` flow cover v1. |
| Seams: roadmap wave for local mode; Looks line 560 says "hand-written resource methods"; Action install ref sha vs `action-v1` tag | **Not edited here** | Other documents; reported to the orchestrator (move local mode to wave 2; Looks should say "generated resource methods plus helpers"; the roadmap should use the Action plan's tag). |
| Q4 key storage with CI via stdin | **Adopted** | `--key - --no-save`; `VIDEO_AGENT_KEY` in CI. |
| Owner decisions 2026-11-04 | **Applied** | Unscoped names (no npm org; C4 publishes placeholders only); local mode ships ("make one locally, then deploy it for your team"); live tests run `--dry` and ask the owner before each gate; Q1 and Q2 marked decided. Remotion POC, default look and Action install don't change this plan. |
| Seam (screen-recording draft 3): `doctor` checks ffmpeg for `record` and `media upload --role screen-recording` | **Adopted** | The recorder re-encodes to H.264 with a 1 s keyframe interval before upload; §6.6. |

---

## Sources

- npm package and org names: `npm view video-agent` (exists, 0.0.0, no bin) and `npm view @video-agent/sdk` (404),
  2026-11-04; org endpoints checked by the orchestrator (`@video-agent` → 200, `@netlify-labs` → 404).
- Agent CLI flags: `claude --help` (2.1.280), `codex exec --help` (codex-cli 0.157.1), `gemini --help`, run
  2026-11-04.
- HyperFrames commands: `npx hyperframes --help` (0.8.222).
- netlify-agent-kit behaviour: `node_modules/netlify-agent-kit/README.md` (0.4.0).
- npm trusted publishing with GitHub Actions OIDC and provenance (community write-ups; check npm's own docs when
  setting it up): [codenote.net](https://codenote.net/en/posts/npm-trusted-publishing-oidc-staged-hardened-release/),
  [gr2m/github-project#185](https://github.com/gr2m/github-project/pull/185),
  [github/clipboard-copy-element#86](https://github.com/github/clipboard-copy-element/pull/86).
- [oasdiff](https://github.com/oasdiff/oasdiff) for OpenAPI breaking-change detection.
- Device authorization flow: RFC 8628 (§5.4 on remote phishing); loopback redirects: RFC 8252 §7.3.
- Claude Code sandboxing: [code.claude.com/docs/en/sandboxing](https://code.claude.com/docs/en/sandboxing) (cited by
  the round-3 review), and guides describing the Bash-only scope and `allowLocalBinding`:
  [TrueFoundry](https://www.truefoundry.com/blog/claude-code-sandboxing),
  [instagit](https://instagit.com/anthropics/claude-code/configure-sandbox-claude-code),
  [Zenn](https://zenn.dev/todesking/articles/c1f5b9ff26e4f9).
- Gemini CLI sandbox profiles: [geminicli.com/docs/cli/sandbox](https://geminicli.com/docs/cli/sandbox/) (cited by the
  round-3 review).
