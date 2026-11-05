// /docs/destinations: the HTTP destination contract v1, normative (docs/plans/2026-11-04-publish-destinations.md §3).
// A third party must be able to build a receiver from this page alone. The signature vectors are checked by a test
// against the server's signer; the example receiver is the one the tests run against the app.
import { Card, Code, Stack, Table, Text } from '@mantine/core'
import receiverSource from '../../../../examples/destination-receiver/receiver.ts?raw'
import { CopyField, PageHeader } from '../../components/bits'
import { DESTINATION_VECTORS } from '../../lib/destination-vectors'
import { DocSections } from './DocsLayout'

const pre = (s: string) => (
  <Code block style={{ whiteSpace: 'pre', overflowX: 'auto' }}>
    {s}
  </Code>
)

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
  "externalId": "…",                       // what you returned, or null: then key on "publication"
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
  ['publish', '200 {"status":"live","url"?,"externalId"?,"warnings"?}', 'Done now.'],
  [
    'publish',
    '202 {"status":"accepted","externalId"?,"message"?}',
    'Working on it; call back when done. "message" shows meanwhile.',
  ],
  ['remove', '200 {"status":"removed"}, 204, or 404', 'Removed (404: already gone).'],
  ['remove', '202 {"status":"accepted","message"?}', 'Removing; call back when done.'],
  ['targets', '200 {"targets":[Target…]}', 'Your targets for this publisher (at most 100).'],
  ['ping', '200 {"capabilities"?}', 'Reachable; what you support.'],
  [
    'any',
    '408, 429, 5xx, timeout, network error',
    'Retried with backoff; Retry-After honoured up to an hour.',
  ],
  [
    'any',
    '3xx, other 4xx, or a 2xx that doesn’t match',
    'Failed. error.message from your body (≤ 300 chars) is shown as plain text.',
  ],
]

export default function DestinationsGuidePage() {
  const v = DESTINATION_VECTORS[0]
  return (
    <>
      <PageHeader
        title="Publish destinations"
        sub="Publish a ready version somewhere besides the share page: YouTube, or any HTTPS endpoint that speaks this contract. An admin adds HTTP destinations under Admin → Destinations."
      />
      <DocSections
        sections={[
          {
            id: 'overview',
            title: 'How it works',
            children: (
              <Text size="sm">
                When someone publishes a version to your destination, Video Agent sends your URL a signed JSON
                request with a minimal description of the version and signed links to its files. You answer
                now (live) or accept and call back later. Retries reuse the same <Code>operation</Code> id, so
                you can de-duplicate. Removing works the same way. Private videos are never sent.
              </Text>
            ),
          },
          {
            id: 'requests',
            title: 'Requests',
            children: (
              <Stack gap="sm">
                <Text size="sm">
                  <Code>POST</Code> to your URL, <Code>content-type: application/json; charset=utf-8</Code>,
                  with headers <Code>x-video-agent-signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</Code>,{' '}
                  <Code>x-video-agent-event: publish | remove | targets | ping</Code> and, on publish and
                  remove, <Code>x-video-agent-delivery: &lt;operation id&gt;</Code>. Every body has{' '}
                  <Code>contract: 1</Code>, <Code>event</Code>, <Code>sentAt</Code>, <Code>destination</Code>{' '}
                  and <Code>publisher</Code> (its id; name and email only when the admin turned that on:
                  they're contact details, never an authorization key).
                </Text>
                <Text size="sm">
                  Transport: https only, no credentials in the URL, public addresses only, no redirects
                  followed, 30 s overall (5 s for targets), your answer read up to 64 KB.
                </Text>
                <Text fw={600} size="sm">
                  publish
                </Text>
                {pre(PUBLISH)}
                <Text fw={600} size="sm">
                  remove
                </Text>
                {pre(REMOVE)}
                <Text size="sm">
                  <Code>targets</Code> sends the envelope plus <Code>video: {'{ id, title }'}</Code>;{' '}
                  <Code>ping</Code> sends the envelope only (publisher null). File links are signed for 10
                  minutes; ask for fresh ones (below) if you need longer.
                </Text>
              </Stack>
            ),
          },
          {
            id: 'verify',
            title: 'Verifying requests',
            children: (
              <Stack gap="sm">
                <Text size="sm">
                  <Code>v1 = hex(HMAC-SHA256(secret, "&lt;t&gt;." + raw body bytes))</Code>. Recompute it over
                  the exact bytes you received, compare in constant time, and refuse{' '}
                  <Code>|now − t| &gt; 300</Code>.
                </Text>
                {pre(VERIFY)}
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
                {pre(CALLBACK)}
                <Text size="sm">
                  Statuses: for a publish operation <Code>working</Code>, <Code>live</Code>,{' '}
                  <Code>failed</Code>; for a remove operation <Code>working</Code>, <Code>removed</Code>,{' '}
                  <Code>failed</Code>. <Code>working</Code> only updates the message. A callback may arrive
                  before your 202 does. Answers: <Code>204</Code> applied or a duplicate; <Code>401</Code> bad
                  or expired token; <Code>404</Code> unknown; <Code>409</Code> status not allowed;{' '}
                  <Code>410</Code> removed. A callback for an older operation is acknowledged and ignored. The
                  token expires at the operation's deadline (24 hours for a publish, 7 days for a removal) and
                  stops working once a newer operation starts.
                </Text>
                <Text size="sm">
                  Fresh links: <Code>POST {'{callback.url}'}/files</Code> with the same token and{' '}
                  <Code>{'{ "operation": "…" }'}</Code> returns the files with new signed links, while that
                  publish is active.
                </Text>
                <Text size="sm">
                  One-time secrets: <Code>secretOnce</Code> (for example a site password) is kept encrypted
                  and shown to the publisher once, then erased (or after 24 hours). Send it once per
                  publication.
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
                  A target is anything you already hold for this person: a site, a playlist, a page. It's
                  generic: <Code>{'{ id, name, description, url, metadata }'}</Code> (id and name ≤ 200
                  characters, description ≤ 500, url https, metadata flat with at most 20 keys and 2 KB).
                  Video Agent shows name, description and url and sends the chosen target back exactly as
                  listed. It came back through a browser: <b>authorize it yourself</b> by looking up its id
                  for this destination and publisher; never trust metadata for that.
                </Text>
                <Text size="sm">
                  Answer <Code>ping</Code> with{' '}
                  <Code>
                    {
                      '{ "capabilities": { "targets": true, "targetNoun": "site", "instructions": true, "instructionsLabel": "…", "instructionsHint": "…" } }'
                    }
                  </Code>{' '}
                  to get the target picker ("New site / Your sites") and an instructions box worded your way.
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
                  People publish to their own channel after connecting it under API keys → Connected accounts.
                  Videos upload unlisted by default; the description is the version's summary plus the share
                  link, editable, with the CC BY credits always kept underneath. Removing a video makes it
                  private on YouTube.
                </Text>
                <Text fw={600} size="sm">
                  Setting it up (admins)
                </Text>
                <Text size="sm" component="div">
                  <ol style={{ margin: 0, paddingLeft: 20 }}>
                    <li>In Google Cloud, create a project and enable the YouTube Data API v3.</li>
                    <li>
                      Create an OAuth client of type Web application with the redirect URI{' '}
                      <Code>{`${window.location.origin}/auth/google/callback`}</Code>. The app asks for one
                      scope, <Code>youtube.force-ssl</Code>.
                    </li>
                    <li>
                      Set <Code>GOOGLE_CLIENT_ID</Code> and <Code>GOOGLE_CLIENT_SECRET</Code> in this site's
                      environment and redeploy, then turn YouTube on under Admin.
                    </li>
                    <li>
                      Move the OAuth consent screen out of Testing: in Testing, connections stop working after
                      7 days. Google's app verification is needed before more than 100 people connect.
                    </li>
                  </ol>
                </Text>
                <Text size="sm">
                  Quota: each project gets 100 uploads a day plus 10,000 units for everything else (captions
                  cost 400, a thumbnail 50); one publish uses about 450 units. When the quota runs out,
                  publishing waits for the daily reset (midnight Pacific) and continues on its own.
                </Text>
              </Stack>
            ),
          },
          {
            id: 'example',
            title: 'Example receiver',
            description: 'Complete and dependency-free; Video Agent’s own tests run it against the app.',
            children: pre(receiverSource),
          },
        ]}
      />
    </>
  )
}
