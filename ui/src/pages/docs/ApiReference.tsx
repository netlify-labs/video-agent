// The REST reference (Scalar, from the live OpenAPI spec). Scalar is large, so this is the only docs page that loads it.
import '@scalar/api-reference-react/style.css'
import { Anchor, useComputedColorScheme } from '@mantine/core'
import { ApiReferenceReact } from '@scalar/api-reference-react'
import { Link } from 'react-router'
import { DocsHeader } from './DocsLayout'

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

export default function ApiReferencePage() {
  const scheme = useComputedColorScheme('dark')
  return (
    <>
      <DocsHeader
        title="REST API"
        sub={
          <>
            Everything the web app does is in the API. Authenticate with a key from the{' '}
            <Anchor component={Link} to="/keys" c="var(--va-text)" inherit>
              API keys
            </Anchor>{' '}
            page.
          </>
        }
      />
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
    </>
  )
}
