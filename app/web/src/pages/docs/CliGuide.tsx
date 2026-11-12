// The video-agent CLI (netlify-video-agent; cli-and-sdk plan §8; bead va-p1th.7.2): install, sign in with this site's
// URL, every command from the catalog (packages/cli/src/catalog.ts, the same list --help prints), JSON output and exit
// codes, env vars and CI, and local mode: making a video on your own machine with your own coding agent in its sandbox.
import { Anchor, Card, Code, List, Stack, Table, Text } from '@mantine/core'
import { Link } from 'react-router'
import { COMMANDS, type CommandSpec } from '../../../../../packages/cli/src/catalog'
import { EXIT, EXIT_MEANINGS } from '../../../../../packages/cli/src/exit'
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
            <Code>video-agent</Code> is the command-line tool (npm package <Code>netlify-video-agent</Code>).
            Use it to make, follow, download, and publish videos from a terminal, a script, or CI. It can also
            make videos on your own computer with your own coding agent.
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
                  The CLI needs Node 22 or later. To check your setup, run <Code>video-agent doctor</Code>.
                  For help with any command, add <Code>--help</Code>.
                </Text>
              </Card>
            ),
          },
          {
            id: 'sign-in',
            title: 'Sign in',
            description: 'Approve the CLI in your browser. The CLI then gets an API key that acts as you.',
            children: (
              <Card>
                <Code block>{`video-agent login --url ${site}
video-agent whoami`}</Code>
                <Text size="sm" c="var(--va-muted)" mt="sm">
                  The <Code>login</Code> command prints a code. Open {site}/cli/approve, enter the code, and
                  approve it. The CLI saves the key in <Code>~/.config/video-agent/config.json</Code>, which
                  only you can read. To forget the key and revoke it, run{' '}
                  <Code>video-agent logout --revoke</Code>.
                </Text>
                <Text size="sm" c="var(--va-muted)" mt="xs">
                  To use a key from the{' '}
                  <Anchor component={Link} to="/keys" inherit>
                    API keys
                  </Anchor>{' '}
                  page instead, run <Code>video-agent login --url {site} --key -</Code>. This reads the key
                  from stdin.
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
                  <Code>&lt;video&gt;</Code> is a video ID (<Code>vid_…</Code>), the video&apos;s web address,
                  or a share link. The <Code>--wait</Code> flag follows the run and prints progress to stderr.
                  The <Code>--out</Code> flag downloads the MP4, the poster, and the captions.
                </Text>
              </Card>
            ),
          },
          {
            id: 'commands',
            title: 'Commands',
            description: 'The same list that video-agent help prints.',
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
                With <Code>--json</Code>, stdout is exactly one JSON object. The object is what the command
                made or read, or an error: <Code>{'{ "error": { "code", "message", "requestId" } }'}</Code>.
                Progress goes to stderr. With <Code>--verbose</Code>, the CLI logs each request as JSON lines
                that include request IDs. The following table lists the exit codes.
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
            description:
              'In scripts and CI, pass the API key in an environment variable. The CLI then writes nothing to disk.',
            children: (
              <Card>
                <Code block>{`export VIDEO_AGENT_URL=${site}
export VIDEO_AGENT_KEY=nva_…   # a secret in your CI, from ${site}/keys
video-agent create "Release notes for v2.4" --wait --json > video.json`}</Code>
                <Text size="sm" c="var(--va-muted)" mt="sm">
                  Flags override environment variables, and environment variables override the saved config.
                  Never put a key on the command line. Pipe it to <Code>--key -</Code> instead. In code, use
                  the{' '}
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
            title: 'Make videos on your own computer',
            description:
              'video-agent local makes the video on your computer with your own coding agent. You need no deployment, no key, and no credits.',
            children: (
              <Stack gap="sm">
                <Card>
                  <Code block>{`video-agent doctor
video-agent local "A 20-second launch video for our webhooks feature" --aspect 16:9
video-agent local revise ./videos/webhooks-launch "Make the end card orange"`}</Code>
                  <Text size="sm" c="var(--va-muted)" mt="sm">
                    Local mode needs Claude Code, installed and signed in. Support for other agents comes
                    after they pass the same sandbox checks. The first run sets up its tools in{' '}
                    <Code>~/.cache/video-agent</Code>. This takes a few minutes, one time.
                  </Text>
                  <Text size="sm" c="var(--va-muted)" mt="xs">
                    Each version is saved in <Code>./videos/&lt;name&gt;/vN/</Code> with a{' '}
                    <Code>video.json</Code> file. If you have a <Code>./context/</Code> folder, the agent uses
                    it as your brand.
                  </Text>
                </Card>
                <Card>
                  <Text fw={600} mb="xs">
                    The agent runs in its sandbox
                  </Text>
                  <List size="sm" spacing={4}>
                    <List.Item>
                      Its shell can write only in the run&apos;s own folder. It can&apos;t read your SSH,
                      cloud, npm, Netlify, or agent credentials, including the CLI&apos;s own key.
                    </List.Item>
                    <List.Item>
                      It gets no API keys or tokens from your environment. It also gets none of your own agent
                      settings, hooks, MCP servers, or memory files.
                    </List.Item>
                    <List.Item>
                      It can reach only the sites that a video needs: Openverse for music, Google Fonts, and
                      the voice model&apos;s downloads. It can&apos;t reach services on your computer. The CLI
                      renders the video outside the sandbox.
                    </List.Item>
                    <List.Item>
                      The CLI renders the video with your Chrome. The page that it renders can&apos;t reach
                      your computer or your network either. The CLI blocks and logs requests to localhost,
                      private and link-local addresses, and <Code>.local</Code> names. The only exception is
                      the render&apos;s own asset server.
                    </List.Item>
                    <List.Item>
                      The prompt and the files that you give the agent do leave your computer. They go to your
                      agent&apos;s own provider, as in any session with that agent. Nothing goes to this
                      deployment.
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
                        ['Runs on', 'Your computer, your agent', 'Netlify Agent Runners'],
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
            description: 'Record a demo on your computer, and turn it into a video.',
            children: (
              <Card>
                <Stack gap="sm">
                  <Text fw={600} size="sm">
                    Record
                  </Text>
                  <Text size="sm">
                    Run <Code>video-agent record https://app.example.com --out ./take1</Code>. Chromium opens
                    on the page. Press <Code>r</Code> to start, use the app, and then press <Code>s</Code> to
                    stop.
                  </Text>
                  <Text size="sm">
                    The command writes two files. The <Code>recording.mp4</Code> file is ready to upload as it
                    is. The <Code>trace.json</Code> file is a pointer trace. It holds the exact clicks, and
                    the role and name of each clicked element, so the demo gets a smooth cursor and zooms to
                    the right place. The trace counts your typing, and never records what you type. The
                    recording is at 2x by default, so zooms stay sharp.
                  </Text>
                  <Text size="sm">
                    Recording needs ffmpeg and Playwright&apos;s Chromium. To install Chromium, run{' '}
                    <Code>npm i -g playwright &amp;&amp; npx playwright install chromium</Code>.
                  </Text>
                  <Text fw={600} size="sm">
                    Hide private details
                  </Text>
                  <List size="sm" spacing={4}>
                    <List.Item>Password fields are always hidden.</List.Item>
                    <List.Item>
                      <Code>--hide &quot;.selector&quot;</Code> hides the elements that match a CSS selector.
                    </List.Item>
                    <List.Item>
                      <Code>--hide-text &quot;Acme Labs&quot;</Code> hides that text wherever it appears.
                    </List.Item>
                    <List.Item>
                      <Code>--privacy</Code> finds emails, keys, tokens, URLs with IDs, card numbers, and
                      phone numbers in the page, and hides each one.
                    </List.Item>
                  </List>
                  <Text size="sm">
                    The trace stores the hidden boxes, which follow the text as the page scrolls. It never
                    stores the text itself. To record a scripted tour, add{' '}
                    <Code>--script tour.mjs --headless</Code>.
                  </Text>
                  <Text fw={600} size="sm">
                    Make the demo
                  </Text>
                  <Text size="sm">
                    Run <Code>video-agent create &quot;Adding a webhook&quot; --recording ./take1</Code>. This
                    uploads the folder with its trace. The <Code>--trim</Code>, <Code>--privacy</Code>,{' '}
                    <Code>--hide-text</Code>, and <Code>--quick</Code> flags work as they do on the API. To
                    record and make the demo in one step, run{' '}
                    <Code>video-agent record &lt;url&gt; --make &quot;Adding a webhook&quot;</Code>.
                  </Text>
                  <Text size="sm">
                    To make the demo without a server, run <Code>video-agent local demo ./take1</Code>, which
                    uses your coding agent. Add <Code>--quick</Code> to use no agent and no model. You can
                    also record in the app, on the <b>New video</b> page.
                  </Text>
                </Stack>
              </Card>
            ),
          },
        ]}
      />
    </>
  )
}
