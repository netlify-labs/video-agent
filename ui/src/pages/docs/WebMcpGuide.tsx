// WebMCP (va-qago): how an AI agent in the browser drives this app's pages, the tools each page offers (from
// ui/src/webmcp/catalog.ts, kept in step with the pages by ui/e2e/webmcp.spec.ts), and how to try it in Chrome.
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
        sub="Let an AI agent in your browser use this app for you: search, fill forms, edit and play videos, with you in the loop."
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
                is a browser API (<Code>document.modelContext</Code>) that lets a web page offer tools to an
                AI agent running in the browser. The agent works in your signed-in tab, as you, through the
                same controls and requests your clicks use.
              </>
            ),
            children: (
              <Card>
                <Stack gap="xs">
                  <Text size="sm">
                    Each page offers only the tools that make sense on it, and drops them when you leave it.
                    After an agent opens another page, it asks the browser for that page&apos;s tools.
                  </Text>
                  <Text size="sm">
                    Anything that spends credits, publishes or deletes asks you in the app first, and runs
                    only if you click. Tools that return people&apos;s words (prompts, titles, comments) are
                    marked as untrusted content, so the agent treats them as data, not instructions.
                  </Text>
                  {on ? null : (
                    <Text size="sm" c="var(--va-warn, orange)">
                      An admin has turned WebMCP off here, so pages offer no tools.
                    </Text>
                  )}
                </Stack>
              </Card>
            ),
          },
          {
            id: 'tools',
            title: 'Tools',
            description: 'What an agent can do, page by page.',
            children: (
              <Card>
                <ToolTable />
              </Card>
            ),
          },
          {
            id: 'try',
            title: 'Try it in Chrome',
            description: 'WebMCP is in an origin trial from Chrome 149. To try it on your own machine:',
            children: (
              <Card>
                <List type="ordered" spacing="xs" size="sm">
                  <List.Item>
                    Open <Code>chrome://flags/#enable-webmcp-testing</Code>, set it to <b>Enabled</b>, and
                    relaunch Chrome.
                  </List.Item>
                  <List.Item>
                    Open this app and sign in. In the console,{' '}
                    <Code>await document.modelContext.getTools()</Code> lists the tools of the page
                    you&apos;re on.
                  </List.Item>
                  <List.Item>
                    Use a browser agent that supports WebMCP, or call a tool yourself:{' '}
                    <Code>
                      {`const [t] = (await document.modelContext.getTools()).filter((t) => t.name === 'get_page'); await document.modelContext.executeTool(t, {})`}
                    </Code>
                  </List.Item>
                </List>
              </Card>
            ),
          },
          {
            id: 'admin',
            title: 'Turning it off',
            description: (
              <>
                WebMCP is on by default. An admin can turn it off on the{' '}
                <Anchor component={Link} to="/admin" c="var(--va-text)" inherit>
                  Admin
                </Anchor>{' '}
                page; pages then register no tools. Browsers without WebMCP never see any.
              </>
            ),
            children: null,
          },
        ]}
      />
    </>
  )
}
