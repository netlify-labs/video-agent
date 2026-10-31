// API docs inside the app: the REST reference (Scalar, from the live OpenAPI spec) and how to connect MCP clients.
import '@scalar/api-reference-react/style.css'
import { Anchor, Card, Code, Stack, Tabs, Text, Title, useComputedColorScheme } from '@mantine/core'
import { ApiReferenceReact } from '@scalar/api-reference-react'
import { Link, useSearchParams } from 'react-router'
import { CopyField } from '../components/bits'

const TOOLS: [string, string][] = [
  [
    'create_video',
    'Start a new video from a prompt (aspect and target length optional). Returns at once; ready in 3 to 8 minutes.',
  ],
  [
    'get_video',
    'Status, versions, signed download URLs (1 hour) and public links. Can wait up to 8 seconds for a change.',
  ],
  ['list_videos', 'Find videos by words in their prompt or title, yours or everyone’s.'],
  ['revise_video', 'Make the next version, changing only what you describe.'],
  ['publish_video', 'Public share page, MP4, GIF and embed snippet for a ready version.'],
  ['unpublish_video', 'Take a public link down.'],
  ['cancel_video', 'Stop the version in progress.'],
  ['set_verdict', 'Approve a version or request changes (not on your own version).'],
]

// Scalar themed with the app's role tokens (--va-*), which already switch between light and dark,
// so the reference matches whichever theme is on.
const SCALAR_CSS = `
.va-docs .scalar-app,
.va-docs .light-mode,
.va-docs .dark-mode,
.va-docs.light-mode,
.va-docs.dark-mode {
  --scalar-font: "IBM Plex Sans", system-ui, sans-serif;
  --scalar-font-code: "IBM Plex Mono", ui-monospace, monospace;
  --scalar-radius: 8px;
  --scalar-radius-lg: 12px;
  --scalar-radius-xl: 16px;
  --scalar-background-1: var(--va-ground);
  --scalar-background-2: var(--va-surface);
  --scalar-background-3: var(--va-raised);
  --scalar-background-accent: color-mix(in srgb, var(--va-accent) 14%, transparent);
  --scalar-border-color: var(--va-rule);
  --scalar-color-1: var(--va-text);
  --scalar-color-2: var(--va-muted);
  --scalar-color-3: var(--va-faint);
  --scalar-color-accent: var(--va-text);
  --scalar-color-green: var(--va-accent);
  --scalar-link-color: var(--va-text);
  --scalar-button-1: var(--va-primary-bg);
  --scalar-button-1-color: var(--va-primary-ink);
  --scalar-button-1-hover: var(--va-primary-bg);
  --scalar-sidebar-background-1: var(--va-ground);
  --scalar-sidebar-border-color: var(--va-rule);
  --scalar-sidebar-color-1: var(--va-text);
  --scalar-sidebar-color-2: var(--va-muted);
  --scalar-sidebar-color-active: var(--va-text);
  --scalar-sidebar-item-hover-background: var(--va-surface);
  --scalar-sidebar-item-active-background: var(--va-raised);
  --scalar-sidebar-search-background: var(--va-surface);
  --scalar-sidebar-search-border-color: var(--va-rule);
  --scalar-sidebar-search-color: var(--va-muted);
}
.va-docs .scalar-app { background: var(--va-ground); }
`

function McpGuide() {
  const origin = window.location.origin
  const url = `${origin}/mcp`
  return (
    <Stack gap="md" maw={880}>
      <Text c="var(--va-muted)">
        Connect your AI tools to make, follow, revise and publish videos by asking for them. The MCP server
        uses your{' '}
        <Anchor component={Link} to="/keys" c="var(--va-text)">
          API key
        </Anchor>
        : it acts as you, with your role.
      </Text>
      <Card>
        <Stack gap="sm">
          <CopyField label="Server URL (Streamable HTTP)" value={url} />
          <Text size="sm" c="var(--va-muted)">
            Send the key as <Code>Authorization: Bearer nva_…</Code>. Create one on the API keys page.
          </Text>
        </Stack>
      </Card>
      <Card>
        <Text fw={600} mb="sm">
          Claude Code
        </Text>
        <Code block style={{ fontSize: 13 }}>
          {`claude mcp add --transport http video-agent ${url} \\\n  --header "Authorization: Bearer nva_…"`}
        </Code>
      </Card>
      <Card>
        <Text fw={600} mb="sm">
          Cursor, Windsurf and other clients (mcp.json)
        </Text>
        <Code block style={{ fontSize: 13 }}>
          {JSON.stringify(
            { mcpServers: { 'video-agent': { url, headers: { Authorization: 'Bearer nva_…' } } } },
            null,
            2,
          )}
        </Code>
        <Text size="sm" c="var(--va-muted)" mt="sm">
          Clients that only speak stdio can use a bridge:{' '}
          <Code>{`npx -y mcp-remote ${url} --header "Authorization: Bearer nva_…"`}</Code>
        </Text>
      </Card>
      <Card>
        <Text fw={600} mb="sm">
          Tools
        </Text>
        <table className="va-table">
          <tbody>
            {TOOLS.map(([name, what]) => (
              <tr key={name}>
                <td style={{ width: 180 }}>
                  <Code>{name}</Code>
                </td>
                <td style={{ color: 'var(--va-muted)' }}>{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Text size="sm" c="var(--va-muted)" mt="md">
          Try asking: “Make a 20-second vertical video announcing our new pricing page, ending on ‘Try it
          today’, then publish it when it’s ready.”
        </Text>
      </Card>
    </Stack>
  )
}

export default function DocsPage() {
  const [params, setParams] = useSearchParams()
  const scheme = useComputedColorScheme('dark')
  const tab = params.get('tab') === 'mcp' ? 'mcp' : 'rest'
  return (
    <>
      <div className="va-title-row">
        <div>
          <Title order={1}>API docs</Title>
          <div className="va-sub">
            Everything the web app does is in the API, and the main video tasks are MCP tools for AI clients.
          </div>
        </div>
      </div>
      <Tabs
        value={tab}
        onChange={(v) => {
          setParams(v === 'mcp' ? { tab: 'mcp' } : {}, { replace: true })
        }}
        mb="lg"
      >
        <Tabs.List>
          <Tabs.Tab value="rest">REST API</Tabs.Tab>
          <Tabs.Tab value="mcp">MCP for AI tools</Tabs.Tab>
        </Tabs.List>
      </Tabs>
      {tab === 'mcp' ? (
        <McpGuide />
      ) : (
        <div className="va-docs">
          <ApiReferenceReact
            configuration={{
              url: '/api/openapi.json',
              darkMode: scheme === 'dark',
              forceDarkModeState: scheme,
              hideDarkModeToggle: true,
              withDefaultFonts: false,
              customCss: SCALAR_CSS,
              layout: 'modern',
              hideModels: false,
              authentication: { preferredSecurityScheme: 'bearerAuth' },
              metaData: { title: 'Video Agent API' },
              servers: [{ url: window.location.origin, description: 'This video agent' }],
              showDeveloperTools: 'never',
              // Scalar's own toolbar and "Ask AI" chat; this app's AI entry point is MCP instead.
              ...({ showToolbar: 'never', agent: { disabled: true } } as object),
            }}
          />
        </div>
      )}
    </>
  )
}
