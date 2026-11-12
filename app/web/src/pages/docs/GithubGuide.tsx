// The GitHub Action (github-action plan §9): setup with this site's URL, which server features this deployment has
// (from /api/v1/config), the example workflows (packages/action/src/examples.ts, the README's too), commands, the
// inputs and outputs (packages/action/src/spec.ts, action.yml's too), security and costs.
import { Anchor, Badge, Card, Code, Group, List, Stack, Table, Text } from '@mantine/core'
import { Link } from 'react-router'
import { EXAMPLES, FEATURE_NOTES, SHOOT_SCRIPT } from '../../../../../packages/action/src/examples'
import { COMMANDS, INPUTS, OUTPUT_STATUSES, OUTPUTS } from '../../../../../packages/action/src/spec'
import { $api } from '../../api/client'
import { CopyField, PageHeader } from '../../components/bits'
import { CodeBlock } from '../../components/CodeBlock'
import { DocSections } from './DocsLayout'

const muted = { size: 'sm', c: 'var(--va-muted)' } as const

function Spec({
  rows,
  label,
}: {
  rows: readonly { name: string; description: string; default?: string }[]
  label: string
}) {
  return (
    <Table aria-label={label}>
      <Table.Tbody>
        {rows.map((r) => (
          <Table.Tr key={r.name}>
            <Table.Td style={{ whiteSpace: 'nowrap', verticalAlign: 'top' }}>
              <Code>{r.name}</Code>
            </Table.Td>
            <Table.Td>
              <Text size="sm">{r.description}</Text>
              {r.default !== undefined && r.default !== '' ? (
                <Text {...muted}>
                  Default: <Code>{r.default}</Code>
                </Text>
              ) : null}
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  )
}

export default function GithubGuidePage() {
  const site = window.location.origin
  const config = $api.useQuery('get', '/api/v1/config')
  const features = config.data?.features ?? []
  return (
    <>
      <PageHeader
        title="GitHub Action"
        sub="Get a demo video for a labeled pull request or a release. The action posts the video in one comment, and keeps that comment up to date."
      />
      <DocSections
        sections={[
          {
            id: 'setup',
            title: 'Set up the action',
            children: (
              <Card>
                <List type="ordered" spacing="sm" size="sm">
                  <List.Item>
                    Create a Video Agent account for CI, for example <Code>video-bot@acme.com</Code>, with the
                    Creator role.
                  </List.Item>
                  <List.Item>
                    Sign in as that account and{' '}
                    <Anchor component={Link} to="/keys" inherit>
                      create an API key
                    </Anchor>
                    . In GitHub, store the key as a secret named <Code>VIDEO_AGENT_KEY</Code>.
                  </List.Item>
                  <List.Item>
                    Store this site&apos;s URL as a variable named <Code>VIDEO_AGENT_URL</Code>. Set it at the
                    organization level, so that only organization admins can change where the key is sent. Use
                    a variable and not a secret. GitHub hides secret values in logs, which would hide every
                    link that the action prints.
                    <CopyField value={site} label="VIDEO_AGENT_URL" />
                  </List.Item>
                  <List.Item>
                    Add a workflow from the examples on this page, and set <Code>dry-run: true</Code>. A dry
                    run prints the brief and the calls that the action would make, and spends no credits. When
                    the brief reads well, remove <Code>dry-run</Code>.
                  </List.Item>
                  <List.Item>
                    Add the <Code>video</Code> label to a pull request.
                  </List.Item>
                </List>
                <Text {...muted} mt="sm">
                  If the action&apos;s repository is private, other repositories in the organization can use
                  it only after you allow that. In the action&apos;s repository, go to{' '}
                  <b>Settings &gt; Actions &gt; General &gt; Access</b> and select{' '}
                  <b>Accessible from repositories in the organization</b>.
                </Text>
              </Card>
            ),
          },
          {
            id: 'features',
            title: 'This deployment',
            description: 'The action asks the server which features it has, and uses only those.',
            children: (
              <Card>
                <Stack gap="xs" aria-label="Server features">
                  {FEATURE_NOTES.map((f) => {
                    const on = features.includes(f.feature as never)
                    return (
                      <Group
                        key={f.feature}
                        gap="sm"
                        wrap="nowrap"
                        align="flex-start"
                        data-feature={f.feature}
                      >
                        <Badge variant="light" color={on ? 'green' : 'gray'} style={{ flexShrink: 0 }}>
                          {on ? 'On' : 'Off'}
                        </Badge>
                        <Text size="sm">
                          {f.label}
                          {on ? null : <Text span {...muted}>{` (off here: ${f.without})`}</Text>}
                        </Text>
                      </Group>
                    )
                  })}
                </Stack>
              </Card>
            ),
          },
          ...EXAMPLES.map((e) => ({
            id: e.id,
            title: e.title,
            description: e.note,
            children: (
              <Card>
                <CodeBlock code={e.yaml} lang="http" />
                {e.id === 'screenshots' ? (
                  <>
                    <Text {...muted} my="sm">
                      <Code>.github/scripts/shoot.mjs</Code>:
                    </Text>
                    <CodeBlock code={SHOOT_SCRIPT} lang="js" />
                  </>
                ) : null}
              </Card>
            ),
          })),
          {
            id: 'commands',
            title: 'Commands',
            description:
              'To run a command, reply on the pull request with it. The action reacts with 👀 when it starts, and with 👍 or 😕 when it finishes. It then updates its comment.',
            children: (
              <Card>
                <Stack gap={4}>
                  {COMMANDS.map((c) => (
                    <Code key={c}>{c}</Code>
                  ))}
                </Stack>
              </Card>
            ),
          },
          {
            id: 'inputs',
            title: 'Inputs',
            children: (
              <Card>
                <Spec rows={INPUTS} label="Inputs" />
              </Card>
            ),
          },
          {
            id: 'outputs',
            title: 'Outputs',
            description: (
              <>
                The <Code>status</Code> output is one of the following:{' '}
                {OUTPUT_STATUSES.map((s, i) => (
                  <span key={s}>
                    {i ? ', ' : ''}
                    <Code>{s}</Code>
                  </span>
                ))}
                .
              </>
            ),
            children: (
              <Card>
                <Spec rows={OUTPUTS} label="Outputs" />
              </Card>
            ),
          },
          {
            id: 'security',
            title: 'Security',
            description: 'The defaults are strict. Relax a setting only when you mean to.',
            children: (
              <Card>
                <List spacing="xs" size="sm">
                  <List.Item>
                    Pull requests from forks are off. Only people with write access to the repository can
                    start videos or run commands. The action uses a pull request&apos;s description and
                    screenshots only when its author has write access.
                  </List.Item>
                  <List.Item>
                    The action never runs code from a pull request, and it needs no checkout. Don&apos;t
                    combine it with a checkout of a fork&apos;s head under <Code>pull_request_target</Code> or{' '}
                    <Code>issue_comment</Code>.
                  </List.Item>
                  <List.Item>
                    The key can see everything that a Creator can see. Use the CI account only for CI keys.
                    Then, to stop all CI spending at once, turn off that account.
                  </List.Item>
                  <List.Item>
                    Publishing is off by default. A published GIF in a comment goes through GitHub&apos;s
                    image cache, and it stops showing within minutes after you unpublish. A release asset on a
                    public repository is a public MP4 permanently, so it requires <Code>publish: true</Code>.
                  </List.Item>
                  <List.Item>
                    You can&apos;t set both <Code>private: true</Code> and <Code>publish: true</Code>.
                  </List.Item>
                  <List.Item>
                    The action needs the <Code>pull-requests: write</Code> permission for comments and
                    reactions. It needs <Code>contents: write</Code> only for releases, and{' '}
                    <Code>contents: read</Code> otherwise.
                  </List.Item>
                </List>
              </Card>
            ),
          },
          {
            id: 'costs',
            title: 'Costs',
            children: (
              <Card>
                <Text size="sm">
                  A video costs about 150 credits. A revision or a retry costs as much as a new video. For
                  example, 10 pull request videos a week cost about 1,500 credits, plus revisions.
                </Text>
                <Text size="sm" mt="xs">
                  The action stops at these limits: <Code>max-versions</Code> for each pull request (3 by
                  default), <Code>max-runs-per-day</Code> for the account (10 by default), and{' '}
                  <Code>max-credits-per-month</Code> if you set it. The comment shows the credits that each
                  version used.
                </Text>
              </Card>
            ),
          },
          {
            id: 'other-ci',
            title: 'Other CI systems',
            children: (
              <Card>
                <Text {...muted} mb="sm">
                  On other CI systems, use the CLI. It makes the same briefs with <Code>brief pr</Code>,{' '}
                  <Code>brief release</Code>, and <Code>brief changelog</Code>. For a private repository, set{' '}
                  <Code>GH_TOKEN</Code>.
                </Text>
                <CodeBlock
                  code={`npx -y netlify-video-agent brief pr https://github.com/acme/web/pull/123 \\
  | npx -y netlify-video-agent create --prompt-file - --wait`}
                  lang="http"
                />
              </Card>
            ),
          },
        ]}
      />
    </>
  )
}
