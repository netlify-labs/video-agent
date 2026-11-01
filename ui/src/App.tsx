import { Center, Loader } from '@mantine/core'
import { Suspense, lazy } from 'react'
import { Navigate, Route, Routes } from 'react-router'
import { $api } from './api/client'
import { useAuth } from './auth'
import { Layout } from './components/Layout'
import { AdminPage } from './pages/Admin'
import { KeysPage } from './pages/Keys'
import { LibraryPage } from './pages/Library'
import { NewVideoPage } from './pages/NewVideo'
import { SetupPage } from './pages/Setup'
import { AuthPages } from './pages/SignIn'
import { VideoPage } from './pages/Video'
import { EditPage } from './pages/Edit'

// The API reference is large; load it only when someone opens it.
const DocsPage = lazy(() => import('./pages/Docs'))

export function App() {
  const auth = useAuth()
  const health = $api.useQuery('get', '/api/health', {}, { staleTime: 60_000 })

  if (!auth.ready) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    )
  }
  if (auth.pending || !auth.user) {
    return (
      <Routes>
        <Route path="/setup" element={<SetupPage standalone />} />
        <Route path="*" element={<AuthPages setupReady={health.data?.ready ?? true} />} />
      </Routes>
    )
  }
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<LibraryPage />} />
        <Route path="/new" element={<NewVideoPage />} />
        <Route path="/videos/:id" element={<VideoPage />} />
        <Route path="/videos/:id/edit/:n" element={<EditPage />} />
        <Route path="/keys" element={<KeysPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route
          path="/docs"
          element={
            <Suspense
              fallback={
                <Center p="xl">
                  <Loader size="sm" />
                </Center>
              }
            >
              <DocsPage />
            </Suspense>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
