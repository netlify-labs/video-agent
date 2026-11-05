// The GitHub Action (github-action plan §9): setup with this site's URL, which server features this deployment has
// (from /api/v1/config), the example workflows (packages/action/src/examples.ts, the README's too), commands, the
// inputs and outputs (packages/action/src/spec.ts, action.yml's too), security and costs.
import { Anchor, Badge, Card, Code, Group, List, Stack, Table, Text } from '@mantine/core'
import { Link } from 'react-router'
import { EXAMPLES, FEATURE_NOTES, SHOOT_SCRIPT } from '../../../../packages/action/src/examples'
import { COMMANDS, INPUTS, OUTPUT_STATUSES, OUTPUTS } from '../../../../packages/action/src/spec'
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
        sub="A demo video for a labelled pull request or a release, posted in one comment that keeps itself up to date."
      />
      <DocSections
        sections={[
          {
            id: 'setup',
            title: 'Set it up',
            children: (
              <Card>
                <List type="ordered" spacing="sm" size="sm">
                  <List.Item>
                    Make a Video Agent account for CI (for example <Code>video-bot@acme.com</Code>, role
                    Creator), sign in as it and{' '}
                    <Anchor component={Link} to="/keys" inherit>
                      create an API key
                    </Anchor>
                    . Store the key as the secret <Code>VIDEO_AGENT_KEY</Code>.
                  </List.Item>
                  <List.Item>
                    Store this site as the variable <Code>VIDEO_AGENT_URL</Code>, at the org level so only org
                    admins can change where the key is sent. Not a secret: GitHub would hide every link the
                    action prints.
                    <CopyField value={site} label="VIDEO_AGENT_URL" />
                  </List.Item>
                  <List.Item>
                    Add a workflow from the examples below with <Code>dry-run: true</Code>: it prints the
                    brief and the calls it would make, and spends nothing. Remove it when the brief reads
                    well.
                  </List.Item>
                  <List.Item>
                    Add the <Code>video</Code> label to a pull request.
                  </List.Item>
                </List>
                <Text {...muted} mt="sm">
                  While the action's repository is private, other repositories in the org can use it only when
                  its Settings → Actions → General → Access is set to “Accessible from repositories in the
                  organization”.
                </Text>
              </Card>
            ),
          },
          {
            id: 'features',
            title: 'This deployment',
            description: 'The action asks the server what it offers and uses only that.',
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
                          {on ? null : <Text span {...muted}>{` — off here: ${f.without}`}</Text>}
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
              'Reply on the pull request. The action reacts 👀 when it starts and 👍 or 😕 when it’s done, and updates its one comment.',
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
                <Code>status</Code> is one of{' '}
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
            description: 'Strict by default; relax each on purpose.',
            children: (
              <Card>
                <List spacing="xs" size="sm">
                  <List.Item>
                    Fork PRs are off. Only people with write access to the repository start videos, run
                    commands, or have their PR description and screenshots used.
                  </List.Item>
                  <List.Item>
                    The action never runs PR code and needs no checkout. Don't combine it with a checkout of a
                    fork's head under <Code>pull_request_target</Code> or <Code>issue_comment</Code>.
                  </List.Item>
                  <List.Item>
                    The key sees everything a Creator sees. Give the CI account only CI keys: disabling it is
                    the one switch that stops all CI spend.
                  </List.Item>
                  <List.Item>
                    Publishing is off by default. A published GIF in a comment goes through GitHub's image
                    cache and stops showing within minutes of an unpublish. A release asset on a public repo
                    is a public MP4 for good, so it needs <Code>publish: true</Code>.
                  </List.Item>
                  <List.Item>
                    <Code>private: true</Code> and <Code>publish: true</Code> can't both be set.
                  </List.Item>
                  <List.Item>
                    Permissions: <Code>pull-requests: write</Code> for comments and reactions,{' '}
                    <Code>contents: write</Code> only for releases, <Code>contents: read</Code> otherwise.
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
                  A video is about 150 credits, and a revision or retry costs as much as a new one: 10 PR
                  videos a week is about 1,500 credits, plus revisions. The action stops at{' '}
                  <Code>max-versions</Code> per PR (3), <Code>max-runs-per-day</Code> for the account (10),
                  and <Code>max-credits-per-month</Code> when you set it. The comment shows each version's
                  credits.
                </Text>
              </Card>
            ),
          },
          {
            id: 'other-ci',
            title: 'Other CI systems',
            children: (
              <Card>
                <CodeBlock
                  code={`npx -y netlify-video-agent brief pr https://github.com/acme/web/pull/123 \\
  | npx -y netlify-video-agent create --prompt-file - --wait`}
                  lang="http"
                />
                <Text {...muted} mt="sm">
                  The same briefs from the CLI: <Code>brief pr</Code>, <Code>brief release</Code> and{' '}
                  <Code>brief changelog</Code>. Set <Code>GH_TOKEN</Code> for a private repository.
                </Text>
              </Card>
            ),
          },
        ]}
      />
    </>
  )
}
