# netlify-video-agent-sdk

[![npm](https://img.shields.io/npm/v/netlify-video-agent-sdk)](https://www.npmjs.com/package/netlify-video-agent-sdk)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

**Make, revise and publish videos from code.** A typed client for the REST API of your
[Video Agent](https://github.com/netlify-labs/video-agent) deployment, with no runtime dependencies.

```sh
npm install netlify-video-agent-sdk
```

## Why use it

**The problem.** A video takes minutes to make, so calling the API yourself means writing a polling loop, a
multipart upload that resumes, retries that never make two videos, and webhook signature checks.

**The solution.** One client that does those for you, typed from the deployment's OpenAPI spec.

| What you get           | How                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| Every route, typed     | Methods are generated from the spec: `va.videos.create`, `va.versions.publish` and the rest |
| Waiting done right     | `va.videos.wait(id)` polls with `If-None-Match`, reports progress and throws on failure     |
| Uploads of any size    | `va.media.upload('./take.mp4')` uploads in parts and resumes after a failure                |
| Safe retries           | GETs and idempotent POSTs retry 3 times by default                                          |
| One error type         | Every failure is a `VideoAgentError` with a `status`, a `code` and a request id             |
| Verified webhooks      | `parseWebhook` checks the signature and the timestamp before you see the event              |
| Works with old servers | `va.config.supports('remix')` tells you what your deployment offers                         |

## Quick example

```ts
import { VideoAgent } from 'netlify-video-agent-sdk'

const va = new VideoAgent({
  url: 'https://<your-site>', // default: VIDEO_AGENT_URL
  apiKey: process.env.VIDEO_AGENT_KEY, // nva_…, from https://<your-site>/keys
})

// Make a video and wait for it
const video = await va.videos.create({ prompt: 'A 20-second launch video for webhooks', aspect: '16:9' })
const ready = await va.videos.wait(video.id, { onProgress: (p) => console.log(p.status, p.step) })

// Download the MP4
await va.files.download(ready, { file: 'video', to: './webhooks.mp4' })

// Ask for a change, then wait for version 2
await va.videos.revise(ready.id, { prompt: 'Make the end card orange' })
const v2 = await va.videos.wait(ready.id)

// Publish it: a share page, an MP4 link and an embed snippet
const pub = await va.versions.publish(v2.id, v2.latestVersion)
console.log(pub.urls?.page, pub.embed)
```

## SDK, CLI or plain fetch

|                                   | This SDK               | [`video-agent` CLI](https://www.npmjs.com/package/netlify-video-agent) | Plain `fetch`   |
| --------------------------------- | ---------------------- | ---------------------------------------------------------------------- | --------------- |
| Best for                          | Apps, servers, scripts | Shells, CI steps, coding agents                                        | Other languages |
| Typed inputs and results          | Yes                    | `--json` output                                                        | No              |
| Waiting and uploads               | Built in               | Built in                                                               | You write them  |
| Webhook verification              | `parseWebhook`         | No                                                                     | You write it    |
| Makes videos without a deployment | No                     | Yes (`video-agent local`)                                              | No              |

## Install

```sh
npm install netlify-video-agent-sdk
pnpm add netlify-video-agent-sdk
yarn add netlify-video-agent-sdk
```

It needs Node 22 or later, or any runtime that has `fetch` and WebCrypto (Deno, Bun, edge functions). The package is
ES modules only.

## Setup

1. Deploy Video Agent, or get the address of your team's site.
2. Create an API key at `https://<your-site>/keys`. It starts with `nva_`.
3. Set `VIDEO_AGENT_URL` and `VIDEO_AGENT_KEY`, then `new VideoAgent()` needs no arguments.

| Option      | Default            | What it does                                                                  |
| ----------- | ------------------ | ----------------------------------------------------------------------------- |
| `url`       | `VIDEO_AGENT_URL`  | Your deployment, like `https://acme-video.netlify.app`                        |
| `apiKey`    | `VIDEO_AGENT_KEY`  | An `nva_` key. Without one, only the public routes work                       |
| `retries`   | `3`                | Retries for GETs and idempotent POSTs                                         |
| `userAgent` | none               | Added to the User-Agent, so the deployment's logs show who calls              |
| `logger`    | none               | Gets one event per attempt: method, path, status, ms. Never headers or bodies |
| `fetch`     | `globalThis.fetch` | Your own `fetch`, for tests or proxies                                        |

## What's in it

Each resource is a property of the client. The methods come from the API spec, so your editor lists them all.

| Resource                              | Use it to                                                                                                       |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `va.videos`                           | `create`, `revise`, `remix`, `get`, `list`, `update`, `delete`, plus `wait`, `listAll`, `resolve`, `redoScenes` |
| `va.versions`                         | `publish`, `unpublish`, `cancel`, `retry`, `beats` (scenes), `setVerdict`, posters and captions                 |
| `va.files`                            | `url` and `download` for a version's video, poster, GIF, captions, narration audio and transcript               |
| `va.media`                            | `upload`, `uploadRecording`, `list`, `get`, `update`, `delete`                                                  |
| `va.music`                            | Search Openverse or the library, and `importAndWait`                                                            |
| `va.comments`                         | List, add, update and delete review comments                                                                    |
| `va.plans`                            | Ask planning questions and write a brief before making the video                                                |
| `va.looks`, `va.voices`, `va.engines` | List what the deployment offers                                                                                 |
| `va.destinations`                     | Publish a version to a connected destination                                                                    |
| `va.webhooks`                         | `set`, `get`, `delete` and `test` your webhook                                                                  |
| `va.keys`, `va.me`                    | Your API keys, account and usage                                                                                |
| `va.config`                           | The server's version and features: `get`, `supports`                                                            |
| `va.raw`                              | Any route, typed by the spec, with the same auth, retries and errors                                            |

### Wait for a video

`wait` has no timeout unless you give one, because a busy queue can take longer than any fixed limit.

```ts
const ready = await va.videos.wait(video.id, {
  timeoutMs: 30 * 60_000, // throws code wait_timeout
  onProgress: (p) => console.log(`v${p.version} ${p.status} ${p.stage ?? ''} ${p.step ?? ''}`),
  signal: AbortSignal.timeout(45 * 60_000),
})
```

It throws `video_failed` when the version failed, was cancelled or timed out on the server.

### Redo some scenes

```ts
const { latestVersion } = await va.videos.get(id)
console.log(await va.versions.beats(id, latestVersion)) // the version's scenes, with their ids
await va.videos.redoScenes(id, { beats: ['intro'], prompt: 'Shorter title' })
```

### Upload media

```ts
const shot = await va.media.upload('./dashboard.png', {
  caption: 'The new dashboard',
  onProgress: (p) => console.log(p.phase, p.sent, p.total),
})
await va.videos.create({ prompt: 'A teaser that shows the dashboard', mediaIds: [shot.id] })
```

`upload` takes a path (Node), a `Blob`, a `File` or bytes. An identical file already in the library is returned
instead of uploaded again.

### List everything

```ts
for await (const v of va.videos.listAll()) console.log(v.id, v.title)
for await (const m of va.listAll(va.media.list, { kind: 'audio' })) console.log(m.id)
```

Pages are fetched only as you use them.

### Handle errors

```ts
import { isVideoAgentError } from 'netlify-video-agent-sdk'

try {
  await va.videos.remix(id, { prompt: 'The same, for mobile' })
} catch (e) {
  if (isVideoAgentError(e, 'remix_disabled')) console.log('Remix is off on this deployment.')
  else if (isVideoAgentError(e)) console.error(e.status, e.code, e.message, e.requestId)
  else throw e
}
```

`e.retryAfterSec` holds the server's `Retry-After` when it sent one. `e.requestId` is Netlify's request id, so an
admin can find the request in the function logs.

### Verify webhooks

Pass the raw body, not re-serialized JSON.

```ts
import { parseWebhook } from 'netlify-video-agent-sdk'

export default async (req: Request) => {
  const event = await parseWebhook({
    secret: process.env.VIDEO_AGENT_WEBHOOK_SECRET!,
    body: await req.text(),
    headers: req.headers,
  }) // throws code invalid_signature
  if (event.event === 'video.ready') console.log(event.video?.id, 'is ready')
  return new Response(null, { status: 204 })
}
```

Redeliveries carry the same `event.eventId`, so dedupe on it. The events are `video.ready`, `video.failed`,
`comment.created`, `version.approved`, `version.changes_requested`, `destination.live`, `destination.failed` and
`destination.removed`. Set your endpoint with `va.webhooks.set({ url })`; the secret is in the response.

### Call a route with no method yet

```ts
const { data } = await va.raw.GET('/api/v1/me/usage')
```

## Troubleshooting

| Code or message                       | What it means                                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `status` 401                          | No key, or a revoked one. Create a key at `<your-site>/keys`                                              |
| `unsupported_by_server`               | The deployment doesn't list that feature. Check with `va.config.supports(feature)`                        |
| `wait_timeout`                        | Your `timeoutMs` passed. The video is still being made; call `wait` again                                 |
| `video_failed`                        | The run failed. `va.videos.get(id)` shows why; `va.versions.retry(id, n)` tries again                     |
| `invalid_signature`                   | The wrong secret, a parsed-then-restringified body, or a delivery older than 300 s                        |
| `This runtime hides redirect targets` | `files.url` and `files.download` can't follow the file route in a browser. Use the version's signed links |
| `status` 0                            | No response decided it: a network failure, or a feature the server lacks                                  |

## Limitations

- **It needs a deployment.** The SDK calls your site's API. To make videos on your own machine with no server, use
  the CLI's `video-agent local`.
- **ES modules only.** There's no CommonJS build; use `import`, or `await import()` from CommonJS.
- **Keep the key on a server.** An `nva_` key acts as you, so don't ship it to a browser.
- **Uploading by path is Node only.** In other runtimes pass a `Blob`, a `File` or bytes.
- **No default deployment.** Without `url` or `VIDEO_AGENT_URL` there's nothing to call.

## FAQ

**How long does `create` take?**
`create` returns at once with the video's id. The video itself takes minutes, so call `wait`, or set a webhook and
return.

**How do I avoid making the same video twice when I retry?**
`create`, `revise` and `remix` each send an `Idempotency-Key`, so the SDK's own retries never make two. For your own
retries, pass the same key each time: `va.videos.create(input, { idempotencyKey })`.

**Can I use it in Deno, Bun or an edge function?**
Yes. It needs `fetch` and WebCrypto, which they have.

**How do I show the published video on my page?**
`pub.embed` is a ready snippet. It uses
[`netlify-video-agent-player`](https://www.npmjs.com/package/netlify-video-agent-player).

**Where's the full reference?**
Your deployment serves the guide at `/docs/sdk` and the API reference at `/docs/api`, with its own URL filled in.
Every type is exported too: `components['schemas']['Video']`, `paths` and `operations`.

## License

MIT
