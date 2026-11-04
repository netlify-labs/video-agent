# Publish destinations: the share page, YouTube, and your own sites — plan

- **Status:** draft 3 (2026-11-04). Not started. No beads yet.
  - Draft 1: written against the code.
  - Draft 2: the owner's answers to draft 1's open questions; targets made fully generic at the owner's request.
  - Draft 3: two remote reviews of draft 2 (commit `2e1d06c`) through `nax run agent`, review only:
    - Claude Fable 5.1, high effort: "sound with changes", 923 credits.
    - Codex `gpt-6.1-sol`, high effort: "needs rework", 226 credits.

    Every finding was checked against the code or the web before it was folded in. §13 logs what was adopted and
    rejected.
- **Ask (owner, 2026-11-04):** someone asked for "a button to post to YouTube". The owner widened it:
  - Publishing today only means the share page on this app. We want **one generic publishing interface** where the
    share page, YouTube and others are channels. YouTube needs the person to connect their account so we can upload
    for them.
  - A second channel: **build a Netlify site with the video in it**, using the internal site-vendor service
    (revenue-engine `services/site-vendor`). That one is internal and must not be part of the open-source app, but
    it has to slot into the same interface. site-vendor gains a way to **upload blobs to a site it created**, and the
    video goes there.
  - People can **add a video to a site they already have**. Optionally, an **agent run works it into the site's
    design**, from a default prompt plus where the person wants it.
  - The generic interface, and especially the list of existing places, must be **generic**: id, name,
    description, link and opaque metadata, with nothing specific to sites.
- **Builds on:**
  - Publishing: `publishVersion` / `unpublishVersion` (`src/domain/videos.ts:722-815`), the `publications` table
    (`db/schema.ts:202`) and the share page (`netlify/edge-functions/public.ts`).
  - The webhook outbox: `src/domain/webhooks.ts`, `webhook_deliveries` (`db/schema.ts:649`), the claim method
    (`claimDueWebhookDeliveries`, `src/store/types.ts:324`) and the every-minute sweep (`netlify/functions/sweep.ts`).
  - Pinned outbound HTTP (`src/adapters/http.ts`), signed file links (`src/domain/files.ts`,
    `netlify/edge-functions/files.ts`), webhook signing (`webhookSignature`, `src/lib/crypto.ts:43-45`) and secret
    storage (`encrypt` / `decrypt`, `src/lib/crypto.ts:55-79`).
  - The background-function dispatch pattern (`PlatformPort.dispatchFinalize`, `src/adapters/platform.ts:28-35`).
- **Follows the shared rules** in the [roadmap](2026-11-04-roadmap.md):
  - every new route has an `operationId`;
  - the feature strings are `destinations` and `youtube`;
  - the Version DTO only grows (a new `destinations` field next to `publications`);
  - spike labels are `P`, which doesn't collide with `S`, `C`, `K`, `E`, `B`, `D` or `A`.

  It depends on cli-and-sdk phase 1 (operationIds, `features`) the same way the six plans do.

- **Words:**
  - People see **Publish ▾**, **Published to**, **Connected accounts** and **Destinations** (admin).
  - Code and the API say **destination** (a configured channel), **destination publication** (one version sent to one
    target of one destination) and **operation** (one publish or removal attempt at it).
  - "Delivery" stays the webhook word.

---

## 0. What it is, in one paragraph

A **destination** is somewhere a ready version can be published. There are three kinds:

- the **share page** (built in; today's behaviour, unchanged);
- a person's **YouTube channel** (built in; needs a connected Google account);
- an **HTTP destination** that an admin points at any HTTPS endpoint.

Publishing a version to a destination makes a **destination publication**. A worker drives it towards what the
person wants (published, or removed) through **operations**. Each operation has its own id, so a receiver can retry
safely. A fenced lease means a stale worker or a late callback can't undo a newer decision.

The HTTP destination is the open-source seam. The app sends a signed request with a **minimal** description of the
version (not the whole Video DTO) and signed links to its files, each with its size and SHA-256. The receiver answers
now or calls back later.

A destination may also list **targets**: things it already holds for this person (id, name, description, URL,
opaque metadata). It may also take free-text **instructions**. The app never knows what a target is.

Netlify's internal "Netlify site" channel is an HTTP destination whose receiver lives in revenue-engine:

- it uses site-vendor, which gains **blob uploads**;
- the video lives in the vended site's own Netlify Blobs, and an edge function on that site streams it;
- with instructions, an Agent Runner run works the video into the site's design.

## 1. Facts this plan relies on (checked 2026-11-04)

**Publishing today**

- `POST /api/v1/videos/{id}/versions/{n}/publish` (`src/app.ts:575`) calls `publishVersion`
  (`src/domain/videos.ts:722`).
  - It needs `video:publish` (`src/domain/policy.ts:35,68`; creators who own the video, and admins) and a ready
    version with its output.
  - It inserts a `publications` row and writes `pub/{slug}.json` to the `internal` store.
  - `public.ts` reads that mirror on every request (`public.ts:57`), so unpublishing is immediate.
  - Publishing again only changes `showTranscript` (`videos.ts:737-748`).
  - It does **not** check `job.private`.
- `DELETE …/publish` (`videos.ts:804`) sets `unpublishedAt`.
- `deleteVideo` (`videos.ts:658-690`):
  - ends every publication;
  - immediately queues `delete_prefix` cleanup for the `videos`, `sources` and `bundles` stores;
  - after it, `loadJob` refuses the video (`videos.ts:387-390`).
- The Version DTO carries `publications` (`src/schemas.ts:135,390`).
- The video ETag is `job.id`, `job.version` and a few viewer bits (`videos.ts:1107`).
- The video page stops polling once the video is ready (`ui/src/pages/Video.tsx:543`).
- Where "published" shows up:
  - The library's published marker reads `publications` (`ui/src/pages/Library.tsx:106`), and so does the
    filmstrip's (`Video.tsx:337`).
  - The `published` filter is in both stores (`src/store/drizzle.ts:189`, `src/store/memory.ts:230`).
- The Video DTO also holds the owner's email, every version's prompt and plan, and incorporated feedback
  (`videos.ts:890-1101`). It is not something to send to a third party.

**Files**

- Signed file links come from `signedFilePath` (`src/domain/files.ts:74`):
  - The default lifetime is 600 s.
  - Public videos can get up to 3,600 s (`PUBLIC_URL_TTL_SEC`).
  - Private videos are capped at 600 s and bound to the job's access epoch (`files.ts:36,51,66`), so a privacy
    change invalidates them.
- Outputs can be up to 2 GiB (`MAX_VIDEO_BYTES`, `src/domain/finalize.ts:51`). Each file's SHA-256 is recorded on
  the output (`o.sha256`).
- `BlobsPort.get` returns a whole `Uint8Array` (`src/deps.ts:142`). Streaming a large file needs a new port method.

**Webhooks and outbound HTTP**

- `emitEvent` writes the event and its deliveries in the caller's transaction, and returns early for a deleted
  video (`webhooks.ts:24-83`, `:38`).
- Deliveries:
  - lease 60 s, backoff `backoffMs` capped at 1 h, deadline 24 h (`webhooks.ts:14-16,109`);
  - delivery timeout 10 s (`:192`);
  - claimed atomically (`claimDueWebhookDeliveries`).
- The signature is `X-Video-Agent-Signature: t=<unix>,v1=<hex>`, an HMAC-SHA256 over `"<t>." + body`
  (`crypto.ts:43-45`).
- Webhook HTTP (`HttpPort.postJson`, `src/adapters/http.ts`):
  - is https only;
  - pins the DNS answer it validated and refuses private addresses and redirects;
  - **discards the response body** (`http.ts:104-110`).
- `FetchPort` validates DNS but resolves again inside `fetch`, so it doesn't pin.
- Webhook URLs must be `https:` (`checkUrl`, `src/domain/webhook-settings.ts:9`).
- Every `/api/v1` route except `/config` goes through `requireAuth` (`src/app.ts:237`).
- `publishToDestination` can take `idempotency-key` like the create routes (`app.ts:139,344`).

**Agent runs**

- This app starts Agent Runner runs through `nax-agent-runner-sdk` with `land: 'none'` (`src/adapters/runner.ts:11-16`).
- The SDK's landing modes are `'pr' | 'merge' | 'publish' | 'none' | 'auto'`
  (`node_modules/nax-agent-runner-sdk/dist/domain.d.ts:25`).
  - GitHub `merge` needs a GitHub token.
  - Netlify Git `publish` is a separate path (SDK README).
  - Polling a run and landing it are separate calls.

**Platform limits**

- Netlify background functions get 15 minutes. Netlify retries an errored invocation after 1 and 2 minutes.

**YouTube (web, 2026-11-04)**

- **Uploads from unverified API projects are no longer forced private.** Google reversed the July 2020 policy on
  2026-11-02 (revision history, and the `videos.insert` reference).
- **Quota:**
  - `videos.insert` has its own bucket: 100 calls a day, 1 unit each.
  - Everything else shares 10,000 units a day. `captions.insert` costs 400, `thumbnails.set` 50, `videos.update`
    50, `videos.delete` 50 and `videos.list` 1.
  - Daily quota resets at midnight Pacific time.
- **Scope:** `youtube.force-ssl` covers `videos.insert`, `captions.insert`, `thumbnails.set`, `videos.update` and
  `videos.delete`. `captions.insert` accepts only `force-ssl` (or `youtubepartner`).
- **Resumable uploads:**
  - Chunks are multiples of 256 KiB.
  - To resume, send an empty `PUT` with `Content-Range: bytes */N`. A `308` with a `Range` header says how much
    arrived.
  - An expired session returns `404`.
- **Processing:** `processingDetails.processingStatus` is `processing | succeeded | failed | terminated`.
  `status.uploadStatus` includes `rejected` and `failed`.
- **Thumbnails:**
  - Custom thumbnails need a verified channel; otherwise `403`.
  - For Shorts, `thumbnails.set` must wait until processing has succeeded.
- **Limits:** a title is at most 100 characters and a description at most 5,000 bytes, with no `<` or `>` in either.
- **OAuth:**
  - An unverified app can have at most 100 users.
  - While the consent screen is in **Testing**, refresh tokens expire after 7 days.
  - Each Google account can hold 100 refresh tokens per client.

**Netlify Blobs**

- `getStore(name, { siteID, token })` works outside Netlify.
- An object can be up to 5 GB; a key up to 600 bytes.
- Reads are eventually consistent (up to 60 s) unless `consistency: 'strong'`.
- The only concurrency control is `onlyIfMatch` (by ETag) and `onlyIfNew`.

**site-vendor** (revenue-engine `b65b0596`, identical to `origin/master`; checked locally, because neither reviewer
received it)

- It is a Hono app on Lambda behind API Gateway HTTP API (`src/app.ts`), with a provider-wide 29 s timeout
  (`serverless.yml:44`).
- Ensuring a site: `POST /sites/ensure`, idempotent on `ownerKey`, takes `labels` and `protection`
  (`src/core/types.ts:97-98`). Protection can be set **at creation**.
- Other routes:
  - `GET /sites/:ownerKey` and `…/live`;
  - `…/builds/retry`, `…/protect`, `…/retract` (`lock | delete`);
  - deploy notifications.
- It can link a site to a git repo at a pinned ref (`EnsureRepoSourceSchema`).
- It does not upload files.
- Request bodies are capped at 10 MB by API Gateway and 6 MB by Lambda.

## 2. The model

### 2.1 Destination kinds

| Kind         | Stored as                                               | Auth                                      | In the open-source app |
| ------------ | ------------------------------------------------------- | ----------------------------------------- | ---------------------- |
| `share_page` | Built in, not a row. Its state stays in `publications`. | None                                      | Yes, unchanged         |
| `youtube`    | Built in, not a row. `youtubeEnabled` in `settings`.    | Each publisher's connected Google account | Yes                    |
| `http`       | A row in `destinations`, as many as an admin adds       | A signing secret (ours)                   | Yes                    |

The internal Netlify-site channel is an `http` row. Nothing about site-vendor, sites or agents appears in the app's
code or copy, only in that row's configuration and in the receiver.

### 2.2 The interface (server side)

```ts
interface DestinationKind {
  kind: 'share_page' | 'youtube' | 'http'
  /** What the publisher can set when publishing, and when removing (YouTube: make private only in v1). */
  optionsSchema(d: Destination): OptionsSchema
  unpublishOptionsSchema(d: Destination): OptionsSchema | null
  /** Can this person publish this version here now? Reasons are shown as-is ("Connect YouTube first"). */
  ready(ctx: ReadyCtx): Promise<{ ok: true } | { ok: false; reason: string }>
  /** Things this person already has there (optional). */
  targets?(ctx: TargetsCtx): Promise<Target[]>
  /** One bounded step of an operation (one HTTP call, one upload chunk). */
  step(ctx: StepCtx): Promise<StepResult>
}

type StepResult =
  | { status: 'continue'; state: object } // more steps now (another chunk)
  | { status: 'waiting'; state: object; checkAfterSec: number | null; message?: string } // elsewhere; poll or callback
  | { status: 'retry'; state?: object; error: SafeError; retryAfterSec?: number } // transient
  | { status: 'live'; url: string | null; externalId: string | null; warnings?: string[] } // publish done
  | { status: 'removed' } // removal done
  | { status: 'failed'; error: SafeError } // permanent

/** Generic on purpose: the app shows name, description and url, and never reads metadata. */
interface Target {
  id: string // the destination's own id, opaque to the app (≤ 200 characters)
  name: string // shown in the picker (≤ 200)
  description: string | null // a second line in the picker (≤ 500)
  url: string | null // https only; shown as a link
  /** The destination's own data, sent back verbatim when this target is chosen. Flat: string, number, boolean or
   * null values; at most 20 keys and 2 KB as JSON. Never shown, never interpreted, never trusted. */
  metadata: Record<string, string | number | boolean | null> | null
}

/** A short code plus plain text we wrote or validated (≤ 300 characters). Never a raw receiver body. */
type SafeError = { code: string; message: string }
```

`StepCtx` has:

- the destination and the publication row (with its pinned connection and pinned destination revision), the
  operation (action, generation, fence) and its saved `state`;
- the **immutable manifest** written when the operation started (§2.5): the minimal version payload and the file
  list with sizes and hashes;
- `files()`, which mints fresh signed links for that manifest after re-checking that the video still exists and is
  still allowed out;
- `stream(file)`, a new `BlobsPort.stream(store, key, range?)` for kinds that upload bytes themselves.

### 2.3 Data

A new migration (`netlify/database/migrations/<ts>_publish_destinations`), Drizzle in `db/schema.ts`, and store
methods in `src/store/{types,memory,drizzle}.ts`. Both stores enforce the same uniqueness, claim and consume rules,
tested on memory and PGlite. There are no array columns (the schema uses none); lists are `jsonb`.

```
destinations                         http only (built-in kinds are virtual)
  id text pk                         dst_…
  name text                          shown in Publish ▾
  enabled boolean
  url text                           https://, no credentials in the URL (checkUrl + new checks)
  secret_enc text                    shown once on create/rotate, like webhook secrets
  options_schema jsonb null          §6.3
  capabilities jsonb                 from its ping (§3.6): { targets, targetNoun?, instructions, instructionsLabel?,
                                     instructionsHint? }
  share_publisher_contact boolean    default false: send the publisher's name and email (§3.1)
  revision int                       bumped on any change; pinned on each publication
  created_by, created_at, updated_at

destination_connections              a person's account at a built-in destination (YouTube)
  id text pk
  user_id text, kind text            unique (user_id, kind) in v1: one channel per person
  account_id text                    the YouTube channel id
  account_label text                 the channel title
  token_enc text                     refresh token (encrypted)
  scopes jsonb
  status text                        ok | reconnect (invalid_grant, revoked)
  created_at, updated_at, revoked_at null

destination_publications             one version at one target of one destination (not the share page)
  id text pk                         dpub_…, stable for the publication's life
  job_id, version_n
  kind text, destination_id text null, destination_revision int null
  connection_id text null            YouTube: pinned; cleanup uses it, never the actor's current connection
  target_key text                    http: the chosen target's id, or the publication id for "new";
                                     youtube: the channel id
  target jsonb null                  the chosen Target as sent (§2.2), or null for "new"
  options jsonb, instructions text null (≤ 4,000)
  desired text                       published | removed (what the person wants)
  status text                        queued | running | waiting | live | removing | removed | failed
  generation int                     +1 for every new operation (publish, remove, try again)
  operation text                     publish | remove (the current operation's action)
  manifest jsonb                     the current operation's immutable payload (§2.5)
  state_enc text null                the kind's resumable state, encrypted (it can hold a YouTube session URL)
  external_id text null              YouTube video id, the receiver's id
  url text null, message text null, warnings jsonb null, error jsonb null (SafeError)
  attempts int, next_run_at ts null, deadline_at ts
  lease_until ts null, lease_fence int    fenced lease (§2.4)
  secret_once_enc text null, secret_once_label text null,
  secret_once_issued_at ts null, secret_once_expires_at ts null, secret_once_consumed_at ts null
  published_by text, created_at, updated_at, live_at null, removed_at null
  index (job_id); partial index (next_run_at) where status in (queued, running, waiting, removing)
  unique (job_id, version_n, kind, coalesce(destination_id, ''), target_key) where desired = 'published'
```

The unique index allows the cases decision §9.1 needs:

- the same version on two different existing sites (two target keys);
- several "new" ones (each gets its own key);
- several publishers' YouTube channels.

It refuses only the same version twice at the same target. `mergeUser` (`src/store/types.ts:378`) moves
`destination_connections` and `published_by`.

**The share page has no `destination_publications` rows.** Both publish routes go through one domain path that
writes `publications` exactly as today. The Version DTO's `destinations` list adds a derived share-page entry from
`publications`. So there's no second source of truth, no backfill, and no change to the mirror, links, embeds or
transcript choice. Share-page publish and unpublish stay inline and immediate.

### 2.4 Running the work

- **Starting:** `publishToDestination` checks the following, then inserts the row (`desired = published`,
  `status = queued`, generation 1, the manifest) and dispatches `publish-background`, a new background function signed
  like `finalize-background` through `PlatformPort.dispatchPublish(id)`:
  - `video:publish`;
  - a ready version;
  - that the video isn't private (§9.6);
  - that the destination is enabled;
  - `ready()`;
  - option, target and instruction limits;
  - `idempotency-key`.

  A second publish to the same target while one is active:
  - the same options give back the same publication;
  - different options give `409 conflict`.

- **The fenced lease:**
  - A worker claims a row atomically by setting `lease_until = now + 2 min` and incrementing `lease_fence`, only when
    no live lease exists.
  - It runs one bounded step.
  - It commits the result only if `lease_fence`, `generation` and `desired` are unchanged, renewing the lease in the
    same write.
  - It loops while the step says `continue`, and stops 60 s before the function's 15 minutes.
  - If the commit fails because the row moved on, it exits without writing.
- **The sweep** (`netlify/functions/sweep.ts`) gains `duePublications(deps, budget)`. It never runs steps (it never
  moves bytes). It dispatches rows whose `next_run_at` has passed and whose lease has expired, at most once a minute
  per row. It also fails rows past `deadline_at`, including callback-only `waiting` rows with no `next_run_at`.
  - Deadlines: 24 h for a publish.
  - For a YouTube publish waiting on quota, the next reset plus 24 h.
  - 7 days for a removal (cleanup failures stay visible in the UI).
- **`retry`** uses `backoffMs`, or the receiver's `Retry-After` up to 1 h.
- **Try again** on a `failed` row starts a new operation on the **same** publication (`generation + 1`) and
  reconciles: if the earlier attempt did succeed remotely and its answer was lost, the same publication id lets the
  receiver, or YouTube via `state`, find it. Only a confirmed new publication gets a new id.
- **Removing** (unpublish, video deleted, destination disabled with "remove everywhere"):
  - `queued`, with nothing sent yet: becomes `removed` at once.
  - `running`, `waiting`, `live`, or `failed` after a request may have reached the receiver: `desired = removed`,
    `generation + 1`, `operation = remove`, `status = removing`, dispatched like a publish.
  - The removal's manifest is written before anything else, and holds only what removal needs: ids, external id,
    target, connection. It never needs the video's bytes or a Video DTO. So `deleteVideo` can queue its byte cleanup
    as today.
  - Removal runs with a system principal.
- **Deleting a video while publishing:**
  - An in-flight publish loses its fence at the next commit, because `desired` changed.
  - A fresh-files request is refused, because the video is gone.
  - The removal operation cleans up whatever the receiver made.

### 2.5 The manifest (what leaves the app)

Each operation writes an immutable manifest before any outside work.

For a publish:

```jsonc
{
  "video": { "id": "vid_…", "title": "…", "language": "en" },
  "version": {
    "n": 3,
    "title": "…",
    "summary": "…",
    "width": 1920,
    "height": 1080,
    "durationSec": 74,
    "credits": [/* the CC BY lines the share page shows (versionCredits) */],
  },
  "files": [
    { "kind": "mp4", "contentType": "video/mp4", "bytes": 41234567, "sha256": "…" },
    { "kind": "poster", "contentType": "image/jpeg", "bytes": 182345, "sha256": "…" },
    { "kind": "captions", "contentType": "text/vtt", "bytes": 4210, "sha256": "…" },
    { "kind": "transcript", "contentType": "text/plain", "bytes": 3100, "sha256": "…" }, // only if included
  ],
  "sharePage": "https://…/v/abc123", // when the version is also on the share page, else null
}
```

No prompts, plans, feedback, owner emails or other versions. The transcript is included only when the publisher
ticks **Include the transcript** in the dialog. That choice is separate from the share page's.

## 3. The HTTP destination contract, v1 (normative)

This section is what `/docs/destinations` publishes, with signed test vectors and a complete example receiver. A
third party must be able to build a receiver from it alone.

### 3.1 Requests

- `POST {destination.url}`, `content-type: application/json; charset=utf-8`, with these headers:
  - `x-video-agent-signature: t=<unix seconds>,v1=<hex>`, where
    `v1 = hex(HMAC-SHA256(secret, "<t>." + raw body bytes))`;
  - `x-video-agent-event: publish | remove | targets | ping`;
  - `x-video-agent-delivery: <operation id>` on publish and remove.
- **Verifying:** receivers recompute the signature over the exact raw bytes, compare in constant time, and reject
  `|now − t| > 300`. Retries are signed again with a new `t`; the operation id doesn't change.
- **Every body has** `"contract": 1`, `"event"`, `"sentAt"`, `"destination": { "id", "name" }` and
  `"publisher": { "id" }`. `publisher.name` and `publisher.email` are added only when the admin turned on **Share
  the publisher's name and email** for this destination. They are contact details, never an authorization key.
- **publish:**
  ```jsonc
  {
    "contract": 1,
    "event": "publish",
    "sentAt": "…",
    "destination": { "id": "dst_…", "name": "…" },
    "publisher": { "id": "u_…" },
    "publication": "dpub_…", // stable for this publication
    "operation": "dpub_…:publish:1", // stable across retries of this operation: the idempotency key
    "options": {}, // validated against the destination's options form
    "target": null, // or the Target exactly as the receiver listed it (§3.4)
    "instructions": null, // or the publisher's text, when the destination takes it
    "manifest": {/* §2.5, each file with "url": a signed link (600 s) */},
    "callback": { "url": "https://…/api/v1/destination-callbacks/dpub_…", "token": "…", "expiresAt": "…" },
  }
  ```
- **remove:** the same envelope, with `"publication"`, `"operation": "dpub_…:remove:<n>"`, `"externalId"` (may be
  `null`: key on `publication`), `"url"` (may be `null`), `"target"`, and the callback. It has no files.
- **targets:** the envelope plus `"video": { "id", "title" }`. Timeout 5 s.
- **ping:** the envelope only (§3.6).
- **Transport rules** (these apply to every event and every retry):
  - https only, and URLs carry no credentials;
  - every resolved address must be public, and the connection is pinned to the address that passed;
  - redirects are not followed;
  - 30 s timeout overall (5 s for targets);
  - the response body is read up to 64 KB.

  `HttpPort` gains `postJsonForResponse`, which keeps all of `postJson`'s protections but returns the status, a few
  headers and the bounded body.

### 3.2 Responses

| Event   | Receiver answers                                                       | Meaning                                                                                                                                                                                                                                    |
| ------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| publish | `200 { "status": "live", "url"?, "externalId"?, "warnings"? }`         | Done now.                                                                                                                                                                                                                                  |
| publish | `202 { "status": "accepted", "externalId"?, "message"? }`              | Working on it; it will call back. Row goes `waiting`; `message` shows ("Processing" if absent).                                                                                                                                            |
| remove  | `200 { "status": "removed" }`, `204`, or `404`                         | Removed (404: already gone).                                                                                                                                                                                                               |
| remove  | `202 { "status": "accepted", "message"? }`                             | Removing; it will call back.                                                                                                                                                                                                               |
| targets | `200 { "targets": Target[] }`                                          | §3.4.                                                                                                                                                                                                                                      |
| ping    | `200 { "capabilities"? }`                                              | §3.6.                                                                                                                                                                                                                                      |
| any     | `408`, `429`, `5xx`, timeout, network error                            | Retry with backoff; `Retry-After` is honoured up to 1 h.                                                                                                                                                                                   |
| any     | `3xx`, other `4xx`, a `2xx` whose body doesn't match its event's shape | Failed. The error is `{ code: "http_<status>" or "bad_response", message }`, where `message` is the receiver's `error.message` (if the body has one) cut to 300 characters and shown as plain text. Raw bodies are never stored or logged. |

URLs in responses must be `https:`. `message` and `warnings` are plain text, at most 300 characters each, and at
most 5 warnings.

### 3.3 Callbacks

- `POST /api/v1/destination-callbacks/{publication}`, with `authorization: Bearer <token>` and a body of
  `{ "operation", "status", "url"?, "externalId"?, "message"?, "warnings"?, "error"?, "secretOnce"? }`.
- Allowed statuses:
  - for a publish operation: `working`, `live`, `failed`;
  - for a remove operation: `working`, `removed`, `failed`.

  `working` only updates `message`.

- A callback may arrive **before** the original request's `202` does; both orders end in the same state.
- Callbacks for an older operation (a lower generation) are acknowledged and ignored. They never change what the
  person currently wants.
- Answers:
  - `204`: applied, or a duplicate of what was already applied (no change);
  - `401`: bad or expired token;
  - `404`: unknown publication;
  - `409`: a status not allowed for that operation;
  - `410`: the publication is removed.
- **The token** is `HMAC(server key, "<publication>:<operation>")`. It's derived again on every retry, so a
  restarted worker sends the same token. Only its hash and key version are stored. It expires at the operation's
  deadline and stops working when a newer operation starts.
- The callback and fresh-files routes are registered **before** `requireAuth`. They keep the production-deploy
  guard, cap bodies at 16 KB, and have their own rate limit.

### 3.4 Targets

- The contract is generic: the app doesn't know whether a target is a site, a playlist, a CMS collection or
  anything else.
- With `capabilities.targets`, opening the Publish dialog sends a `targets` request.
- The answer: at most 100 targets, in the receiver's order.
  - The app checks shapes and limits (§2.2) and drops entries that break them.
  - It shows `name`, `description` and `url`, and stores nothing until the person publishes.
- On publish, the chosen target is sent back exactly as listed, `metadata` included. **Receivers must treat it as
  untrusted input:** it came back through a browser. A receiver authorizes by looking up `target.id` itself for this
  destination and `publisher.id`, and ignores anything in `metadata` for authorization.
- `capabilities.targetNoun` (at most 30 characters, such as "site") words the picker: "New site / Your sites".
  Without it, "New / Existing".
- A failed or slow targets call still lets the person publish to a new one.

### 3.5 Fresh links and one-time secrets

- **Fresh links:** `POST /api/v1/destination-callbacks/{publication}/files`, with the same token, returns the
  manifest's files with new signed links. It works only while that publish operation is active and before its
  deadline. It re-checks that the video still exists and isn't private.
- **`secretOnce`:** `{ "label", "value" }`, for example a site password.
  - It is accepted once per operation and stored encrypted with its issue and expiry times (24 h).
  - The publisher sees **Reveal {label}**. Revealing is an atomic consume, for that publisher only, while they can
    still see the video. It returns the value with `cache-control: no-store` and clears the ciphertext.
  - A replayed callback can't bring it back.
  - The sweep clears expired ones.
  - DTOs, webhooks and logs carry only "has a secret" and its label.
  - "Once" means one successful server response: a response lost in transit can't be retried.

### 3.6 Admin setup and capabilities

Admin → **Destinations** → **Add an HTTP destination**: a name, a URL, an optional options form, and **Share the
publisher's name and email** (off by default).

- The secret is shown once (as for webhooks), with **Rotate**.
- **Send a test** sends a `ping`. The receiver answers `2xx`, optionally with
  `{ "capabilities": { "targets": true, "targetNoun": "site", "instructions": true, "instructionsLabel": "Where should the video go?", "instructionsHint": "…" } }`.
  The app stores the capabilities, re-checks them on every test, and shows the picker and the instructions box
  (labelled by the receiver, or "Instructions") only when they're on.
- **Disabling** a destination hides it and refuses new publications, and offers "Remove from everywhere" as a
  separate, confirmed action.

## 4. YouTube

- **Setup (admin):**
  - a Google Cloud project with the YouTube Data API v3;
  - an OAuth web client with redirect `{site}/auth/google/callback`;
  - `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the env;
  - then Admin → Destinations → enable YouTube.

  Without the env, the kind doesn't exist and `features` doesn't list `youtube`. `/docs/destinations` has a setup
  guide, including leaving Google's **Testing** mode: in Testing, connections die after 7 days.

- **Connecting** (Settings → **Connected accounts**):
  - OAuth 2.0 web flow with PKCE, `access_type=offline`, scope **`youtube.force-ssl` only**.
  - The `state` value is single-use and expiring, and is bound to the signed-in session along with the PKCE
    verifier.
  - The callback checks the granted scope, reads the channel (`channels.list mine=true`), and stores the encrypted
    refresh token, the channel id and its title.
  - `invalid_grant` or a revocation sets `status = reconnect`, and `ready()` says "Reconnect YouTube".
  - Disconnecting revokes the token at Google.
- **Publishing** (bounded steps, each saving its ids before the next call):
  1. **Upload.** Create a resumable session with:
     - the title and description from the dialog;
     - `privacyStatus` from the dialog (default **unlisted**, decided), always sent explicitly;
     - `selfDeclaredMadeForKids: false`.

     Save the session URL (encrypted) before sending bytes, then send 8 MiB chunks from `BlobsPort.stream`.
     - After any uncertain answer, ask the session for its offset (`Content-Range: bytes */N`) before sending more.
     - A `404` session starts over only if no video id was saved.
     - Save the video id the moment the upload completes.

  2. **Processing.** Poll `videos.list(part=processingDetails,status)`: after 30 s, then every 60 s, for up to 2 h.
     - `failed`, `terminated`, `rejected` or `failed` upload status → `failed`, with Google's reason.
  3. **Captions.** `captions.insert` with the version's current VTT in the video's language. Save the track id.
     On retry, list the video's tracks first so a track isn't added twice. If captions fail for good, the row still
     goes `live` with a warning.
  4. **Thumbnail.** `thumbnails.set` with the poster, after processing has succeeded (Shorts need that). Without a
     verified channel, a `403` is a warning; other errors retry.
  5. `live` with `https://youtu.be/{id}`.
- **Title and description (decided):**
  - The dialog fills in the version title, and a description of the summary plus the share link.
  - Both are editable.
  - The CC BY credits are always added underneath and shown read-only.
  - The whole description, credits included, is checked against 5,000 bytes and no `<` or `>` before anything is
    sent.
- **Removing:** make private (`videos.update`). Deleting a video here makes it private there. Deleting on YouTube is
  not in v1. Removal always uses the publication's pinned connection; if it needs reconnecting, the row says
  "Reconnect YouTube to finish removing it".
- **Quota:**
  - `quotaExceeded` on a bucket → `retry` at the next midnight Pacific plus jitter.
  - `uploadLimitExceeded` → `failed`, with Google's message (a channel limit, not our quota).
  - We don't show "uploads left today": our count isn't authoritative.
  - Each publish uses one upload call plus about 450 units, so 10,000 units cover about 20 publishes a day before
    captions and thumbnails start waiting. Spike P4 reads this project's real allocation.
- **Who it posts as:** the person who clicks Publish, to their own channel. An admin publishing someone else's video
  posts to the admin's channel.

## 5. Internal: the Netlify site destination (not in the public snapshot)

This part lives in revenue-engine. In this repo it's only an HTTP destination an admin adds. When the plans go into
the public snapshot, drop this section (see [going public](2026-11-02-going-public.md), the `docs/plans/` item).

### 5.1 New in site-vendor: blobs on a vended site

The video goes into the vended site's own Netlify Blobs (a site-wide store, `site-files`), written with the tenant's
token. site-vendor **pulls** files from signed links, because they can't come through its request bodies.

| Route                                                                                    | What it does                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /sites/:ownerKey/blobs` `{ key, sourceUrl, contentType, bytes, sha256 }`           | Records a copy op and queues it (SQS → the `blob-copy` Lambda, 900 s, `/tmp` up to 2 GB). `202 { key, status }`. The same key and sha256 returns the same op; the same key with a different sha256 is `409`. |
| `GET /sites/:ownerKey/blobs/op/{key+}`                                                   | The op: `pending`, `done` or `failed`, with `error`.                                                                                                                                                         |
| `GET /sites/:ownerKey/blobs/content/{key+}`                                              | A small blob's content (≤ 256 KB) with a strong read and its ETag (for `site.json`).                                                                                                                         |
| `PUT /sites/:ownerKey/blobs/content/{key+}` (≤ 256 KB, `if-match` or `if-none-match: *`) | A conditional write (`onlyIfMatch` / `onlyIfNew`). `412` on a conflict.                                                                                                                                      |
| `GET /sites/:ownerKey/blobs`, `DELETE /sites/:ownerKey/blobs/{key+}`                     | List; delete.                                                                                                                                                                                                |

- **Keys** are content-addressed (`v/{publication}/{sha256}.mp4`), so a file is never referenced until it's
  verified. Keys match `[a-z0-9/._-]{1,200}` and are routed with a greedy `{key+}` parameter.
- **`blob-copy`** is at-least-once. It streams the source to `/tmp` while hashing, refuses a size or hash mismatch,
  then uploads the file.
  - A retry starts from the file, not from a half-read stream (spike P1 checks whether `@netlify/blobs` can retry a
    stream itself).
  - It enforces the 500 MB limit while copying.
- **Source safety:**
  - `sourceUrl` must be https, with an exact host on the tenant's `blobSourceHosts` list, a public address that is
    then pinned, and port 443.
  - No redirects, no credentials in the URL.
  - A deadline and the byte limit apply while streaming.
- **Guardrails** (alarms, as elsewhere in site-vendor): per-site and per-tenant bytes, copy failures, queue age.
- `retract delete` deletes the site and its blobs. `retract lock` leaves them behind the password.

### 5.2 The site template

A template repo (name to pick). Each site gets **its own repo**, a content clone at a pinned ref, linked through
site-vendor's git mode. Its own repo gives an agent run (§5.4) a place to commit changes that no other site shares.
Spike P2 settles who clones it, where the repos live, and cleanup. The template holds:

- `index.html` plus a little JS that reads `/site.json` and shows the video(s): `<video>` with a poster, a captions
  track, `playsinline`, no autoplay with sound, and the title, summary and credits. A video that 404s shows "This
  video was removed".
- `netlify/edge-functions/blob.ts` on `/v/*` and `/site.json`:
  - streams from the `site-files` store with range requests (a port of `mediaResponse`, `src/lib/media/range.ts`);
  - reads `site.json` with `consistency: 'strong'`;
  - uses `etag` from the content hash.
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
        "mp4": "/v/dpub_…/<sha>.mp4",
        "poster": "/v/dpub_…/<sha>.jpg",
        "captions": "/v/dpub_…/<sha>.vtt",
        "width": 1920,
        "height": 1080,
        "durationSec": 74,
        "credits": []
      }
    ]
  }
  ```
- An `AGENTS.md` for agent runs: keep the edge function, the `/v/*` paths and the `site.json` contract.

Adding, replacing or removing a video never rebuilds the site unless an agent run changes its design.

### 5.3 The receiver

A small service in revenue-engine (or a route in `services/api`; §9 open question). It keeps its own DynamoDB
records:

- each publication's workflow: operation id, callback token, link expiry, created resources, next action;
- a per-site lock;
- the authoritative list of which sites belong to which `(destination id, publisher id)`.

Work goes through a queue with a recovery sweep and fenced claims; it is not "answer 202, then keep going".

- **ping:** answers `targets`, `targetNoun: "site"` and `instructions` on, with `instructionsLabel` "Where should
  the video go?" and `instructionsHint` "An agent will edit the site to place it. Leave empty to use the standard
  layout." The site and agent wording lives here, not in the app.
- **targets:** this publisher's sites from the receiver's own table, as Targets:
  - `id` = its record id;
  - `name`, and `description` such as "3 videos · updated 2 days ago";
  - `url`;
  - `metadata` = `{ "videos": 3 }`.

  Only sites made through this destination are listed (§9.7).

- **publish:**
  1. Look up or create the workflow for `operation`.
  2. **New site** (the default): `POST /sites/ensure` with a new `ownerKey`, the template's per-site repo, labels
     `{ videoAgentDestination, videoAgentUser }`, and **`protection: password` at creation** when the `password`
     option is on, so the site is never public first.

     **Existing site:** look up `target.id` in the receiver's table for this destination and publisher; `403` if
     it's not theirs.

  3. Answer `202`.
  4. Queue a blob copy for each manifest file. If the links expire, get fresh ones through the files route.
  5. When every copy is verified, update `site.json` under the per-site lock with conditional writes, re-reading on
     `412`.
  6. With instructions, run §5.4. Otherwise call back `live` with the site URL (plus `#dpub_…` when the site holds
     several), and with `secretOnce` when a password was set.
- **remove:** under the site lock, take the entry out of `site.json` (a removal beats a copy or run still pending),
  delete its blobs, and call back `removed`. The site stays: retracting a site is a deliberate act in RE.
- **Options form:** `name` (a string, optional, for a new site) and `password` (a boolean, default false).

### 5.4 The optional agent run

When the publisher wrote instructions, the receiver starts an Agent Runner run on that site through
`nax-agent-runner-sdk`, with a fixed prompt plus their words:

```text
A video was just added to this site: /v/{id}/{sha}.mp4 (poster /v/{id}/{sha}.jpg, captions /v/{id}/{sha}.vtt),
listed in /site.json as "{title}" ({width}×{height}, {duration}).
Read AGENTS.md first. Work the video into the site's design where the person asked, below. Keep the existing
content, the edge function and the site.json contract; don't download or re-encode the video; keep it accessible
(captions track, poster, no autoplay with sound).

Where the person wants it:
{instructions}
```

- **Landing:** P6 picks GitHub `merge` (with a scoped GitHub token for the per-site repos) or Netlify Git
  `publish`. The receiver saves the SDK handles and landing checkpoints. Success means **the run's commit reached
  that site's production deploy**; an open PR or an unrelated deploy doesn't count. Before landing, the run's preview
  must still serve `/site.json` and the new video's `/v/*` paths.
- **Failure:** if the run fails, times out or doesn't land, the receiver checks that production still serves the
  video in the standard layout. If it does, it calls back `live` with the warning "The agent couldn't place it; it's
  in the standard layout". If it doesn't, it restores the last good deploy first.
- **Limits:**
  - one run at a time per site (the DynamoDB lock);
  - a per-run credit ceiling and a timeout;
  - runs bill to the vended sites' team.
- "Ask the agent again" on a live row is not in v1.

## 6. Product surface

### 6.1 API

| Route                                                                                                                                          | operationId                                                                 | Who                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------- |
| `GET /api/v1/destinations`                                                                                                                     | `listDestinations`                                                          | Signed in; `ready` and `reason` per destination |
| `GET /api/v1/destinations/{destId}/targets?videoId=`                                                                                           | `listDestinationTargets`                                                    | `video:publish` on that video                   |
| `POST /api/v1/videos/{id}/versions/{n}/destinations` `{ destination, options, target, instructions, includeTranscript }` (+ `idempotency-key`) | `publishToDestination`                                                      | `video:publish`                                 |
| `DELETE /api/v1/destination-publications/{pub}` `{ options? }`                                                                                 | `unpublishFromDestination`                                                  | `video:publish`                                 |
| `POST /api/v1/destination-publications/{pub}/retry`                                                                                            | `retryDestinationPublication`                                               | `video:publish`                                 |
| `POST /api/v1/destination-publications/{pub}/secret`                                                                                           | `revealDestinationSecret`                                                   | The publisher                                   |
| `POST /api/v1/destination-callbacks/{pub}`, `…/files`                                                                                          | `destinationCallback`, `destinationFiles`                                   | Callback token (before `requireAuth`)           |
| `GET /api/v1/admin/destinations`                                                                                                               | `listAdminDestinations`                                                     | Admin                                           |
| `POST /api/v1/admin/destinations`                                                                                                              | `createDestination`                                                         | Admin                                           |
| `PATCH /api/v1/admin/destinations/{destId}`                                                                                                    | `updateDestination`                                                         | Admin                                           |
| `DELETE /api/v1/admin/destinations/{destId}`                                                                                                   | `deleteDestination`                                                         | Admin (refused while publications are active)   |
| `POST /api/v1/admin/destinations/{destId}/rotate`                                                                                              | `rotateDestinationSecret`                                                   | Admin                                           |
| `POST /api/v1/admin/destinations/{destId}/test`                                                                                                | `testDestination`                                                           | Admin                                           |
| `POST /api/v1/admin/destinations/{destId}/remove-all`                                                                                          | `removeDestinationEverywhere`                                               | Admin                                           |
| `GET /api/v1/me/connections`, `DELETE /api/v1/me/connections/{id}`                                                                             | `listConnections`, `deleteConnection`                                       | Signed in                                       |
| `GET /auth/google/start`, `GET /auth/google/callback`                                                                                          | (none: auth routes stay out of the OpenAPI spec, like `src/auth/routes.ts`) | Signed in                                       |

- The existing share-page routes keep their request and response shapes, and the share page appears in
  `listDestinations` as the built-in `share_page`.
- The Version DTO gains `destinations: DestinationPublication[]`, holding:
  - `id`, `kind`, `destination: { id, name }`, `target: { name, url }`;
  - `status`, `desired`, `url`, `message`, `warnings`, `error`;
  - `hasSecret`, `secretLabel`;
  - `publishedAt`, `liveAt`.
- Any change to a destination publication bumps `job.version`, so the video's ETag changes.

### 6.2 UI (generic copy only)

- **Publish ▾** on a ready version, where `PublishButton` is today (`Video.tsx:794`): "Share page" first (today's
  dialog), then each destination. One that isn't `ready` shows its reason.
- **The dialog:**
  - With targets: **Where**, "New {noun}" (the default) or a listed target (name, description, link).
  - The options form.
  - With instructions: the box, labelled by `instructionsLabel` or "Instructions", with `instructionsHint` under it.
  - **Include the transcript** (when the version has one).
  - For YouTube: the channel, title, description (credits read-only underneath, with a byte counter), and privacy
    (default unlisted).
- **Published to** under the version (next to `PublicLink`): one line per destination publication with:
  - its status;
  - the link;
  - the receiver's `message` as plain text ("Processing" when there is none);
  - warnings;
  - **Reveal {label}** when there's a secret;
  - Remove / Try again.

  The page keeps polling (every 5 s) while any row is `queued`, `running`, `waiting` or `removing`.

- **Published** markers (the library at `Library.tsx:106`, the filmstrip at `Video.tsx:337`) and both stores'
  `published` filter count a `live` destination row as published.
- **Settings → Connected accounts:** YouTube (connect, channel name, reconnect, disconnect), when the feature is on.
- **Admin → Destinations:**
  - the list with counts of live and failed publications per destination;
  - add an HTTP destination, rotate, test, disable, remove everywhere;
  - YouTube on or off, with its setup checklist.

### 6.3 Options forms

A JSON-Schema subset, so the UI can render it and the server can check it without a new dependency:

- an object of at most 10 properties;
- each `string` (with `maxLength`, optional `enum`) or `boolean`;
- with `title`, `description`, `default` and `required`.

The server checks it with a hand-written validator (`src/lib/options-schema.ts`) and refuses unknown keys. Integers
and more types can come later.

### 6.4 Webhooks, MCP, CLI, SDK, logs

- **Webhook events** for terminal outcomes only: `destination.live`, `destination.failed`, `destination.removed`,
  with the destination publication in `data`. Like every event, none are sent after the video is deleted
  (`webhooks.ts:38`).
- **MCP:**
  - `publish_video` gains `destination`, `target` and `instructions`;
  - `unpublish_video` gains `publication`;
  - a `list_destinations` tool lists destinations and their targets.
- **CLI** (the cli-and-sdk plan):
  - `publish <video> --to <destination> [--target <id>] [--instructions …] [--wait]`;
  - `destinations` and `destinations targets <id>`.
- **SDK rows:** `destinations.list`, `destinations.targets`, `versions.publishTo`, `publications.remove`,
  `publications.retry`, and a `waitForPublication` helper. Coverage follows shared rule 3.
- **`features`** gains `destinations` and, when it's configured, `youtube`.
- **Logs and metrics:**
  - `destination.step`, `destination.live`, `destination.failed`, `destination.removed` and
    `destination.callback`, with ids, kind, attempt, latency and bytes, and never tokens, secrets or bodies;
  - queue age, lease expiries, and quota retries per bucket.

## 7. Phases (each with a pass/fail gate)

1. **Groundwork.**
   - The migration and store methods (both stores).
   - The `DestinationKind` interface.
   - The share page through one domain path, plus its derived DTO entry.
   - `publish-background`, `dispatchPublish`, the fenced lease, `duePublications`.
   - `postJsonForResponse`, `BlobsPort.stream`.
   - ETag and polling.
   - Publish ▾ showing only the share page.

   **Gate:**
   - The old and new share routes give byte-identical mirrors, HTML, embeds and DTOs (fixtures), including
     transcript consent, revised captions, and GET/HEAD/Range.
   - Leases are claimed atomically on PGlite, with two workers racing.
   - A stale fence can't write.
   - Deleting a video in every state ends where it should.

2. **HTTP destinations.**
   - The admin page.
   - The contract in §3: signing and test vectors, the response table, callbacks, fresh links, targets,
     instructions, `secretOnce`.
   - `/docs/destinations` with a complete example receiver.

   **Gate:** a fake receiver covers every row of §3.2, plus:
   - a callback before the `202`;
   - duplicate and late callbacks after removal or failure;
   - a crash after the receiver succeeded (Try again reconciles, no duplicate);
   - unpublishing in every state;
   - concurrent reveals and a replayed secret;
   - SSRF (a private address, a redirect, DNS rebinding, credentials in the URL);
   - oversized and malformed bodies;
   - a private video refused;
   - Playwright from the dialog to `live` and Reveal (mock server).

3. **Internal: Netlify site (revenue-engine).**
   - **3a, a new site per video:** site-vendor blob routes and `blob-copy`; the template; the receiver for new sites,
     removal and passwords.

     **Gate:**
     - The fakes in `tests/helpers/fakes.ts`.
     - A gated real-Netlify smoke, like `smoke-git-template.ts`: create a password-protected site, copy a 40 MB
       file, range-read it through the edge function with and without the password, remove it, and delete the site
       in `finally`.
     - Concurrent add and add, and add and remove, on one `site.json`.

     Needs P1–P3.

   - **3b, existing sites and the agent run:** targets, adding to an existing site, §5.4.

     **Gate:**
     - A landed run reaches production.
     - A failed run leaves the standard layout working, or restores the last good deploy.

     Needs P6.
4. **YouTube.**
   - Google OAuth and Connected accounts.
   - The `youtube` kind (§4).
   - Quota handling.

   **Gate:** a fake Google covering:
   - token exchange and `invalid_grant` → reconnect;
   - a resumable upload with a forced mid-upload failure and offset probe, and an expired session;
   - processing → `live`, and processing → `failed` or `rejected`;
   - captions retried without duplicates;
   - a thumbnail `403` as a warning, and a Shorts thumbnail after processing;
   - `quotaExceeded` → the next reset;
   - removal with a revoked connection.

   Then one manual run on a real test channel. Start Google's OAuth verification (P5) during phase 1.

## 8. Spikes

- **P1** Write a 50 MB object to another site's Netlify Blobs from a Lambda with a PAT:
  - from `/tmp` and as a stream;
  - with a forced mid-upload failure: does the client retry a stream, or must we re-read the file?
  - memory and time.
- **P2** Per-site repos: who content-clones the template (the receiver, as RE does today, or site-vendor), which
  GitHub org holds them, the GitHub-app link for many repos, and cleanup when a site is retracted.
- **P3** On a vended site, the edge function streams a blob with range requests (seek in Safari and Chrome).
  - Does site password protection cover `/site.json` and `/v/*`, including HEAD and Range?
  - Is it in force from the first deploy when set at ensure?
- **P4** YouTube: a resumable upload from a Netlify background function, captions and thumbnail, and this project's
  real quota allocation in the Cloud console.
- **P5** Google OAuth app verification for `youtube.force-ssl`: what it needs from us (privacy policy, terms, a demo
  video) and how long it takes. The YouTube API audit only matters past 100 uploads a day.
- **P6** An Agent Runner run on a vended site:
  - `merge` or `publish` landing, and proving the commit reached production;
  - how long a "place this video" run takes and what it costs;
  - whether the `netliclaw` team can run agents.

## 9. Decisions

**Owner (2026-11-04)**

1. **Sites:** a new site per video by default. People can also add a video to one of their existing sites (targets),
   optionally with an agent run that works it into the design (§5.4).
2. **Site passwords:** shown once in the Video Agent dialog (`secretOnce`, §3.5).
3. **YouTube privacy:** unlisted by default.
4. **YouTube description:** summary + share link + credits, editable before publishing, credits always kept.
5. **Who can use HTTP destinations:** anyone who can publish.
6. **Targets are generic** (id, name, description, URL, opaque metadata); nothing in the app is site-specific.

**Proposed in draft 3 (the owner can overrule)**

7. **Private videos don't go to external destinations** (YouTube or HTTP). `ready()` says "Make the video visible
   to the team first." The share page keeps today's behaviour.
8. **Receivers get the publisher's id only.** Name and email go only to destinations where an admin turned that on.
9. **"Your sites" means sites made through this destination**, not any Netlify site the person controls.
10. **The same version can go to several targets** of one destination, and "New" twice makes two (each is its own
    publication).
11. **YouTube removal is make-private only** in v1.

**Still open**

- **Where does the receiver live:** `services/api` or its own service?
- **Who owns the per-site repos and the agent spend:** which GitHub org and Netlify team, the credit ceiling per run,
  and who may approve production edits.
- **When a publisher leaves or disconnects:** do their external publications stay as they are, move to someone else,
  or need removing by hand? (If a connection is revoked, removing from YouTube can't happen automatically.)
- **"Ask the agent again"** on a published site: later (planned), or v1?

## 10. Not in v1

- Deleting from YouTube (make private only), the made-for-kids toggle, and playlists.
- "Ask the agent again".
- Integer and other option types.
- Sending `gif`, `posterWebp` or narration audio.
- Showing "uploads left today".
- Several YouTube channels per person.

## 11. Risks

- **Duplicates on the far side.** A lost answer could mean a second site or a second YouTube upload. The stable
  publication and operation ids, Try again reconciling, and saving ids before the next call keep that to the
  receiver's own idempotency.
- **A receiver that never calls back.** Rows fail at the deadline with a clear error; removal deadlines are longer
  and stay visible.
- **Leaking data.** The manifest is minimal; contact details are opt-in; raw receiver bodies are never stored;
  secrets and tokens are encrypted and tested for absence in DTOs, webhooks and logs.
- **SSRF.** Every outbound call (admin URLs, the source pulls in site-vendor) uses pinned public addresses, no
  redirects and limits.
- **An agent run breaking someone's site.** It works on the site's own repo, landing is checked against production,
  and a failure falls back to the standard layout or the last good deploy.
- **Google.** OAuth verification gates more than 100 users; the upload bucket (100 a day) and the 10,000 units are
  per project.
- **Scope creep in site-vendor.** The blob routes are its first byte-moving work. `blob-copy` stays off the API
  Lambda and its 29 s limit.

## 12. Sources

- YouTube:
  - [`videos.insert`](https://developers.google.com/youtube/v3/docs/videos/insert)
  - [revision history](https://developers.google.com/youtube/v3/revision_history)
  - [quota costs](https://developers.google.com/youtube/v3/determine_quota_cost)
  - [resumable uploads](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol)
  - [`thumbnails.set`](https://developers.google.com/youtube/v3/docs/thumbnails/set)
  - [`captions.insert`](https://developers.google.com/youtube/v3/docs/captions/insert)
  - [video resource](https://developers.google.com/youtube/v3/docs/videos)
- Google OAuth:
  - [OAuth for web servers](https://developers.google.com/identity/protocols/oauth2/web-server)
  - [token expiry](https://developers.google.com/identity/protocols/oauth2)
  - [unverified apps](https://support.google.com/cloud/answer/7454865)
- Netlify:
  - [Netlify Blobs](https://docs.netlify.com/build/data-and-storage/netlify-blobs/)
  - [background functions](https://docs.netlify.com/build/functions/background-functions/)
- AWS:
  - [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)
  - [API Gateway HTTP API quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html)

## 13. Review log (draft 2 → 3)

Two remote reviews of `2e1d06c`: Fable 5.1 high (runner `6aebb853f00f9747c27c0066`) and Codex `gpt-6.1-sol` high
(runner `6aebb85398c04d3efd8fe0bb`). Neither received the site-vendor context file (both said so), so every
site-vendor fact in §1 was re-checked locally against revenue-engine `b65b0596`.

**Adopted** (each claim checked first):

- **YouTube facts were out of date** (both). Google reversed private-until-audit on 2026-11-02, confirmed on the
  revision history. `videos.insert` has its own 100-a-day bucket. Request `youtube.force-ssl` only (Fable). Testing
  tokens last 7 days. Shorts thumbnails wait for processing (Codex). Processing failure states. Caption
  de-duplication. The byte budget includes the credits. → §1, §4, P4, P5, §11.
- **The unique index forbade decision 1** (both): the same version to two sites, or several channels. → `target_key`
  in the index (§2.3).
- **Leases could double-publish:** a 60 s lease against a 15-minute step, and Netlify's own retries (both). → a
  fenced 2-minute lease renewed per bounded step, with commit-if-fence-matches (§2.4).
- **Removal and deletion in every state; stale workers and callbacks** (Codex blocker 1, Fable 5). → `desired` and
  `generation`, a removal manifest written before byte cleanup, a system principal, callbacks scoped to their
  operation (§2.4, §3.3).
- **Remote idempotency** (Codex 6). → stable publication and operation ids; Try again reconciles on the same
  publication (§2.4, §3.1).
- **The contract wasn't buildable from the docs alone** (both). → §3 made normative: the signing algorithm, the
  ±300 s window, headers, `contract: 1`, every event's body, response limits, 3xx and bad 2xx, `Retry-After`,
  callback answers and order, token lifetime, test vectors.
- **SSRF:** the webhook port discards bodies and `FetchPort` doesn't pin (Codex 7; checked `http.ts:104-110`). →
  `postJsonForResponse` with the same protections; site-vendor pulls are pinned and allowlisted (§3.1, §5.1).
- **Callback tokens must be recoverable on retry, and the routes sit behind `requireAuth`** (Codex 8; checked
  `app.ts:237`). → derived tokens, routes before `requireAuth` (§3.3).
- **`secretOnce` wasn't really once, and raw error bodies could leak** (Codex 9). → issued, expiry and consume times,
  an atomic reveal, safe errors only (§3.5, §3.2).
- **Too much data left the app:** the whole Video DTO holds the owner's email, prompts, plans and feedback (Codex 10;
  checked `videos.ts:890-1101`). Contact details were sent on every dialog open (Fable 6). → a minimal manifest, id
  only, contact opt-in (§2.5, §3.1).
- **Untrusted targets** (Codex 10). → receivers authorize by their own lookup, never by metadata (§3.4, §5.3).
- **Site-specific copy in the app** (both). → the receiver supplies `message`, `instructionsLabel`,
  `instructionsHint` and the secret's label; the app has generic defaults (§6.2).
- **Private videos' links last 600 s and die on a privacy change** (both; checked `files.ts:36,51,78`). → private
  videos don't go out (decision 7); links are 600 s, with the fresh-files route.
- **Two sources of truth for the share page** (both). → no rows for it; one domain path; a derived DTO entry
  (§2.3).
- **Integration gaps** (Codex 17; checked):
  - ETag (`videos.ts:1107`);
  - polling stops at ready (`Video.tsx:543`);
  - the published filter and badges (`drizzle.ts:189`, `Library.tsx:106`);
  - `mergeUser`.

  → §2.3, §6.1, §6.2.

- **Smaller fixes:**
  - `BlobsPort` has no stream (Codex; `deps.ts:142`);
  - no array columns (Fable 11);
  - built-in kinds stay virtual (Fable 11);
  - admin operationIds listed (Codex);
  - terminal-only webhook events (both);
  - observability (both);
  - the library badge's real location (Codex);
  - `idempotency-key` (Fable 15).
- **site-vendor and the receiver:**
  - content-addressed keys, a `sha256` required, `409` on a mismatch, `/tmp` staging for retries;
  - greedy key routes;
  - a durable queue in place of "202 then keep going";
  - `site.json` with conditional writes and a per-site lock;
  - strong reads in the edge function;
  - passwords set **at ensure** (site-vendor's ensure takes `protection`, `types.ts:98`), so a site is never public
    first.

  (Fable 12-13, Codex 14-15) → §5.1-§5.3.

- **The agent run:**
  - the SDK's landing modes already exist (both; `domain.d.ts:25`);
  - success means the commit reached production;
  - check the preview before landing;
  - a failure falls back or rolls back;
  - a lock and a credit ceiling.

  (Codex 16, Fable 14) → §5.4, P6.

- **Structure** (Fable 16): added facts, gates, "Not in v1", sources and this log.
- **Cut or deferred for v1** (both): `gif`, `posterWebp` and narration out of the manifest; YouTube removal is
  make-private only; options are string and boolean only; no "uploads left today"; "Ask the agent again" deferred.

**Rejected or changed:**

- **Dropping `secretOnce` and passwords from 3a** (Fable). The owner decided passwords are shown once; kept,
  hardened instead.
- **Dropping `retryDestinationPublication`** (Fable: "Try again = publish again"). Kept, because Try again must
  reconcile the same publication rather than make a new one (Codex 6).
- **Codex's suggestion to defer the agent run until simple publishing passes its gates.** It already sits in 3b,
  after 3a's gate; kept as is.
- **Codex's "15 minutes may not cover a 2 GiB upload."** True in principle, but each step is bounded and the fenced
  lease lets a later invocation carry on. No time guarantee is needed.

**Questions both reviewers raised** that are now proposed defaults (decisions 7-11) or still open (§9).
