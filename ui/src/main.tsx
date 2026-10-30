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
import { installMock } from './mock/server'
import { resolver, theme } from './theme'

if (import.meta.env.VITE_MOCK) installMock()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, e) => n < 2 && !(typeof e === 'object' && 'error' in e),
      refetchOnWindowFocus: true,
    },
  },
})

const root = document.getElementById('root')
if (root) {
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
}
