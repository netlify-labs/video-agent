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

preloadRoute(window.location.pathname)

// The mock API (and the contract code it uses) is loaded only in mock builds, before the app's first request.
const ready = import.meta.env.VITE_MOCK
  ? import('./mock/server').then((m) => {
      m.installMock()
    })
  : Promise.resolve()

const root = document.getElementById('root')
if (root) {
  void ready.then(() => {
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
