# The TypeScript SDK and the player

Use the SDK when you're writing code that makes videos: a script, a CI step, a server. It wraps the REST API with
types, auth, retries and helpers for waiting, downloading and uploading. For a quick one-off from a shell, the
`video-agent-cli` skill is simpler.

## Install and connect

```sh
npm install netlify-video-agent-sdk
```

```ts
import { VideoAgent } from 'netlify-video-agent-sdk'

// The key comes from VIDEO_AGENT_KEY (or pass apiKey). url defaults to VIDEO_AGENT_URL.
const va = new VideoAgent({ url: '{{SITE_URL}}' })
```

Keys come from {{SITE_URL}}/keys. Keep them in the environment. Never ship one in a browser bundle: call the API from
your server instead.

## Make, wait, download

```ts
const { looks } = await va.looks.list()
const video = await va.videos.create({
  prompt: 'A 20-second launch video for our webhooks feature',
  aspect: '16:9',
  look: 'kinetic',
})
const ready = await va.videos.wait(video.id, { onProgress: (p) => console.log(p.stage, p.step) })
await va.files.download(ready, { file: 'video', to: './webhooks.mp4' })
```

`wait` has no timeout unless you pass `timeoutMs`, because a busy queue can take a while. It throws a
`VideoAgentError` if the version fails or is cancelled. `files.download` also takes `poster`, `gif`, `captions`,
`narration-audio` and `transcript`, and `files.url` gives a link you can fetch without the key.

## Change it

```ts
await va.videos.revise(video.id, { prompt: 'Make the end card orange' })
await va.videos.redoScenes(video.id, { beats: ['demo'], prompt: 'Show the preview URL' })
const remix = await va.videos.remix(video.id, { prompt: 'Same format, about edge functions' })
```

A revision is a new version that changes only what you describe. `redoScenes` changes only the scenes you name
(ids from `va.versions.beats(id, n)`) and keeps the rest exactly. A remix is a new video of your own.

## Media and publishing

```ts
const logo = await va.media.upload('./logo.svg', { caption: 'Our logo' })
await va.videos.create({ prompt: 'A teaser for the new dashboard', mediaIds: [logo.id] })

const pub = await va.versions.publish(video.id, 1)
console.log(pub.urls?.page, pub.embed)
```

`media.uploadRecording` uploads a screen recording for a demo video. `music.search` and `music.importAndWait` find and
add CC0 or CC BY music from Openverse.

## Errors and features

```ts
import { isVideoAgentError } from 'netlify-video-agent-sdk'

try {
  await va.videos.create({ prompt: '…' })
} catch (e) {
  if (isVideoAgentError(e, 'remix_disabled')) console.log('Remix is off on this deployment')
  else throw e
}
if (await va.config.supports('remix')) {
  /* this deployment offers remix */
}
```

Every error has `status`, `code`, `message` and the `requestId` an admin can look up. Deployments update on their own
schedule, so check `config.supports` before using a newer feature. `va.raw` reaches any route the typed methods don't
cover.

## Webhooks

Pass `webhookUrl` when you create or revise, and check each delivery before you trust it:

```ts
import { parseWebhook } from 'netlify-video-agent-sdk'

const event = await parseWebhook({ secret: process.env.VIDEO_AGENT_WEBHOOK_SECRET!, body: rawBody, headers })
if (event.event === 'video.ready') console.log(event.video?.id)
```

`body` must be the raw request body, not re-serialized JSON. Deduplicate on `eventId`: retries reuse it.

## Show a video on a page

The player is a web component with no dependencies. It reads a published video's share link for the size, poster,
captions and credits.

```html
<script type="module" src="{{SITE_URL}}/player.js"></script>
<video-agent-player src="{{SITE_URL}}/v/<slug>"></video-agent-player>
```

From npm it's `netlify-video-agent-player` (`import 'netlify-video-agent-player'`). The publish response's `player`
field has the snippet for each video.
