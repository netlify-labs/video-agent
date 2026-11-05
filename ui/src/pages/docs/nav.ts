// The docs pages, grouped, in the order the sidebar shows them (cli-and-sdk plan §8). Another plan adds a page with
// one entry here and its route (ui/src/App.tsx, and BY_PATH in ui/src/routes.tsx); a test checks every entry has
// both. A page that isn't built yet isn't listed. Kept apart from DocsLayout so the app's sidebar doesn't load the
// docs pages' code.
export type DocsGroup = 'Build' | 'AI tools' | 'Guides'

export interface DocsPage {
  path: string
  label: string
  group: DocsGroup
}

export const DOCS_GROUPS: readonly DocsGroup[] = ['Build', 'AI tools', 'Guides']

export const DOCS_PAGES: readonly DocsPage[] = [
  { path: '/docs/api', label: 'REST API', group: 'Build' },
  { path: '/docs/mcp', label: 'MCP for AI tools', group: 'AI tools' },
  { path: '/docs/skills', label: 'Agent skills', group: 'AI tools' },
  { path: '/docs/destinations', label: 'Publish destinations', group: 'Guides' },
]
