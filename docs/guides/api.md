# The API and CI

## The API

From scripts, use the CLI or the TypeScript SDK. Both are on the app's **API docs** pages (`/docs/cli`, `/docs/sdk`)
with your site's URL filled in.

```sh
video-agent login --url https://<site>     # approve it in the browser; or VIDEO_AGENT_URL and VIDEO_AGENT_KEY in CI
video-agent create "A 20-second launch video for our new webhooks feature" --aspect 16:9 --wait --out ./webhooks
```

```ts
import { VideoAgent } from 'netlify-video-agent-sdk'
const va = new VideoAgent({ url: 'https://<site>', apiKey: process.env.VIDEO_AGENT_KEY })
const video = await va.videos.create({ prompt: 'A 20-second launch video for webhooks', aspect: '16:9' })
await va.files.download(await va.videos.wait(video.id), { file: 'video', to: './webhooks.mp4' })
```

Reference: the app's **API docs → REST API** page (`/docs/api`), built from the OpenAPI spec at `/api/openapi.json` (committed as
[`app/web/src/api/openapi.json`](../../app/web/src/api/openapi.json)). A standalone copy is at `/api/docs`. With plain HTTP:

```sh
curl -X POST https://<site>/api/v1/videos -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"prompt":"A 20-second launch video for our new webhooks feature","aspect":"16:9"}'
```

Webhooks (`video.ready`, `video.failed`) are signed: `X-Video-Agent-Signature: t=<unix>,v1=<hex>` where the hex
is HMAC-SHA256 of `"<t>.<raw body>"` with the key's webhook secret (shown once when the key is created). Dedupe on
`eventId`; retries continue for 24 hours.

## Videos from CI

The [GitHub Action](../../packages/action/README.md) makes a demo video when someone adds the `video` label to a pull
request, and a changelog video for a release. It posts the video in one comment on the PR that keeps itself up to date,
and takes `/video revise <what to change>` replies. It reads the PR through GitHub's API and never runs its code; fork
PRs are off and only people with write access start videos. Use a Creator account just for CI, so disabling it stops
all CI spend.

```yaml
- uses: netlify-labs/video-agent/packages/action@<full commit sha> # action-v1.0.0
  with:
    url: ${{ vars.VIDEO_AGENT_URL }} # an org-level variable
    api-key: ${{ secrets.VIDEO_AGENT_KEY }}
```

The **API docs → GitHub Action** page (`/docs/github`) has the workflows with your site's URL filled in and shows
which features your deployment offers the action. Other CI systems get the same briefs from the CLI:
`npx -y netlify-video-agent brief pr <url> | npx -y netlify-video-agent create --prompt-file - --wait`.
