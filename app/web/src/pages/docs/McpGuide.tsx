// How to connect MCP clients, with the tools and prompts they get (from app/server/mcp-catalog.ts, kept in step with the
// server by app/test/mcp-catalog.test.ts).
import { Anchor, Card, Code, Stack, Text } from '@mantine/core'
import { Link } from 'react-router'
import { MCP_PROMPTS, MCP_TOOLS } from '../../../../server/mcp-catalog'
import { $api } from '../../api/client'
import { CopyField, PageHeader } from '../../components/bits'
import { CatalogTable, DocSections } from './DocsLayout'

const KEY = 'Bearer nva_…'

const EXAMPLES = [
  'Make a 20-second vertical video that announces our new pricing page and ends on “Try it today”. Publish it when it’s ready.',
  'Turn pull request #482 into a 30-second demo video for customers.',
  'What did people say about the onboarding video? Revise it with the open comments.',
  'Find calm, openly licensed music and use it for a 15-second cut of the launch video.',
  'Show me my videos from this week that are still waiting for a review.',
]

function Snippet({ title, children, note }: { title: string; children: string; note?: React.ReactNode }) {
  return (
    <Card>
      <Text fw={600} mb="sm">
        {title}
      </Text>
      <Code block style={{ fontSize: 13 }}>
        {children}
      </Code>
      {note ? (
        <Text size="sm" c="var(--va-muted)" mt="sm">
          {note}
        </Text>
      ) : null}
    </Card>
  )
}

export default function McpGuidePage() {
  const url = `${window.location.origin}/mcp`
  const config = $api.useQuery('get', '/api/v1/config')
  const oauth = config.data?.mcpOAuth === true
  return (
    <>
      <PageHeader
        title="MCP for AI tools"
        sub="Connect your AI tools, and then ask for videos in your own words. Your AI tool can make, follow, revise, and publish them."
      />
      <DocSections
        sections={[
          {
            id: 'tools',
            title: 'MCP tools',
            description:
              'What your AI tool can do after it connects. The server lists only the tools that your role allows. API keys and connected apps act as you.',
            children: (
              <Card>
                <CatalogTable entries={MCP_TOOLS} label="MCP tools" />
              </Card>
            ),
          },
          {
            id: 'connect',
            title: 'Connect',
            description: (
              <>
                The server is one Streamable HTTP endpoint. To sign in to it, use your{' '}
                <Anchor component={Link} to="/keys" c="var(--va-text)" inherit>
                  API key
                </Anchor>
                {oauth ? ', or Sign in with Netlify in clients that support OAuth.' : '.'}
              </>
            ),
            children: (
              <Card>
                <Stack gap="sm">
                  <CopyField label="Server URL (Streamable HTTP)" value={url} />
                  <Text size="sm" c="var(--va-muted)">
                    Send the key in the <Code>Authorization</Code> header: <Code>Authorization: {KEY}</Code>.
                    To create a key, go to the{' '}
                    <Anchor component={Link} to="/keys" c="var(--va-text)" inherit>
                      API keys
                    </Anchor>{' '}
                    page.
                  </Text>
                  {oauth ? (
                    <Text size="sm" c="var(--va-muted)">
                      To connect without a key, add only the URL, and then <b>Sign in with Netlify</b>. This
                      works in clients that support OAuth, such as Claude and ChatGPT connectors and Claude
                      Code.
                    </Text>
                  ) : null}
                </Stack>
              </Card>
            ),
          },
          {
            id: 'clients',
            title: 'Client setup',
            description: 'In each example, replace nva_… with your key.',
            children: (
              <>
                <Snippet
                  title="Claude Code"
                  note={
                    oauth
                      ? 'To sign in without a key, leave out --header, and then run /mcp in Claude Code.'
                      : undefined
                  }
                >
                  {`claude mcp add --transport http video-agent ${url} \\\n  --header "Authorization: ${KEY}"`}
                </Snippet>
                <Snippet
                  title="Claude Desktop (claude_desktop_config.json)"
                  note={
                    oauth
                      ? 'To add it as a custom connector instead, go to Settings > Connectors, enter only the URL, and then sign in.'
                      : undefined
                  }
                >
                  {JSON.stringify(
                    {
                      mcpServers: {
                        'video-agent': {
                          command: 'npx',
                          args: ['-y', 'mcp-remote', url, '--header', `Authorization: ${KEY}`],
                        },
                      },
                    },
                    null,
                    2,
                  )}
                </Snippet>
                <Snippet
                  title="Cursor, Windsurf, and other clients (mcp.json)"
                  note={
                    <>
                      If your client supports only stdio, use a bridge:{' '}
                      <Code>{`npx -y mcp-remote ${url} --header "Authorization: ${KEY}"`}</Code>
                    </>
                  }
                >
                  {JSON.stringify(
                    { mcpServers: { 'video-agent': { url, headers: { Authorization: KEY } } } },
                    null,
                    2,
                  )}
                </Snippet>
              </>
            ),
          },
          {
            id: 'prompts',
            title: 'Prompts',
            description: (
              <>
                Ready-made recipes that your AI tool gets from <Code>prompts/list</Code>. You see only the
                prompts that your role can use. Coding agents can get the same recipes as an{' '}
                <Anchor component={Link} to="/docs/skills" c="var(--va-text)" inherit>
                  agent skill
                </Anchor>
                .
              </>
            ),
            children: (
              <Card>
                <CatalogTable entries={MCP_PROMPTS} label="MCP prompts" />
              </Card>
            ),
          },
          {
            id: 'examples',
            title: 'Example requests',
            description: 'After you connect, ask in your own words. Your AI tool chooses the tools to call.',
            children: (
              <Card>
                <ul className="va-docs-examples">
                  {EXAMPLES.map((e) => (
                    <li key={e}>“{e}”</li>
                  ))}
                </ul>
              </Card>
            ),
          },
        ]}
      />
    </>
  )
}
