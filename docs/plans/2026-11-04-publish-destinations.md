# Publish destinations: the share page, YouTube, and your own sites — plan

- **Status:** draft 1 (2026-11-04). Not started. No beads yet. Not reviewed.
- **Ask (owner, 2026-11-04):** someone asked for "a button to post to YouTube". The owner widened it: publishing today
  only means the share page on this app; we want **one generic publishing interface** where the share page, YouTube
  and others are channels. YouTube needs the person to connect their account so we can upload for them. A second
  channel: **build a Netlify site with the video in it**, using the internal site-vendor service (revenue-engine
  `services/site-vendor`). That one is internal and must not be part of the open-source app, but it has to slot into
  the same interface. The owner also asked that site-vendor gain a way to **upload blobs to a site it created**, and
  that the video goes there.
- **Builds on:** publishing (`publishVersion` / `unpublishVersion`, `src/domain/videos.ts:722-815`; the
  `publications` table, `db/schema.ts:202`; the share page edge function, `netlify/edge-functions/public.ts`), the
  webhook outbox (`src/domain/webhooks.ts`, `webhook_deliveries` at `db/schema.ts:649`, delivered by the
  every-minute sweep, `netlify/functions/sweep.ts`), signed file links (`/files/{jobId}/v{n}/{file}`,
  `netlify/edge-functions/files.ts`, one hour at most), webhook signing (`webhookSignature`, `src/lib/crypto.ts:44`,
  `X-Video-Agent-Signature: t=…,v1=…`), secret storage (`encrypt` / `decrypt`, `src/lib/crypto.ts:55-68`), and the
  background-function dispatch pattern (`PlatformPort.dispatchFinalize`, `src/adapters/platform.ts`).
- **Follows the shared rules** in the [roadmap](2026-11-04-roadmap.md): every new route has an `operationId`; the
  feature strings are `destinations` and `youtube`; the Version DTO only grows (a new `destinations` field next to
  `publications`); spike labels are `P` (no collision with `S`, `C`, `K`, `E`, `B`, `D`, `A`).
- **Words:** people see **Publish ▾**, **Publish to YouTube**, **Published to**, **Connected accounts**, and
  **Destinations** (admin). Code and the API say `destination` (a configured channel) and `destination publication`
  (one version sent to one destination). "Delivery" stays the webhook word.

---

## 0. What it is, in one paragraph

A **destination** is somewhere a ready version can be published: the share page (built in, today's behaviour), a
person's YouTube channel (built in, needs a connected Google account), or an **HTTP destination** that an admin
points at any HTTPS endpoint. Publishing a version to a destination makes a **destination publication** row that
moves through `queued → running → (waiting) → live | failed`, and later `removing → removed`. The work runs in a
background function, retried with backoff like webhooks, so a slow YouTube upload or a site build never blocks a
request. The HTTP destination is the open-source seam: the app POSTs a signed payload with signed links to the
MP4, poster and captions, and the receiver answers with a URL (now, or later through a callback). Netlify's internal
"Netlify site" channel is just an HTTP destination whose receiver lives in revenue-engine and uses site-vendor, which
gains **blob uploads** so the video lives in the vended site's own Netlify Blobs and an edge function on that site
streams it.

## 1. Today

- `POST /api/v1/videos/{id}/versions/{n}/publish` (`src/app.ts:575`) calls `publishVersion`
  (`src/domain/videos.ts:722`). It needs `video:publish` (`src/domain/policy.ts:35`; owners and admins), a ready
  version and its output. It inserts a `publications` row (slug, job, version, who, when, `showTranscript`) and
  writes a mirror to the `internal` store at `pub/{slug}.json`, which `public.ts` reads on every request (so
  unpublishing is immediate). Publishing again only changes `showTranscript`.
- `DELETE …/publish` (`unpublishVersion`, `src/domain/videos.ts:804`) sets `unpublishedAt`. Deleting a video ends
  every publication (`deleteVideo`, `src/domain/videos.ts:658-672`).
- The Version DTO carries `publications: PublicationSchema[]` (`src/schemas.ts:135`, `:390`) with the share URLs and
  embed HTML. The UI shows a Publish button (`PublishButton`, `ui/src/components/PublishDialog.tsx`, used at
  `ui/src/pages/Video.tsx:794`) and a public-link card (`PublicLink`, `Video.tsx:424`). MCP has `publish_video` and
  `unpublish_video` (`src/mcp-catalog.ts:56-60`).
- Webhooks: `emitEvent` writes an event plus one delivery row per destination in the caller's transaction; the
  sweep (`deliverWebhooks`, 20 s budget, 20 items) delivers with a lease, backoff (`backoffMs`) and a 24-hour
  deadline. Event types: `video.ready`, `video.failed`, `comment.created`, `version.approved`,
  `version.changes_requested` (`src/domain/types.ts:850`). The sweep never moves bytes; background functions do.
- Webhook URLs must be `https:` (`checkUrl`, `src/domain/webhook-settings.ts:9`). Personal webhooks are set on the
  Keys page (`WebhookCard`), the team webhook by admins.

## 2. The model

### 2.1 Destination kinds

| Kind         | Who sets it up                                                            | Auth                                             | In the open-source app                                       |
| ------------ | ------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| `share_page` | Always on                                                                 | None                                             | Yes. Wraps today's `publishVersion`; no change in behaviour. |
| `youtube`    | Admin enables it when `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are set | Each publisher connects their own Google account | Yes                                                          |
| `http`       | Admin adds any number (name, URL, secret, options form)                   | A signing secret (ours)                          | Yes                                                          |

The internal Netlify-site channel is an `http` destination. Nothing about site-vendor or revenue-engine appears in
the app's code, only in its configuration.

### 2.2 The interface (server side)

```ts
interface DestinationKind {
  kind: 'share_page' | 'youtube' | 'http'
  /** The options a publisher can set, as a JSON-Schema subset the UI renders (§6.3). */
  optionsSchema(d: DestinationRow): OptionsSchema
  /** True when this principal can publish here now (e.g. YouTube: has a live connection). */
  ready(ctx: {
    d: DestinationRow
    principal: Principal
    repo: Repo
  }): Promise<{ ok: true } | { ok: false; reason: string }>
  /**
   * One step of work. Returns the next state; `state` is saved between steps, so a step can resume after a crash
   * or a timeout (a YouTube upload session URL, a receiver's external id).
   */
  publish(ctx: PublishCtx): Promise<StepResult>
  unpublish(ctx: PublishCtx): Promise<StepResult>
}

type StepResult =
  | { status: 'live'; url: string | null; externalId: string | null; state?: object }
  | { status: 'waiting'; checkAfterSec: number; state?: object } // processing elsewhere; poll or await a callback
  | { status: 'retry'; error: string; state?: object } // transient; backoff
  | { status: 'failed'; error: string } // permanent
  | { status: 'removed' }
```

`PublishCtx` has the destination row, its decrypted secret, the publication row, the version and output rows, the
video DTO (the same one webhooks send), the publisher's connection (YouTube), `options`, a `files()` helper that
mints signed links (`/files/{jobId}/v{n}/…`, one hour), and a `read(file)` stream from the `videos` store for kinds
that upload bytes themselves.

### 2.3 Data

New migration (`netlify/database/migrations/<ts>_publish_destinations`), Drizzle in `db/schema.ts`, store methods in
`src/store/{types,memory,drizzle}.ts`:

```
destinations
  id text pk                       dst_…; 'share_page' and 'youtube' are fixed ids
  kind text                        share_page | youtube | http
  name text                        "Netlify demo site", shown in Publish ▾
  enabled boolean
  url text null                    http only, https:// (checkUrl)
  secret_enc text null             http only; shown once on create/rotate, like webhook secrets
  options_schema jsonb null        http only (§6.3)
  created_by, created_at, updated_at

destination_connections            a person's account at a destination (YouTube)
  id text pk
  user_id text, destination_id text      unique (user_id, destination_id) in v1: one channel per person
  account_label text               "Netlify Developers (@netlifydevs)"
  token_enc text                   refresh token (encrypted); access tokens are not stored
  scopes text[]
  created_at, updated_at, revoked_at null

destination_publications
  id text pk                       dpub_…
  job_id, version_n, destination_id
  status text                      queued | running | waiting | live | failed | removing | removed
  options jsonb                    what the publisher chose (title override, privacy, site name…)
  state jsonb null                 the kind's resumable state
  external_id text null            YouTube video id, the receiver's id
  url text null                    the public URL there
  error text null
  attempts int, next_run_at ts null, lease_until ts null, deadline_at ts
  callback_token_hash text null    http only (§3.3)
  published_by, created_at, updated_at, live_at null, removed_at null
  index (job_id), partial index (next_run_at) where status in (queued, running, waiting, removing)
  unique (job_id, version_n, destination_id) where status not in (failed, removed)
```

The `share_page` kind keeps writing `publications` and the `pub/{slug}.json` mirror exactly as today; its
destination publication row points at the slug in `external_id` and goes `live` in the same request (no background
step). So existing share links, embeds, the oEmbed work in the CLI plan and the transcript choice don't change.

### 2.4 Running the work

- `publishToDestination` (the route, §6.1) checks `video:publish`, a ready version, `destination.enabled`, and
  `kind.ready()`; then inserts the row as `queued` with `next_run_at = now` and dispatches
  `publish-background` (a new background function, signed like `finalize-background`, through a new
  `PlatformPort.dispatchPublish(id)`). `share_page` runs inline instead.
- `publish-background` takes a lease on the row, runs `publish` (or `unpublish`) step by step until it returns
  something other than a quick `live` / `retry`, saves `state`, and stops. Background functions get 15 minutes,
  which covers any upload this app makes.
- The sweep (`netlify/functions/sweep.ts`) gains `duePublications(deps, budget)`: it never runs steps itself (it
  never moves bytes); it re-dispatches rows whose `next_run_at` has passed and whose lease has expired, and fails
  rows past `deadline_at` (24 hours, like webhooks; 72 hours for `waiting` on YouTube processing).
- `retry` uses `backoffMs`. `failed` is final; the UI offers **Try again** (a new row).
- Unpublishing sets `removing` and dispatches the same way. Deleting a video sets every live row to `removing`.
- Each status change emits a webhook event (§6.4), inside the same transaction.

## 3. The HTTP destination (the open-source seam)

### 3.1 Request

`POST {destination.url}` with `content-type: application/json` and
`X-Video-Agent-Signature: t=<unix>,v1=<hex>` (the same scheme and helper as webhooks, with the destination's secret).

```jsonc
{
  "event": "publish", // or "unpublish"
  "id": "dpub_…", // stable across retries: the receiver's idempotency key
  "destination": { "id": "dst_…", "name": "Netlify demo site" },
  "options": { "site": "acme-launch" }, // what the publisher filled in (§6.3)
  "video": {/* the Video DTO webhooks send */},
  "version": 3,
  "title": "…",
  "summary": "…",
  "files": {
    // signed, valid for one hour
    "mp4": "https://…/files/vid_…/v3/video.mp4?exp=…&sig=…",
    "poster": "…",
    "posterWebp": "…",
    "gif": "…",
    "captions": "…",
    "narration": "…",
    "transcript": "…", // only when the version has them (transcript: only if shown)
  },
  "sharePage": "https://…/v/abc123", // when the version is also on the share page, else null
  "callback": { "url": "https://…/api/v1/destination-publications/dpub_…/callback", "token": "dpc_…" },
  "externalId": null, // on unpublish: what the receiver returned before
}
```

### 3.2 Responses

| Receiver answers                                          | Meaning                                                           |
| --------------------------------------------------------- | ----------------------------------------------------------------- |
| `200 { "status": "live", "url": "…", "externalId": "…" }` | Done now.                                                         |
| `202 { "status": "accepted", "externalId": "…"? }`        | Working on it; it will call back. Row goes `waiting`.             |
| `200`/`204`/`404` to `unpublish`                          | Removed (404: already gone).                                      |
| `408`, `429`, `5xx`, timeout (30 s), network error        | `retry` with backoff, until the deadline.                         |
| Other `4xx`                                               | `failed`, with the first 500 characters of the body as the error. |

### 3.3 Callback and fresh links

- `POST /api/v1/destination-publications/{id}/callback` with `authorization: Bearer <token>` (the token from the
  request; we store only its hash) and `{ "status": "live" | "failed", "url"?, "externalId"?, "message"? }`.
  Idempotent; a late callback for a row already `removed` is ignored.
- `POST /api/v1/destination-publications/{id}/files` with the same token returns a fresh `files` object, for a
  receiver that needed longer than an hour to copy.
- Both routes are public (no session or API key), rate-limited, and only work while the row is `waiting` or `running`.

### 3.4 Admin setup

Admin → **Destinations** → Add an HTTP destination: name, URL (`https:` only, `checkUrl`), and an optional options
form. The secret is shown once (as for webhooks), with **Rotate** and **Send a test** (an `event: "ping"` with no
files; the receiver must answer 2xx). Disabling hides it from Publish ▾ and refuses new publications; existing rows
can still be unpublished.

## 4. YouTube

- **Setup (admin):** a Google Cloud project with the YouTube Data API v3, an OAuth web client whose redirect URI is
  `{site}/auth/google/callback`, and `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in the site's env. Without them,
  the `youtube` destination doesn't exist and `features` doesn't list `youtube`. The admin page links to a setup
  guide (`/docs/destinations`).
- **Connecting (each person):** Settings → **Connected accounts** → Connect YouTube. A standard OAuth 2.0 web flow
  (PKCE, `access_type=offline`, `prompt=consent`), scopes `youtube.upload` (upload, thumbnail) and
  `youtube.force-ssl` (captions). We store the refresh token encrypted and the channel title as `account_label`.
  Disconnect revokes the token at Google and deletes it here.
- **Publishing (one step per call, resumable):**
  1. `videos.insert` as a **resumable upload**: create the session (metadata: title, description, tags, category,
     `privacyStatus` from options, default **unlisted**; `selfDeclaredMadeForKids: false` unless the publisher says
     otherwise), save the session URL in `state`, then stream `video.mp4` from the `videos` store in 8 MB chunks.
     A crash resumes from the last acknowledged byte.
  2. `captions.insert` with the version's current captions VTT (its language from the video's settings).
  3. `thumbnails.set` with the poster. Custom thumbnails need a verified channel; a `403` here is a warning on the
     row, not a failure.
  4. `waiting` until `videos.list(part=processingDetails,status)` says processed, then `live` with
     `https://youtu.be/{id}`.
     The description is the version's summary plus the share page link when it's published, and the CC BY credits
     the share page shows (`versionCredits`), which the licences require.
- **Unpublishing:** option on the dialog, default **make private** (`videos.update` status), or **delete from
  YouTube** (`videos.delete`). Deleting the video here makes it private there; it never deletes on its own.
- **Limits to plan around:**
  - Google says videos uploaded through `videos.insert` from **unverified API projects created after
    28 July 2020 are restricted to private** until the project passes a compliance audit. Until then, the dialog
    forces private and says why. Start the audit early (spike P5).
  - **Quota:** the reference has long listed `videos.insert` at 1,600 units of the default 10,000 a day (about six
    uploads a day per project); third-party sources say it has since dropped. Read the real numbers in the Cloud
    console (spike P4) and show "uploads left today" from our own count if it's still tight. `uploadLimitExceeded`
    and `quotaExceeded` become `retry` with a next-day `next_run_at`, not `failed`.
  - The OAuth consent screen needs Google's verification for these scopes before more than 100 people can connect.
- **Who it posts as:** always the person who clicks Publish, to their own connected channel. An admin publishing
  someone else's video posts to the admin's channel.

## 5. Internal: the Netlify site destination (not in the public snapshot)

This part lives in revenue-engine. In this repo it's only an HTTP destination an admin adds. When this plan goes
into the public snapshot, drop this section (see [going public](2026-11-02-going-public.md), the `docs/plans/`
item).

### 5.1 site-vendor today (facts)

`services/site-vendor` (AWS Lambda + API Gateway HTTP API + DynamoDB; Hono app in `src/app.ts`) owns **site identity
and lifecycle** for a tenant's Netlify team (`netliclaw`): `POST /sites/ensure` (idempotent on `ownerKey`, lease
state machine, 201 created / 200 reused / 409 `provisionInProgress`), `GET /sites/:ownerKey`, `…/live`,
`…/builds/retry`, `…/protect`, `…/retract` (`lock` | `delete`), and deploy notifications. Sites are public by
default. It can create a site **linked to a pinned git ref** that Netlify builds (`EnsureRepoSourceSchema`,
`src/core/types.ts`; smoke in `scripts/smoke-git-template.ts`). It does **not** upload files; Revenue Engine
deploys files to Netlify itself. The tenant's Netlify token lives in SSM. The API Lambda has a **29 s timeout**
(`serverless.yml:44`); API Gateway and Lambda also cap request bodies (about 10 MB and 6 MB), so a 30–50 MB MP4
can't go through a request.

### 5.2 New in site-vendor: blobs on a vended site

The video goes into the vended site's own Netlify Blobs (a site-wide store, `site-files`), written with the
tenant's token (`@netlify/blobs` with `siteID` + `token` works outside Netlify). site-vendor **pulls** the file from
a signed link rather than receiving it:

| Route                                                                            | What it does                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /sites/:ownerKey/blobs` `{ key, sourceUrl, contentType, sha256?, bytes? }` | Records a `pending` blob op and async-invokes a new `blob-copy` Lambda (timeout 900 s). Returns `202 { key, status: "pending" }`. Same key + same `sha256` while pending or done: returns the existing op (idempotent). |
| `PUT /sites/:ownerKey/blobs/:key` (JSON body ≤ 256 KB)                           | Writes a small blob inline (the site's `site.json`).                                                                                                                                                                    |
| `GET /sites/:ownerKey/blobs/:key`                                                | `{ status: pending \| done \| failed, bytes, sha256, error? }`                                                                                                                                                          |
| `GET /sites/:ownerKey/blobs`                                                     | The site's blobs (key, bytes, updated).                                                                                                                                                                                 |
| `DELETE /sites/:ownerKey/blobs/:key`                                             | Deletes it.                                                                                                                                                                                                             |

- `blob-copy` streams `fetch(sourceUrl)` into the blob store (no buffering the whole file), checks `bytes` and
  `sha256` when given, and marks the op done or failed. Retries a failed fetch twice.
- **Safety:** `sourceUrl` must be `https:` and its host must be on the tenant row's `blobSourceHosts` list (for us,
  the video agent's host). Keys are `[a-z0-9/._-]{1,200}`. One file at most 500 MB.
- **Guardrails** (alarms, not caps, like the rest of site-vendor): EMF metrics `blobBytesWritten` and per-site total
  bytes; an alarm on a site over 5 GB or a tenant writing over 20 GB a day.
- `retract delete` deletes the site and its blobs with it. `retract lock` leaves them; the password covers them.
- The record (`ProvisionedSite`) doesn't list blobs; the blob store is the source of truth for what's there.

### 5.3 The site template

A new template repo (name to pick, e.g. `netlify-labs/video-site-template`), linked through site-vendor's git
mode at a pinned ref and built once per site:

- `index.html` + a little JS that reads `/site.json` and renders the video(s): `<video>` with poster, captions
  track, title, summary, credits; one video or a list.
- `netlify/edge-functions/blob.ts` on `/v/*` and `/site.json`: reads the `site-files` store and streams it with
  range requests (a port of `mediaResponse` from `src/lib/media/range.ts`, which already does this for the share
  page), `cache-control` short and `etag` from the blob's sha.
- `site.json`:
  ```json
  {
    "v": 1,
    "title": "…",
    "videos": [
      {
        "id": "dpub_…",
        "title": "…",
        "summary": "…",
        "mp4": "/v/dpub_…/video.mp4",
        "poster": "/v/dpub_…/poster.jpg",
        "captions": "/v/dpub_…/captions.vtt",
        "width": 1920,
        "height": 1080,
        "durationSec": 74,
        "credits": []
      }
    ]
  }
  ```
- Because the content is all in blobs, publishing, replacing or removing a video **never rebuilds the site**.

### 5.4 The receiver

A route in revenue-engine (`services/api`, or a small service of its own) that the HTTP destination points at:

1. Verify `X-Video-Agent-Signature` with the shared secret; reject anything older than 5 minutes.
2. `publish`:
   1. Work out the `ownerKey`: per video (`video-agent#{videoId}`) by default; a "site" option groups many videos
      under one site (`video-agent#site#{slug}`).
   2. `POST /sites/ensure` with the template repo link and a desired name from the options or the video title. On
      `409` with `Retry-After`, answer the video agent `503` so it retries.
   3. `POST /sites/:ownerKey/blobs` for `mp4`, `poster`, `captions` under `v/{dpub id}/…`.
   4. Answer `202 accepted`, then (async) wait for the blob ops and the site's first build (`…/live` or deploy
      notifications), write `site.json` with the video added (read, modify, `PUT`), and call back `live` with the
      site URL (plus `#dpub_…` when the site holds several).
3. `unpublish`: remove the entry from `site.json`, delete its blobs, answer `200`. The site stays (retracting a site
   is a deliberate act in RE, not a side effect).
4. Options form for the destination: `site` (string, optional: group under this site), `name` (string, optional:
   the site's name), `password` (boolean, default false; see §9).

## 6. Product surface

### 6.1 API (all with `operationId`s)

| Route                                                                                               | operationId                                           | Who                                                                       |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------- |
| `GET /api/v1/destinations`                                                                          | `listDestinations`                                    | Signed in. Enabled destinations with `ready` and `reason` for the caller. |
| `POST /api/v1/videos/{id}/versions/{n}/destinations/{destId}` `{ options }`                         | `publishToDestination`                                | `video:publish`                                                           |
| `DELETE /api/v1/videos/{id}/versions/{n}/destinations/{destId}` `{ mode? }`                         | `unpublishFromDestination`                            | `video:publish`                                                           |
| `POST /api/v1/destination-publications/{id}/retry`                                                  | `retryDestinationPublication`                         | `video:publish`                                                           |
| `POST /api/v1/destination-publications/{id}/callback`                                               | `destinationCallback`                                 | Callback token                                                            |
| `POST /api/v1/destination-publications/{id}/files`                                                  | `destinationFiles`                                    | Callback token                                                            |
| `GET/POST/PATCH/DELETE /api/v1/admin/destinations[/{id}]`, `POST …/{id}/rotate`, `POST …/{id}/test` | `…Destination(s)`                                     | Admin                                                                     |
| `GET /api/v1/me/connections`, `DELETE /api/v1/me/connections/{id}`                                  | `listConnections`, `deleteConnection`                 | Signed in                                                                 |
| `GET /auth/google/start`, `GET /auth/google/callback`                                               | (not in the OpenAPI spec, like the other auth routes) | Signed in                                                                 |

The existing `POST`/`DELETE …/publish` routes stay as they are (the share page), so the SDK, CLI, MCP and docs keep
working. The Version DTO gains `destinations: DestinationPublication[]` (id, destination id/name/kind, status, url,
error, publishedAt, liveAt), additive under shared rule 10.

### 6.2 UI

- **Publish ▾** on a ready version (where `PublishButton` is today, `Video.tsx:794`): "Share page" first (today's
  dialog), then each enabled destination. A destination that isn't `ready` shows why ("Connect YouTube first" with a
  link to Connected accounts).
- Each destination opens a dialog: its options form, and for YouTube the channel it will post to, privacy (default
  unlisted; forced private while the project is unaudited), made for kids, and "Also add captions" (on).
- **Published to** under the version (next to `PublicLink`): one line per destination publication with status,
  link, and Unpublish / Try again. `waiting` shows "Processing on YouTube" or "Building the site".
- The library's published badge (`Video.tsx:337`) counts any `live` destination.
- **Settings → Connected accounts:** YouTube (Connect / channel name / Disconnect). Only shown when the feature is on.
- **Admin → Destinations:** the list, Add HTTP destination, enable YouTube (with a setup checklist), rotate, test.

### 6.3 Options forms

A small JSON-Schema subset so the UI can render it and the server can check it without a new dependency: an object
of at most 10 properties, each `string` (with `maxLength`, optional `enum`), `boolean`, or `integer` (with `minimum` /
`maximum`), with `title`, `description`, `default`, and `required`. The server validates with a hand-written checker
(`src/lib/options-schema.ts`) and refuses unknown keys.

### 6.4 Webhooks, MCP, CLI, SDK

- New webhook event types: `destination.live`, `destination.failed`, `destination.removed`, with the destination
  publication in `data`. (HTTP destinations don't get webhooks for their own rows; they already know.)
- MCP: `publish_video` gains an optional `destination` (id), and a new `list_destinations` tool.
- CLI (cli-and-sdk plan): `publish <video> --to <destination>` and `destinations` (list). SDK rows:
  `destinations.list`, `versions.publishTo`, `versions.unpublishFrom`.
- `features` gains `destinations` (always, once phase 1 lands) and `youtube` (when configured).

## 7. Phases

1. **Destinations groundwork (no new channels).** The migration and store methods; the `DestinationKind`
   interface; `share_page` as a kind (inline, writes `publications` as today); `publish-background` +
   `dispatchPublish`; the sweep's `duePublications`; the routes in §6.1 except YouTube's; Publish ▾ and Published
   to, showing only the share page. **Tests:** memory and PGlite store tests; the share page through the new route
   gives the same `publications` row and mirror as the old one; deleting a video moves rows to `removing`;
   `operationId` uniqueness; Playwright: Publish ▾ → Share page publishes and unpublishes as today.
2. **HTTP destinations.** Admin page (add, rotate, test, disable), the options-schema checker, signing, the
   request and response table in §3.2, callback and fresh-files routes. **Tests:** a fake receiver in the harness
   for each row of §3.2 (live now, accepted then callback, 429 then live, 400 failed, timeout retry, deadline),
   callback token checks (wrong token, wrong state, replay), signature verification with the documented scheme,
   options validation; Playwright: add a destination, publish with options, see `waiting` then `live` (mock server).
   **Docs:** `/docs/destinations` with the HTTP contract and a 40-line example receiver.
3. **Internal: Netlify site (revenue-engine).** site-vendor blob routes and `blob-copy` (§5.2) with unit tests on
   the fakes in `tests/helpers/fakes.ts` and a gated real-Netlify smoke like `smoke-git-template.ts` (create a site,
   copy a 40 MB file, range-read it through the edge function, delete the site in `finally`); the template repo
   (§5.3); the receiver (§5.4); then add it in production as an HTTP destination. Needs spikes P1–P3.
4. **YouTube.** Google OAuth and Connected accounts, the `youtube` kind (§4), its dialog, quota handling. **Tests:**
   a fake Google (OAuth token endpoint, resumable upload with a forced mid-upload failure and resume, captions,
   thumbnail 403 as a warning, processing → live, quota errors → next-day retry, revoke on disconnect).
   One manual run against a real test channel before turning it on. Start the Google audit (P5) during phase 1.

## 8. Spikes

- **P1** Write a 50 MB object to another site's Netlify Blobs from outside Netlify with a PAT (`@netlify/blobs`,
  `siteID` + `token`), streaming, from a Lambda; measure time; confirm the per-object limit.
- **P2** Two or more sites created by site-vendor linked to the **same** template repo and pinned ref (no per-site
  repo copy): does the GitHub-app link allow it, and does each build independently?
- **P3** On a vended site: an edge function streaming a blob with range requests (seek in Safari and Chrome), with
  and without site password protection.
- **P4** YouTube: a resumable upload from a Netlify background function, captions and thumbnail, with the project's
  real quota numbers from the Cloud console.
- **P5** Google: what the YouTube API compliance audit and the OAuth verification for `youtube.upload` /
  `youtube.force-ssl` need from us (privacy policy, terms, a demo video) and how long they take.

## 9. Open questions (owner)

1. **One site per video, or one per person or campaign?** The plan supports both (the receiver's `site` option);
   which is the default?
2. **Password-protected sites:** site-vendor shows a password once. Where should the publisher see it? Options: the
   callback's `message` shown once in the dialog (never stored), or leave protection to RE's own UI.
3. **YouTube default privacy:** unlisted (planned) or private?
4. **YouTube description:** summary + share link + credits (planned). Anything else, such as a fixed footer the admin
   sets?
5. **Who can use HTTP destinations:** everyone with `video:publish` (planned), or a per-destination allowlist?

## 10. Risks

- **Google's audit is the long pole.** Until it passes, YouTube uploads are private only. Mitigation: start it in
  phase 1; ship phase 4 with "private until approved" stated in the dialog.
- **A receiver that never calls back.** Rows fail at the deadline with a clear error; Try again makes a new row.
- **Links expiring mid-copy.** One hour, plus the fresh-files route.
- **Secrets:** destination secrets and refresh tokens are encrypted with the same key as webhook secrets; never
  logged; tests assert they don't appear in logs or DTOs.
- **Scope creep in site-vendor.** Blob routes are generic (any tenant, any site it vended), so they also serve
  Netlify Artifacts later, but they are the first byte-moving work there. Keep `blob-copy` separate from the API
  Lambda so a big copy can't eat the API's 29 s.
