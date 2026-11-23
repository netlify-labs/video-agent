# netlify-video-agent-sdk

A typed client for the REST API of a [Video Agent](https://github.com/netlify-labs/video-agent) deployment: create,
wait for, download and publish videos, upload media, and verify webhooks.

```sh
npm install netlify-video-agent-sdk
```

It needs Node 22 or later, or any runtime that has `fetch` and WebCrypto.

```ts
import { VideoAgent } from 'netlify-video-agent-sdk'

const va = new VideoAgent({
  url: 'https://<your-site>', // default: VIDEO_AGENT_URL
  apiKey: process.env.VIDEO_AGENT_KEY, // nva_…, from https://<your-site>/keys
})

const video = await va.videos.create({ prompt: 'A 20-second launch video for webhooks', aspect: '16:9' })
const ready = await va.videos.wait(video.id, { onProgress: (p) => console.log(p.status, p.step) })
await va.files.download(ready, { file: 'video', to: './webhooks.mp4' })
const pub = await va.versions.publish(ready.id, ready.latestVersion)
console.log(pub.urls?.page, pub.embed)
```

Every failure is a `VideoAgentError` with a `status`, a `code` and a `message`. To check for one code, use
`isVideoAgentError(e, 'remix_disabled')`. For a route with no method yet, use `va.raw`:

```ts
const { data } = await va.raw.GET('/api/v1/me/usage')
```

Your deployment has the full guide at `/docs/sdk` and the API reference at `/docs/api`.

## License

MIT
