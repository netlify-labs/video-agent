// The video-agent CLI (netlify-video-agent; cli-and-sdk plan §8; bead va-p1th.7.2): install, sign in with this site's
// URL, every command from the catalog (packages/cli/src/catalog.ts, the same list --help prints), JSON output and exit
// codes, env vars and CI, and local mode: making a video on your own machine with your own coding agent in its sandbox.
import { Anchor, Card, Code, List, Stack, Table, Text } from '@mantine/core'
import { Link } from 'react-router'
import { COMMANDS, type CommandSpec } from '../../../../packages/cli/src/catalog'
import { EXIT, EXIT_MEANINGS } from '../../../../packages/cli/src/exit'
import { PageHeader } from '../../components/bits'
import { DocSections } from './DocsLayout'

/** The commands people can run: ready, minus help and version (which every CLI has). */
export const listedCommands = (): CommandSpec[] =>
  COMMANDS.filter((c) => c.ready && c.name !== 'help' && c.name !== 'version')

const usage = (c: CommandSpec) =>
  ['video-agent', c.name, ...c.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`))].join(' ')

function CommandTable({ commands }: { commands: CommandSpec[] }) {
  return (
    <Table>
      <Table.Tbody>
        {commands.map((c) => (
          <Table.Tr key={c.name} data-command={c.name}>
            <Table.Td style={{ whiteSpace: 'nowrap', verticalAlign: 'top' }}>
              <Code>{usage(c)}</Code>
            </Table.Td>
            <Table.Td>
              <Text size="sm">{c.summary}</Text>
              {Object.keys(c.flags).length ? (
                <Text size="xs" c="var(--va-muted)" mt={2}>
                  {Object.keys(c.flags)
                    .map((f) => `--${f}`)
                    .join(' ')}
                </Text>
              ) : null}
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  )
}

export default function CliGuidePage() {
  const site = window.location.origin
  const remote = listedCommands().filter((c) => !c.local)
  const local = listedCommands().filter((c) => c.local)
  return (
    <>
      <PageHeader
        title="CLI"
        sub={
          <>
            <Code>video-agent</Code> (npm <Code>netlify-video-agent</Code>): make, follow, download and
            publish videos from a terminal, scripts and CI, or make them on your own machine with your own
            coding agent.
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
                <Code block>{`npm install -g netlify-video-agent
video-agent --version
# or without installing:
npx -y netlify-video-agent@1 --version`}</Code>
                <Text size="sm" c="var(--va-muted)" mt="sm">
                  Node 22 or later. <Code>video-agent doctor</Code> checks your setup. Every command takes{' '}
                  <Code>--help</Code>.
                </Text>
              </Card>
            ),
          },
          {
            id: 'sign-in',
            title: 'Sign in',
            description: 'Approve the CLI in your browser; it gets an API key that acts as you.',
            children: (
              <Card>
                <Code block>{`video-agent login --url ${site}
video-agent whoami`}</Code>
                <Text size="sm" c="var(--va-muted)" mt="sm">
                  It prints a code; open {site}/cli/approve, type the code and approve. The key is saved in{' '}
                  <Code>~/.config/video-agent/config.json</Code> (only you can read it).{' '}
                  <Code>video-agent logout --revoke</Code> forgets it and revokes it. Prefer a key you made on
                  the{' '}
                  <Anchor component={Link} to="/keys" inherit>
                    API keys
                  </Anchor>{' '}
                  page? <Code>video-agent login --url {site} --key -</Code> reads it from stdin.
                </Text>
              </Card>
            ),
          },
          {
            id: 'quickstart',
            title: 'Make a video',
            children: (
              <Card>
                <Code
                  block
                >{`video-agent create "A 20-second launch video for our webhooks feature" --aspect 16:9 --wait --out ./webhooks
video-agent revise <video> "Make the end card orange" --wait
video-agent publish <video>`}</Code>
                <Text size="sm" c="var(--va-muted)" mt="sm">
                  <Code>&lt;video&gt;</Code> is an id (<Code>vid_…</Code>), its web address or a share link.{' '}
                  <Code>--wait</Code> follows the run with progress on stderr; <Code>--out</Code> downloads
                  the MP4, poster and captions.
                </Text>
              </Card>
            ),
          },
          {
            id: 'commands',
            title: 'Commands',
            description: 'The same list video-agent help prints.',
            children: (
              <Card>
                <CommandTable commands={remote} />
              </Card>
            ),
          },
          {
            id: 'output',
            title: 'JSON output and exit codes',
            description: (
              <>
                With <Code>--json</Code>, stdout is exactly one JSON object: what the command made or read, or{' '}
                <Code>{'{ "error": { "code", "message", "requestId" } }'}</Code>. Progress goes to stderr.{' '}
                <Code>--verbose</Code> logs each request as JSON lines with request ids.
              </>
            ),
            children: (
              <Card>
                <Table>
                  <Table.Tbody>
                    {Object.entries(EXIT).map(([k, code]) => (
                      <Table.Tr key={k} data-exit={code}>
                        <Table.Td>
                          <Code>{code}</Code>
                        </Table.Td>
                        <Table.Td>{EXIT_MEANINGS[k as keyof typeof EXIT]}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Card>
            ),
          },
          {
            id: 'ci',
            title: 'Scripts and CI',
            description: 'Use an API key from an environment variable; nothing is written to disk.',
            children: (
              <Card>
                <Code block>{`export VIDEO_AGENT_URL=${site}
export VIDEO_AGENT_KEY=nva_…   # a secret in your CI, from ${site}/keys
video-agent create "Release notes for v2.4" --wait --json > video.json`}</Code>
                <Text size="sm" c="var(--va-muted)" mt="sm">
                  Flags win over the environment, which wins over the saved config. Never put a key on the
                  command line: pipe it to <Code>--key -</Code>. In code, use the{' '}
                  <Anchor component={Link} to="/docs/sdk" inherit>
                    TypeScript SDK
                  </Anchor>
                  .
                </Text>
              </Card>
            ),
          },
          {
            id: 'local',
            title: 'Make videos on your laptop',
            description:
              'video-agent local makes the video on your machine with your own coding agent. No deployment, key or credits.',
            children: (
              <Stack gap="sm">
                <Card>
                  <Code block>{`video-agent doctor
video-agent local "A 20-second launch video for our webhooks feature" --aspect 16:9
video-agent local revise ./videos/webhooks-launch "Make the end card orange"`}</Code>
                  <Text size="sm" c="var(--va-muted)" mt="sm">
                    It needs Claude Code, installed and signed in (other agents follow once they pass the same
                    sandbox checks). The first run sets up its tools in <Code>~/.cache/video-agent</Code>, a
                    few minutes once. Each version lands in <Code>./videos/&lt;name&gt;/vN/</Code> with a{' '}
                    <Code>video.json</Code>. <Code>./context/</Code>, if you have one, is your brand.
                  </Text>
                </Card>
                <Card>
                  <Text fw={600} mb="xs">
                    The agent runs in its sandbox
                  </Text>
                  <List size="sm" spacing={4}>
                    <List.Item>
                      Its shell can write only in the run's own folder, and can't read your SSH, cloud, npm,
                      Netlify or agent credentials (the CLI's own key included).
                    </List.Item>
                    <List.Item>
                      It gets no API keys or tokens from your environment, and none of your own agent
                      settings, hooks, MCP servers or memory files.
                    </List.Item>
                    <List.Item>
                      It can reach only the sites a video needs: Openverse music, Google Fonts and the voice
                      model's downloads. It can't reach services on your machine; the CLI renders the video
                      outside the sandbox.
                    </List.Item>
                    <List.Item>
                      What leaves your machine: the prompt and files you give it, sent to your agent's own
                      provider, as in any session with it. Nothing goes to this deployment.
                    </List.Item>
                  </List>
                </Card>
                <Card>
                  <Table>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th />
                        <Table.Th>video-agent local</Table.Th>
                        <Table.Th>This deployment</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {[
                        ['Runs on', 'Your machine, your agent', 'Netlify Agent Runners'],
                        ['Costs', 'Your agent subscription', 'Netlify credits'],
                        ['Brand', './context/', "This site's context/"],
                        ['Sharing', 'The MP4 file', 'Share pages, embeds, publish destinations'],
                        ['Review', 'You', 'Comments and approvals for the team'],
                      ].map(([k, a, b]) => (
                        <Table.Tr key={k}>
                          <Table.Td>{k}</Table.Td>
                          <Table.Td>{a}</Table.Td>
                          <Table.Td>{b}</Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Card>
                <Card>
                  <CommandTable commands={local} />
                </Card>
              </Stack>
            ),
          },
          {
            id: 'record',
            title: 'Screen recordings',
            description: 'Record a demo on this machine and turn it into a video.',
            children: (
              <Card>
                <Text size="sm">
                  Upload a recording with <Code>video-agent media upload</Code> and pass it to{' '}
                  <Code>create</Code>, or record one in the app from New video.
                </Text>
              </Card>
            ),
          },
        ]}
      />
    </>
  )
}
