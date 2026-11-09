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
  'Make a 20-second vertical video announcing our new pricing page, ending on “Try it today”, then publish it when it’s ready.',
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
        sub="Connect your AI tools to make, follow, revise and publish videos by asking for them."
      />
      <DocSections
        sections={[
          {
            id: 'tools',
            title: 'MCP tools',
            description:
              'What your AI tool can do here. The server lists only the tools your role allows; keys and connected apps act as you.',
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
                One Streamable HTTP endpoint. It uses your{' '}
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
                    Send the key as <Code>Authorization: {KEY}</Code>. Create one on the{' '}
                    <Anchor component={Link} to="/keys" c="var(--va-text)" inherit>
                      API keys
                    </Anchor>{' '}
                    page.
                  </Text>
                  {oauth ? (
                    <Text size="sm" c="var(--va-muted)">
                      Or connect without a key: clients that support OAuth (Claude and ChatGPT connectors,
                      Claude Code) can add the URL alone and <b>Sign in with Netlify</b>.
                    </Text>
                  ) : null}
                </Stack>
              </Card>
            ),
          },
          {
            id: 'clients',
            title: 'Client setup',
            description: 'Replace nva_… with your key.',
            children: (
              <>
                <Snippet
                  title="Claude Code"
                  note={oauth ? 'Or leave out --header and run /mcp in Claude Code to sign in.' : undefined}
                >
                  {`claude mcp add --transport http video-agent ${url} \\\n  --header "Authorization: ${KEY}"`}
                </Snippet>
                <Snippet
                  title="Claude Desktop (claude_desktop_config.json)"
                  note={
                    oauth
                      ? 'Or add it as a custom connector under Settings → Connectors with the URL alone, and sign in.'
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
                  title="Cursor, Windsurf and other clients (mcp.json)"
                  note={
                    <>
                      Clients that only speak stdio can use a bridge:{' '}
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
                Ready-made recipes from <Code>prompts/list</Code>, limited to what your role can do. Coding
                agents can get the same recipes as an{' '}
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
            title: 'Example asks',
            description: 'Once connected, ask in your own words. The tools take it from there.',
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
