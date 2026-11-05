// The TypeScript SDK (netlify-video-agent-sdk; cli-and-sdk plan §8): install, a quickstart with this site's URL, the
// resources and helpers, waiting and downloading, uploads, webhooks, errors and retries, raw, and feature detection.
// Request and response shapes live on /docs/api; this page never loads the API reference.
import { Anchor, Card, Code, Stack, Table, Text } from '@mantine/core'
import { Link } from 'react-router'
import { PageHeader } from '../../components/bits'
import { CodeBlock } from '../../components/CodeBlock'
import { DocSections } from './DocsLayout'

const RESOURCES: [string, string][] = [
  ['videos', 'create, get, list, listAll, update, delete, revise, remix, favorite, progress, wait, resolve'],
  ['versions', 'retry, cancel, publish, unpublish, setVerdict, captions, setPoster, preview'],
  ['files', 'url, download'],
  ['media', 'upload, check, list, get, update, delete'],
  ['music', 'search, library, import, importAndWait'],
  ['plans', 'create, get, questions, brief, update'],
  ['looks', 'list'],
  ['comments', 'list, add, addBatch, update, delete'],
  ['webhooks', 'get, set, delete, test'],
  ['keys', 'list, revoke'],
  ['me', 'get, usage'],
  ['config', 'get, supports'],
]

export default function SdkGuidePage() {
  const site = window.location.origin
  const quickstart = `import { VideoAgent } from 'netlify-video-agent-sdk'

const va = new VideoAgent({
  url: '${site}',
  apiKey: process.env.VIDEO_AGENT_KEY, // nva_…, from ${site}/keys
})

const video = await va.videos.create({ prompt: 'A 20-second launch video for webhooks', aspect: '16:9' })
const ready = await va.videos.wait(video.id, { onProgress: (p) => console.log(p.status, p.step) })
await va.files.download(ready, { file: 'video', to: './webhooks.mp4' })
const pub = await va.versions.publish(ready.id, ready.latestVersion)
console.log(pub.urls?.page, pub.embed)`
  const webhooks = `import { parseWebhook } from 'netlify-video-agent-sdk'

// Netlify Functions (and anything with a web Request): read the raw body, then verify.
export default async (req: Request) => {
  const event = await parseWebhook({
    secret: process.env.VIDEO_AGENT_WEBHOOK_SECRET!,
    body: await req.text(),
    headers: req.headers,
  })
  if (event.event === 'video.ready') console.log(event.video?.title, event.eventId)
  return new Response(null, { status: 204 })
}

// Express: keep the raw body for this route.
app.post('/hooks/video', express.text({ type: 'application/json' }), async (req, res) => {
  const event = await parseWebhook({ secret, body: req.body, headers: req.headers })
  res.sendStatus(204)
})

// Hono: c.req.text(), c.req.raw.headers. Next.js route handler: await request.text(), request.headers.`
  return (
    <>
      <PageHeader
        title="TypeScript SDK"
        sub={
          <>
            <Code>netlify-video-agent-sdk</Code>: a typed client for this Video Agent, for scripts, CI and
            backends.
          </>
        }
      />
      <DocSections
        sections={[
          {
            id: 'install',
            title: 'Install',
            children: (
              <Card>
                <Code block>npm install netlify-video-agent-sdk</Code>
                <Text size="sm" c="var(--va-muted)" mt="sm">
                  Node 22 or later, or any runtime with <Code>fetch</Code> and WebCrypto. No dependencies. The
                  SDK reads <Code>VIDEO_AGENT_URL</Code> and <Code>VIDEO_AGENT_KEY</Code> when you don't pass
                  them.
                </Text>
              </Card>
            ),
          },
          {
            id: 'quickstart',
            title: 'Quickstart',
            description: 'Make a video, wait for it, download it and publish it.',
            children: (
              <Card>
                <CodeBlock code={quickstart} lang="ts" />
              </Card>
            ),
          },
          {
            id: 'resources',
            title: 'Resources',
            description: (
              <>
                Every API route is a method, named after the route (shapes on{' '}
                <Anchor component={Link} to="/docs/api" inherit>
                  REST API
                </Anchor>
                ). Path parameters come first, then one input object, then options.
              </>
            ),
            children: (
              <Card>
                <Table>
                  <Table.Tbody>
                    {RESOURCES.map(([r, m]) => (
                      <Table.Tr key={r}>
                        <Table.Td>
                          <Code>va.{r}</Code>
                        </Table.Td>
                        <Table.Td>{m}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Card>
            ),
          },
          {
            id: 'waiting',
            title: 'Waiting and downloading',
            children: (
              <Card>
                <Stack gap="xs">
                  <Text size="sm">
                    <Code>videos.wait(id, {'{ timeoutMs, onProgress, signal }'})</Code> resolves when the
                    version is ready and throws <Code>video_failed</Code> when it fails, is cancelled or times
                    out. It has no timeout unless you give one: a busy queue can take longer than any fixed
                    limit.
                  </Text>
                  <Text size="sm">
                    <Code>files.download(video, {'{ file, to }'})</Code> streams to a file (Node) or returns
                    the response. Signed links last 5 to 10 minutes; the SDK fetches them at once, never with
                    your key.
                  </Text>
                </Stack>
              </Card>
            ),
          },
          {
            id: 'uploads',
            title: 'Uploads',
            children: (
              <Card>
                <CodeBlock
                  code={`const shot = await va.media.upload('./checkout.png', { caption: 'The new checkout page' })
await va.videos.create({ prompt: 'A 20-second demo of the new checkout', mediaIds: [shot.id] })`}
                  lang="ts"
                />
                <Text size="sm" c="var(--va-muted)" mt="sm">
                  Any size: files over 4 MB go in parts, resume after a failure and wait until the item is
                  ready. An identical file already in the library is returned instead of uploaded again.
                </Text>
              </Card>
            ),
          },
          {
            id: 'looks',
            title: 'Looks',
            description: (
              <>
                A look is a named style for a video (
                <Anchor component={Link} to="/docs/looks" inherit>
                  Looks
                </Anchor>
                ). Pass its id as <Code>look</Code>; <Code>null</Code> is none.
              </>
            ),
            children: (
              <Card>
                <CodeBlock
                  code={`const { looks } = await va.looks.list()
const video = await va.videos.create({ prompt: 'A 20-second launch video for webhooks', look: 'kinetic' })
// A revision with another look restyles it: same story, new style.
await va.videos.revise(video.id, { prompt: 'Restyle it', look: 'terminal' })`}
                  lang="ts"
                />
              </Card>
            ),
          },
          {
            id: 'webhooks',
            title: 'Webhooks',
            description: 'Verify every delivery with the raw body. Dedupe on eventId: redeliveries keep it.',
            children: (
              <Card>
                <CodeBlock code={webhooks} lang="ts" />
              </Card>
            ),
          },
          {
            id: 'errors',
            title: 'Errors and retries',
            children: (
              <Card>
                <Text size="sm">
                  Every failure is a <Code>VideoAgentError</Code> with <Code>status</Code>, <Code>code</Code>,{' '}
                  <Code>message</Code> and Netlify's <Code>requestId</Code>; check one with{' '}
                  <Code>isVideoAgentError(e, 'remix_disabled')</Code>. Reads and creates retry on network
                  errors, 429 and 5xx. Creates, revisions and remixes send an idempotency key, so a retry
                  never makes two videos.
                </Text>
              </Card>
            ),
          },
          {
            id: 'features',
            title: 'Server features',
            children: (
              <Card>
                <Text size="sm">
                  Deployments update on their own schedule. <Code>await va.config.supports('remix')</Code>{' '}
                  says what this one offers, and a method for something it doesn't offer throws{' '}
                  <Code>unsupported_by_server</Code> instead of a confusing 404.
                </Text>
              </Card>
            ),
          },
          {
            id: 'raw',
            title: 'Any route',
            children: (
              <Card>
                <CodeBlock code={`const { data } = await va.raw.GET('/api/v1/me/usage')`} lang="ts" />
              </Card>
            ),
          },
          {
            id: 'player',
            title: 'Player',
            description: (
              <>
                <Code>{'<video-agent-player>'}</Code> plays a published video on any page: sized before it
                loads, captions on, CC BY credits always shown. No dependencies. The publish response's{' '}
                <Code>player</Code> field has this snippet for each video.
              </>
            ),
            children: (
              <Card>
                <CodeBlock
                  code={`<script type="module" src="${site}/player.js"></script>
<video-agent-player src="${site}/v/<slug>"></video-agent-player>

<!-- Or from npm: import 'netlify-video-agent-player' -->`}
                  lang="http"
                />
              </Card>
            ),
          },
          {
            id: 'browser',
            title: 'In a browser',
            children: (
              <Card>
                <Text size="sm">
                  Don't put an API key in a browser bundle: anyone can read it and act as you. Call the API
                  from your server. If you must call it from a page, an admin lists that page's origin in{' '}
                  <Code>ALLOWED_ORIGINS</Code> so CORS allows it.
                </Text>
              </Card>
            ),
          },
        ]}
      />
    </>
  )
}
