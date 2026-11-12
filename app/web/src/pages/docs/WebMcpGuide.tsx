// WebMCP (va-qago): how an AI agent in the browser drives this app's pages, the tools each page offers (from
// app/web/src/webmcp/catalog.ts, kept in step with the pages by app/web/e2e/webmcp.spec.ts), and how to try it in Chrome.
import { Anchor, Card, Code, List, Stack, Text } from '@mantine/core'
import { Link } from 'react-router'
import { $api } from '../../api/client'
import { PageHeader } from '../../components/bits'
import { WEBMCP_KIND_LABELS, WEBMCP_TOOLS, type WebMcpPage } from '../../webmcp/catalog'
import { DocSections } from './DocsLayout'

const PAGES: WebMcpPage[] = ['every page', 'library', 'new video', 'video', 'editor']

function ToolTable() {
  return (
    <div className="va-table-scroll">
      <table className="va-table va-catalog" aria-label="WebMCP tools">
        <thead>
          <tr>
            <th>Name</th>
            <th>Page</th>
            <th>What it does</th>
            <th>Kind</th>
          </tr>
        </thead>
        <tbody>
          {PAGES.flatMap((p) => WEBMCP_TOOLS.filter((t) => t.page === p)).map((t) => (
            <tr key={t.name}>
              <td>
                <Code>{t.name}</Code>
              </td>
              <td style={{ color: 'var(--va-faint)', fontSize: 13 }}>{t.page}</td>
              <td style={{ color: 'var(--va-muted)' }}>{t.summary}</td>
              <td style={{ color: 'var(--va-faint)', fontSize: 13 }}>{WEBMCP_KIND_LABELS[t.kind]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function WebMcpGuidePage() {
  const config = $api.useQuery('get', '/api/v1/config')
  const on = config.data?.features.includes('webmcp') !== false
  return (
    <>
      <PageHeader
        title="WebMCP"
        sub="Let an AI agent in your browser use this app for you. It can search, fill in forms, and edit and play videos, and it asks you before it spends credits, publishes, or deletes."
      />
      <DocSections
        sections={[
          {
            id: 'what',
            title: 'What it is',
            description: (
              <>
                <Anchor
                  href="https://webmachinelearning.github.io/webmcp/"
                  target="_blank"
                  rel="noopener"
                  c="var(--va-text)"
                  inherit
                >
                  WebMCP
                </Anchor>{' '}
                is a browser API (<Code>document.modelContext</Code>). A web page uses it to offer tools to an
                AI agent that runs in the browser. The agent works in your signed-in tab, as you. It uses the
                same controls and requests that your clicks use.
              </>
            ),
            children: (
              <Card>
                <Stack gap="xs">
                  <Text size="sm">
                    Each page offers only the tools that make sense on that page, and removes them when you
                    leave. After an agent opens another page, it asks the browser for that page&apos;s tools.
                  </Text>
                  <Text size="sm">
                    Before a tool spends credits, publishes, or deletes anything, the app asks you. The tool
                    runs only if you confirm.
                  </Text>
                  <Text size="sm">
                    Some tools return text that people wrote, such as prompts, titles, and comments. That text
                    is marked as untrusted content, so the agent treats it as data and not as instructions.
                  </Text>
                  {on ? null : (
                    <Text size="sm" c="var(--va-warn, orange)">
                      An admin turned off WebMCP for this deployment, so pages offer no tools.
                    </Text>
                  )}
                </Stack>
              </Card>
            ),
          },
          {
            id: 'tools',
            title: 'Tools',
            description: 'What an agent can do on each page.',
            children: (
              <Card>
                <ToolTable />
              </Card>
            ),
          },
          {
            id: 'try',
            title: 'Try it in Chrome',
            description:
              'WebMCP is in an origin trial that starts with Chrome 149. To try it on your own computer, follow these steps:',
            children: (
              <Card>
                <List type="ordered" spacing="xs" size="sm">
                  <List.Item>
                    In Chrome, go to <Code>chrome://flags/#enable-webmcp-testing</Code>, set the flag to{' '}
                    <b>Enabled</b>, and then relaunch Chrome.
                  </List.Item>
                  <List.Item>Open this app and sign in.</List.Item>
                  <List.Item>
                    To list the tools of the current page, open the console and run{' '}
                    <Code>await document.modelContext.getTools()</Code>.
                  </List.Item>
                  <List.Item>
                    Use a browser agent that supports WebMCP. To call a tool yourself instead, run the
                    following in the console:
                    <Code block mt={6} style={{ fontSize: 13 }}>
                      {`const tools = await document.modelContext.getTools()
const tool = tools.find((t) => t.name === 'get_page')
await document.modelContext.executeTool(tool, {})`}
                    </Code>
                  </List.Item>
                </List>
              </Card>
            ),
          },
          {
            id: 'admin',
            title: 'Turn off WebMCP',
            description: (
              <>
                WebMCP is on by default. An admin can turn it off on the{' '}
                <Anchor component={Link} to="/admin" c="var(--va-text)" inherit>
                  Admin
                </Anchor>{' '}
                page. Pages then offer no tools. A browser without WebMCP never sees any tools.
              </>
            ),
            children: null,
          },
        ]}
      />
    </>
  )
}
