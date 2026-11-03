import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'
import './app.css'
import { MantineProvider } from '@mantine/core'
import { ModalsProvider } from '@mantine/modals'
import { Notifications } from '@mantine/notifications'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { fetchClient } from './api/client'
import { App } from './App'
import { AuthProvider } from './auth'
import { preloadRoute } from './routes'
import { resolver, theme } from './theme'

// Data stays fresh for 30 s, so going back and forth between pages shows it at once instead of refetching it. Writes
// invalidate what they change, and in-progress videos keep polling on their own intervals.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, e) => n < 2 && !(typeof e === 'object' && 'error' in e),
      refetchOnWindowFocus: true,
      staleTime: 30_000,
    },
  },
})

// A preview build can't run the app (no API or data, and sign-in can't come back to this address): show the project
// page instead, with a note and a link to the real app.
const previewOnly = import.meta.env.VITE_PREVIEW_DEPLOY === '1'
if (previewOnly) {
  const app = import.meta.env.VITE_APP_URL
  window.location.replace(`/how-we-built-it/?preview=1${app ? `&app=${encodeURIComponent(app)}` : ''}`)
} else preloadRoute(window.location.pathname, window.location.search)

// The mock API (and the contract code it uses) is loaded only in mock builds, before the app's first request.
const ready = import.meta.env.VITE_MOCK
  ? import('./mock/server').then((m) => {
      m.installMock()
    })
  : Promise.resolve()

// The library is the home page: ask for its first page now, alongside the sign-in check, instead of after it. Same key
// and request as the Library page's list (no filters), so the page renders from it; signed out, the 401 is ignored.
const prefetchLibrary = () => {
  if (window.location.pathname !== '/' || window.location.search) return
  const init = { params: { query: { owner: 'all' as const, limit: 24 } } }
  void queryClient
    .infiniteQuery({
      queryKey: ['get', '/api/v1/videos', init],
      initialPageParam: '',
      queryFn: async ({ pageParam }) => {
        const { data, error } = await fetchClient.GET('/api/v1/videos', {
          params: { query: { ...init.params.query, cursor: pageParam } },
        })
        if (error) throw new Error('The library could not load early; the page asks again.')
        return data
      },
    })
    .catch(() => undefined)
}

const root = document.getElementById('root')
if (root && !previewOnly) {
  void ready.then(() => {
    prefetchLibrary()
    createRoot(root).render(
      <StrictMode>
        <MantineProvider theme={theme} cssVariablesResolver={resolver} defaultColorScheme="dark">
          <Notifications position="top-right" />
          <QueryClientProvider client={queryClient}>
            <AuthProvider>
              <ModalsProvider>
                <BrowserRouter>
                  <App />
                </BrowserRouter>
              </ModalsProvider>
            </AuthProvider>
          </QueryClientProvider>
        </MantineProvider>
      </StrictMode>,
    )
  })
}
