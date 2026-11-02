// The REST reference (Scalar, from the live OpenAPI spec). Scalar is large, so this is the only docs page that loads it.
import '@scalar/api-reference-react/style.css'
import { useComputedColorScheme } from '@mantine/core'
import { ApiReferenceReact } from '@scalar/api-reference-react'

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
  /* The rule token is nearly black in dark mode; lines need to show against the ground. */
  --scalar-border-color: color-mix(in srgb, var(--va-text) 12%, transparent);
  /* The app's header sits above the reference, so Scalar's sticky sidebar starts under it. */
  --scalar-custom-header-height: 56px;
  --scalar-color-1: var(--va-text);
  --scalar-color-2: var(--va-muted);
  --scalar-color-3: var(--va-faint);
  --scalar-color-accent: var(--va-text);
  --scalar-color-green: var(--va-accent);
  --scalar-link-color: var(--va-text);
  --scalar-button-1: var(--va-primary-bg);
  --scalar-button-1-color: var(--va-primary-ink);
  --scalar-button-1-hover: var(--va-primary-bg);
  /* A grey sidebar, set apart from the content, with grey items that light up on hover and when active. */
  --scalar-sidebar-background-1: var(--va-surface);
  --scalar-sidebar-border-color: color-mix(in srgb, var(--va-text) 12%, transparent);
  --scalar-sidebar-color-1: var(--va-text);
  --scalar-sidebar-color-2: var(--va-muted);
  --scalar-sidebar-color-active: var(--va-text);
  --scalar-sidebar-item-hover-background: var(--va-raised);
  --scalar-sidebar-item-hover-color: var(--va-text);
  --scalar-sidebar-item-active-background: color-mix(in srgb, var(--va-text) 12%, var(--va-surface));
  --scalar-sidebar-search-background: var(--va-raised);
  --scalar-sidebar-search-border-color: color-mix(in srgb, var(--va-text) 12%, transparent);
  --scalar-sidebar-search-color: var(--va-muted);
}
.va-docs .scalar-app { background: var(--va-ground); }
`

export default function ApiReferencePage() {
  const scheme = useComputedColorScheme('dark')
  // The whole content area beside the app's navigation: no title, no margins (the reference has its own heading and
  // says where API keys come from).
  return (
    <>
      <div className="va-docs va-docs-full">
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
