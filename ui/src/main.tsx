import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'
import { MantineProvider } from '@mantine/core'
import { ModalsProvider } from '@mantine/modals'
import { Notifications } from '@mantine/notifications'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { App } from './App'
import { AuthProvider } from './auth'
import { theme } from './theme'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: (n, e) => n < 2 && !(typeof e === 'object' && 'error' in e), refetchOnWindowFocus: true } },
})

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <MantineProvider theme={theme} defaultColorScheme="dark">
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
