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

// Netlify Functions, and any runtime with a web Request: read the raw body, and then verify it.
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

// Hono: use c.req.text() and c.req.raw.headers.
// Next.js route handler: use await request.text() and request.headers.`
  return (
    <>
      <PageHeader
        title="TypeScript SDK"
        sub={
          <>
            <Code>netlify-video-agent-sdk</Code> is a typed client for this Video Agent. Use it in scripts,
            CI, and backends.
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
                  The SDK needs Node 22 or later, or any runtime that has <Code>fetch</Code> and WebCrypto. It
                  has no dependencies. If you don&apos;t pass a URL and a key, the SDK reads them from the{' '}
                  <Code>VIDEO_AGENT_URL</Code> and <Code>VIDEO_AGENT_KEY</Code> environment variables.
                </Text>
              </Card>
            ),
          },
          {
            id: 'quickstart',
            title: 'Quickstart',
            description: 'Make a video, wait for it, download it, and publish it.',
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
                Every API route is a method that&apos;s named after the route. A method takes path parameters
                first, then one input object, then options. For request and response shapes, see{' '}
                <Anchor component={Link} to="/docs/api" inherit>
                  REST API
                </Anchor>
                .
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
            title: 'Wait and download',
            children: (
              <Card>
                <Stack gap="xs">
                  <Text size="sm">
                    <Code>videos.wait(id, {'{ timeoutMs, onProgress, signal }'})</Code> resolves when the
                    version is ready. It throws <Code>video_failed</Code> if the version fails, is canceled,
                    or times out. It has no timeout unless you set <Code>timeoutMs</Code>, because a busy
                    queue can take longer than any fixed limit.
                  </Text>
                  <Text size="sm">
                    <Code>files.download(video, {'{ file, to }'})</Code> streams to a file in Node, and
                    returns the response in other runtimes. Signed links last 5 to 10 minutes. The SDK fetches
                    a link as soon as it gets one, and never sends your key with that request.
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
                  A file can be any size. A file over 4 MB uploads in parts, and resumes after a failure.{' '}
                  <Code>upload</Code> returns when the item is ready to use. If an identical file is already
                  in the library, you get that item back instead of a second copy.
                </Text>
              </Card>
            ),
          },
          {
            id: 'looks',
            title: 'Looks',
            description: (
              <>
                A look is a named style for a video. Pass the look&apos;s ID as <Code>look</Code>, or{' '}
                <Code>null</Code> for no look. For the looks in this deployment, see{' '}
                <Anchor component={Link} to="/docs/looks" inherit>
                  Looks
                </Anchor>
                .
              </>
            ),
            children: (
              <Card>
                <CodeBlock
                  code={`const { looks } = await va.looks.list()
const video = await va.videos.create({ prompt: 'A 20-second launch video for webhooks', look: 'kinetic' })
// A revision with a different look restyles the video. The story stays, and the style changes.
await va.videos.revise(video.id, { prompt: 'Restyle it', look: 'terminal' })`}
                  lang="ts"
                />
              </Card>
            ),
          },
          {
            id: 'webhooks',
            title: 'Webhooks',
            description:
              'Verify every delivery against the raw request body. To skip duplicates, remember each eventId. A redelivery keeps the same one.',
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
                  Every failure is a <Code>VideoAgentError</Code>. It has a <Code>status</Code>, a{' '}
                  <Code>code</Code>, a <Code>message</Code>, and Netlify&apos;s <Code>requestId</Code>. To
                  check for one code, use <Code>isVideoAgentError(e, &apos;remix_disabled&apos;)</Code>.
                </Text>
                <Text size="sm" mt="xs">
                  Reads and creates retry after network errors, and after <Code>429</Code> and{' '}
                  <Code>5xx</Code> responses. Creates, revisions, and remixes send an idempotency key, so a
                  retry never makes a second video.
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
                  Deployments update on their own schedules, so one might not have a feature yet. To check,
                  call <Code>await va.config.supports(&apos;remix&apos;)</Code>. If you call a method for a
                  feature that the deployment doesn&apos;t have, the method throws{' '}
                  <Code>unsupported_by_server</Code> instead of a confusing <Code>404</Code>.
                </Text>
              </Card>
            ),
          },
          {
            id: 'raw',
            title: 'Call any route',
            description: 'To call a route directly, with the same sign-in and retries, use va.raw.',
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
                The <Code>{'<video-agent-player>'}</Code> element plays a published video on any page. It
                reserves its size before the video loads, turns on captions, and always shows CC BY credits.
                It has no dependencies. The publish response includes this snippet for each video, in its{' '}
                <Code>player</Code> field.
              </>
            ),
            children: (
              <Card>
                <CodeBlock
                  code={`<script type="module" src="${site}/player.js"></script>
<video-agent-player src="${site}/v/<slug>"></video-agent-player>

<!-- Or install it from npm, and then: import 'netlify-video-agent-player' -->`}
                  lang="http"
                />
              </Card>
            ),
          },
          {
            id: 'browser',
            title: 'Use the API from a browser',
            children: (
              <Card>
                <Text size="sm">
                  Don&apos;t put an API key in a browser bundle. Anyone can read it there and act as you. Call
                  the API from your server instead. If a page must call the API directly, ask an admin to add
                  that page&apos;s origin to <Code>ALLOWED_ORIGINS</Code>, so that CORS allows it.
                </Text>
              </Card>
            ),
          },
        ]}
      />
    </>
  )
}
