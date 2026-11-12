// /docs/destinations: the HTTP destination contract v1, normative (docs/plans/2026-11-04-publish-destinations.md §3).
// A third party must be able to build a receiver from this page alone. The signature vectors are checked by a test
// against the server's signer; the example receiver is the one the tests run against the app.
import { Card, Code, List, Stack, Table, Text } from '@mantine/core'
import receiverSource from '../../../../../docs/examples/destination-receiver/receiver.ts?raw'
import { CopyField, PageHeader } from '../../components/bits'
import { CodeBlock } from '../../components/CodeBlock'
import { DESTINATION_VECTORS } from '../../lib/destination-vectors'
import { DocSections } from './DocsLayout'

const PUBLISH = `{
  "contract": 1, "event": "publish", "sentAt": "2026-11-05T06:00:00.000Z",
  "destination": { "id": "dst_…", "name": "…" },
  "publisher": { "id": "u_…" },            // + "name", "email" only if the admin turned that on
  "publication": "dpub_…",                 // stable for this publication
  "operation": "dpub_…:publish:1",         // stable across retries: your idempotency key
  "options": { },                          // checked against your options form
  "target": null,                          // or one of your targets, exactly as you listed it
  "instructions": null,                    // or the publisher's text, if you take instructions
  "manifest": {
    "video": { "id": "vid_…", "title": "…", "language": "en" },
    "version": { "n": 3, "title": "…", "summary": "…", "width": 1920, "height": 1080, "durationSec": 74,
                 "credits": [ … ] },        // CC BY credits: show them with the video
    "files": [ { "kind": "mp4", "contentType": "video/mp4", "bytes": 41234567, "sha256": "…", "url": "https://…" },
               { "kind": "poster", … }, { "kind": "captions", … }, { "kind": "transcript", … } ],
    "sharePage": "https://…/v/abc123"      // or null
  },
  "callback": { "url": "https://…/api/v1/destination-callbacks/dpub_…", "token": "dpc_…", "expiresAt": "…" }
}`

const REMOVE = `{
  "contract": 1, "event": "remove", "sentAt": "…", "destination": { … }, "publisher": { "id": "u_…" },
  "publication": "dpub_…", "operation": "dpub_…:remove:2",
  "externalId": "…",                       // the ID that you returned, or null (then use "publication")
  "url": "…", "target": null,
  "callback": { "url": "…", "token": "…", "expiresAt": "…" }
}`

const CALLBACK = `POST {callback.url}
Authorization: Bearer {callback.token}
Content-Type: application/json

{ "operation": "dpub_…:publish:1", "status": "live", "url": "https://…", "externalId": "…",
  "message": "…", "warnings": ["…"], "secretOnce": { "label": "Site password", "value": "…" } }`

const VERIFY = `import { createHmac, timingSafeEqual } from 'node:crypto'

function verify(secret, rawBody, header, nowSec) {
  const m = /^t=(\\d+),v1=([0-9a-f]{64})$/.exec(header)
  if (!m || Math.abs(nowSec - Number(m[1])) > 300) return false
  const want = createHmac('sha256', secret).update(\`\${m[1]}.\${rawBody}\`).digest()
  const got = Buffer.from(m[2], 'hex')
  return got.length === want.length && timingSafeEqual(got, want)
}`

const RESPONSES: [string, string, string][] = [
  ['publish', '200 {"status":"live","url"?,"externalId"?,"warnings"?}', 'The video is live.'],
  [
    'publish',
    '202 {"status":"accepted","externalId"?,"message"?}',
    'You accepted the request. Call back when you finish. Until then, the publisher sees your "message".',
  ],
  [
    'remove',
    '200 {"status":"removed"}, 204, or 404',
    'The video is removed. A 404 means that it was already gone.',
  ],
  ['remove', '202 {"status":"accepted","message"?}', 'You accepted the removal. Call back when you finish.'],
  ['targets', '200 {"targets":[Target…]}', 'Your targets for this publisher, 100 at most.'],
  ['ping', '200 {"capabilities"?}', 'You are reachable. "capabilities" says what you support.'],
  [
    'any',
    '408, 429, 5xx, timeout, network error',
    'Video Agent retries with backoff. It honors Retry-After for up to an hour.',
  ],
  [
    'any',
    '3xx, other 4xx, or a 2xx that doesn’t match',
    'The operation fails. Video Agent shows error.message from your body as plain text, up to 300 characters.',
  ],
]

/** What Video Agent answers to a callback. */
const CALLBACK_ANSWERS: [string, string][] = [
  ['204', 'The callback was applied, or it was a duplicate.'],
  ['401', 'The token is wrong or expired.'],
  ['404', 'The publication is unknown.'],
  ['409', 'That status isn’t allowed at this point.'],
  ['410', 'The publication was removed.'],
]

const OPTIONS_FORM = `{
  "type": "object",
  "properties": {
    "password": { "type": "boolean", "title": "Password-protect the site" },
    "sitePassword": { "type": "string", "format": "password", "showIf": "password", "minLength": 8 }
  }
}`

export default function DestinationsGuidePage() {
  const v = DESTINATION_VECTORS[0]
  return (
    <>
      <PageHeader
        title="Publish destinations"
        sub="Publish a ready version to places other than the share page: YouTube, or any HTTPS endpoint that follows this contract. To add an HTTP destination, an admin goes to Admin > Destinations."
      />
      <DocSections
        sections={[
          {
            id: 'overview',
            title: 'How it works',
            children: (
              <Text size="sm">
                When someone publishes a version to your destination, Video Agent sends a signed JSON request
                to your URL. The request has a short description of the version and signed links to its files.
                You can answer right away that the video is live, or accept the request and call back later. A
                retry reuses the same <Code>operation</Code> ID, so you can ignore duplicates. Removing a
                video works the same way. Video Agent never sends private videos.
              </Text>
            ),
          },
          {
            id: 'requests',
            title: 'Requests',
            children: (
              <Stack gap="sm">
                <Text size="sm">
                  Every request is a <Code>POST</Code> to your URL with{' '}
                  <Code>content-type: application/json; charset=utf-8</Code> and these headers:
                </Text>
                <List size="sm" spacing={4}>
                  <List.Item>
                    <Code>x-video-agent-signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</Code>
                  </List.Item>
                  <List.Item>
                    <Code>x-video-agent-event: publish | remove | targets | ping</Code>
                  </List.Item>
                  <List.Item>
                    <Code>x-video-agent-delivery: &lt;operation id&gt;</Code>, on publish and remove requests
                  </List.Item>
                </List>
                <Text size="sm">
                  Every body has the same common fields: <Code>contract: 1</Code>, <Code>event</Code>,{' '}
                  <Code>sentAt</Code>, <Code>destination</Code>, and <Code>publisher</Code>. The{' '}
                  <Code>publisher</Code> object always has an ID. It has a name and an email only if the admin
                  turned that on. Treat them as contact details, and never use them to authorize a request.
                </Text>
                <Text size="sm">
                  Video Agent connects only over HTTPS, only to public addresses, and with no credentials in
                  the URL. It doesn&apos;t follow redirects. It waits up to 30 seconds for your answer (5
                  seconds for <Code>targets</Code>), and reads up to 64 KB of it.
                </Text>
                <Text fw={600} size="sm">
                  publish
                </Text>
                <CodeBlock code={PUBLISH} lang="json" />
                <Text fw={600} size="sm">
                  remove
                </Text>
                <CodeBlock code={REMOVE} lang="json" />
                <Text size="sm">
                  A <Code>targets</Code> request sends the common fields plus{' '}
                  <Code>video: {'{ id, title }'}</Code>. A <Code>ping</Code> request sends only the common
                  fields, and its <Code>publisher</Code> is <Code>null</Code>.
                </Text>
                <Text size="sm">
                  File links are signed for 10 minutes. If you need more time, ask for fresh links. For the
                  request, see Callbacks.
                </Text>
              </Stack>
            ),
          },
          {
            id: 'verify',
            title: 'Verify requests',
            children: (
              <Stack gap="sm">
                <Text size="sm">
                  The signature is{' '}
                  <Code>v1 = hex(HMAC-SHA256(secret, &quot;&lt;t&gt;.&quot; + raw body bytes))</Code>. To
                  verify a request, follow these steps:
                </Text>
                <List type="ordered" size="sm" spacing={4}>
                  <List.Item>Compute the signature over the exact bytes that you received.</List.Item>
                  <List.Item>
                    Compare your result with <Code>v1</Code> in constant time.
                  </List.Item>
                  <List.Item>
                    Reject the request if <Code>t</Code> is more than 300 seconds from the current time.
                  </List.Item>
                </List>
                <CodeBlock code={VERIFY} lang="js" />
                <Text fw={600} size="sm">
                  Test vector
                </Text>
                <CopyField label="Secret" value={v.secret} />
                <CopyField label="t" value={String(v.t)} />
                <CopyField label="Body" value={v.body} />
                <CopyField label="x-video-agent-signature" value={v.signature} />
              </Stack>
            ),
          },
          {
            id: 'responses',
            title: 'Responses',
            children: (
              <Card p={0}>
                <Table>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Event</Table.Th>
                      <Table.Th>You answer</Table.Th>
                      <Table.Th>Meaning</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {RESPONSES.map(([e, a, m]) => (
                      <Table.Tr key={`${e}${a}`}>
                        <Table.Td>
                          <Code>{e}</Code>
                        </Table.Td>
                        <Table.Td>
                          <Code>{a}</Code>
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
            id: 'callbacks',
            title: 'Callbacks',
            children: (
              <Stack gap="sm">
                <Text size="sm">To report progress or a result, send a callback:</Text>
                <CodeBlock code={CALLBACK} lang="http" />
                <Text size="sm">
                  For a publish operation, the status is <Code>working</Code>, <Code>live</Code>, or{' '}
                  <Code>failed</Code>. For a remove operation, it&apos;s <Code>working</Code>,{' '}
                  <Code>removed</Code>, or <Code>failed</Code>. A <Code>working</Code> status only updates the
                  message. A callback can arrive before your <Code>202</Code> response does.
                </Text>
                <Text size="sm">Video Agent answers a callback with one of these status codes:</Text>
                <Table aria-label="Callback answers">
                  <Table.Tbody>
                    {CALLBACK_ANSWERS.map(([code, meaning]) => (
                      <Table.Tr key={code}>
                        <Table.Td>
                          <Code>{code}</Code>
                        </Table.Td>
                        <Table.Td>{meaning}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
                <Text size="sm">
                  Video Agent acknowledges and ignores a callback for an older operation. The token expires at
                  the operation&apos;s deadline, which is 24 hours for a publish and 7 days for a removal. It
                  also stops working when a newer operation starts.
                </Text>
                <Text fw={600} size="sm">
                  Fresh links
                </Text>
                <Text size="sm">
                  To get new signed links for the files, send <Code>POST {'{callback.url}'}/files</Code> with
                  the same token and the body <Code>{'{ "operation": "…" }'}</Code>. This works while that
                  publish is active.
                </Text>
                <Text fw={600} size="sm">
                  One-time secrets
                </Text>
                <Text size="sm">
                  To give the publisher a secret, such as a site password, send <Code>secretOnce</Code>. Video
                  Agent keeps it encrypted and shows it to the publisher one time. It&apos;s erased after
                  that, or after 24 hours if nobody views it. Send it one time for each publication.
                </Text>
              </Stack>
            ),
          },
          {
            id: 'targets',
            title: 'Targets and capabilities',
            children: (
              <Stack gap="sm">
                <Text size="sm">
                  A target is something that you already hold for this person, such as a site, a playlist, or
                  a page. Its shape is generic: <Code>{'{ id, name, description, url, metadata }'}</Code>.
                </Text>
                <List size="sm" spacing={4}>
                  <List.Item>
                    <Code>id</Code> and <Code>name</Code>: 200 characters at most.
                  </List.Item>
                  <List.Item>
                    <Code>description</Code>: 500 characters at most.
                  </List.Item>
                  <List.Item>
                    <Code>url</Code>: an HTTPS URL.
                  </List.Item>
                  <List.Item>
                    <Code>metadata</Code>: a flat object with 20 keys and 2 KB at most.
                  </List.Item>
                </List>
                <Text size="sm">
                  Video Agent shows the name, the description, and the URL. It sends the chosen target back to
                  you exactly as you listed it. The target passes through a browser on the way, so{' '}
                  <b>authorize it yourself</b>. Look up its ID for this destination and this publisher, and
                  never trust <Code>metadata</Code> for that.
                </Text>
                <Text fw={600} size="sm">
                  Capabilities
                </Text>
                <Text size="sm">
                  To get a target picker (“New site / Your sites”) and an instructions field with your own
                  wording, answer <Code>ping</Code> with your capabilities:
                </Text>
                <CodeBlock
                  code={
                    '{ "capabilities": { "targets": true, "targetNoun": "site", "instructions": true,\n    "instructionsLabel": "…", "instructionsHint": "…" } }'
                  }
                  lang="json"
                />
                <Text size="sm">
                  Video Agent asks again every hour. It also asks within a minute after an admin adds the
                  destination or changes its URL. A change to your answer therefore appears without anyone
                  sending a test.
                </Text>
                <Text fw={600} size="sm">
                  Options form
                </Text>
                <Text size="sm">
                  The options form is a subset of JSON Schema. It can have 10 properties at most, and each one
                  is a <Code>string</Code> or a <Code>boolean</Code>. A property can have a <Code>title</Code>
                  , a <Code>description</Code>, and a <Code>default</Code>. A string can also have{' '}
                  <Code>minLength</Code>, <Code>maxLength</Code>, and <Code>enum</Code>.
                </Text>
                <Text size="sm">Two more keys change how an option behaves:</Text>
                <List size="sm" spacing={4}>
                  <List.Item>
                    <Code>{'"format": "password"'}</Code> makes a string a secret. It&apos;s masked in the
                    dialog, encrypted at rest, sent to you in <Code>options</Code>, and never shown again.
                  </List.Item>
                  <List.Item>
                    <Code>{'"showIf": "<a boolean option>"'}</Code> shows an option, and sends it, only while
                    that switch is on.
                  </List.Item>
                </List>
                <Text size="sm">For example, this form lets the publisher choose a site password:</Text>
                <CodeBlock code={OPTIONS_FORM} lang="json" />
                <Text fw={600} size="sm">
                  Private videos
                </Text>
                <Text size="sm">
                  Private videos never leave Video Agent. When someone publishes a private video to a
                  destination, the dialog says that the video becomes visible to the team. Publishing then
                  makes it visible in the same step.
                </Text>
              </Stack>
            ),
          },
          {
            id: 'youtube',
            title: 'YouTube',
            children: (
              <Stack gap="sm">
                <Text size="sm">
                  People publish to their own channel. To connect a channel, go to{' '}
                  <b>API keys &gt; Connected accounts</b>. Videos upload as unlisted by default. The
                  description starts as the version&apos;s summary plus the share link, and you can edit it.
                  The CC BY credits always stay underneath. Removing a video makes it private on YouTube.
                </Text>
                <Text fw={600} size="sm">
                  Set up YouTube (admins)
                </Text>
                <Text size="sm" component="div">
                  <ol style={{ margin: 0, paddingLeft: 20 }}>
                    <li>In Google Cloud, create a project and enable the YouTube Data API v3.</li>
                    <li>
                      Create an OAuth client of type <b>Web application</b>. Set its redirect URI to{' '}
                      <Code>{`${window.location.origin}/auth/google/callback`}</Code>. The app asks for one
                      scope, <Code>youtube.force-ssl</Code>.
                    </li>
                    <li>
                      In this site&apos;s environment, set <Code>GOOGLE_CLIENT_ID</Code> and{' '}
                      <Code>GOOGLE_CLIENT_SECRET</Code>, and then redeploy.
                    </li>
                    <li>
                      On the <b>Admin</b> page, turn on YouTube.
                    </li>
                    <li>
                      Move the OAuth consent screen out of Testing. In Testing, connections stop working after
                      7 days. Before more than 100 people connect, Google must verify the app.
                    </li>
                  </ol>
                </Text>
                <Text fw={600} size="sm">
                  Quota
                </Text>
                <Text size="sm">
                  Each Google Cloud project gets 100 uploads a day, plus 10,000 units a day for everything
                  else. Captions cost 400 units and a thumbnail costs 50, so one publish uses about 450 units.
                  When the quota runs out, publishing waits for the daily reset at midnight Pacific Time, and
                  then continues on its own.
                </Text>
              </Stack>
            ),
          },
          {
            id: 'example',
            title: 'Example receiver',
            description:
              'A complete receiver with no dependencies. Video Agent’s own tests run it against the app.',
            children: <CodeBlock code={receiverSource} lang="ts" />,
          },
        ]}
      />
    </>
  )
}
