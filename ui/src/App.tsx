import { Center, Loader } from '@mantine/core'
import { Suspense, useEffect, type ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router'
import { $api } from './api/client'
import { useAuth } from './auth'
import { Layout } from './components/Layout'
import { LibraryPage } from './pages/Library'
import { AuthPages } from './pages/SignIn'
import * as routes from './routes'
import { claimMediaCache, registerMediaCache } from './sw/register'

// The library and sign-in are in the main bundle; every other page is its own chunk (the API reference
// and the editor's contract code are large).
const VideoPage = routes.lazyPage(routes.videoRoute, (m) => m.VideoPage)
const NewVideoPage = routes.lazyPage(routes.newVideoRoute, (m) => m.NewVideoPage)
const EditPage = routes.lazyPage(routes.editRoute, (m) => m.EditPage)
const MediaPage = routes.lazyPage(routes.mediaRoute, (m) => m.MediaPage)
const KeysPage = routes.lazyPage(routes.keysRoute, (m) => m.KeysPage)
const AdminPage = routes.lazyPage(routes.adminRoute, (m) => m.AdminPage)
const SetupPage = routes.lazyPage(routes.setupRoute, (m) => m.SetupPage)
const DocsApiPage = routes.lazyPage(routes.docsApiRoute, (m) => m.default)
const DocsMcpPage = routes.lazyPage(routes.docsMcpRoute, (m) => m.default)
const DocsSkillsPage = routes.lazyPage(routes.docsSkillsRoute, (m) => m.default)

/** /docs opens the REST reference; old /docs?tab=mcp|skills links open their page, keeping the hash. */
function DocsRedirect() {
  const { search, hash } = useLocation()
  return <Navigate to={{ pathname: routes.docsPath(search), hash }} replace />
}

function Page({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <Center p="xl">
          <Loader size="sm" />
        </Center>
      }
    >
      {children}
    </Suspense>
  )
}

export function App() {
  const auth = useAuth()
  const health = $api.useQuery('get', '/api/health', {}, { staleTime: 60_000 })
  const userId = auth.ready && !auth.pending ? auth.user?.id : undefined
  useEffect(() => {
    if (!userId) return
    routes.warmRoutes()
    void claimMediaCache(userId).then(registerMediaCache)
  }, [userId])

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
        <Route
          path="/setup"
          element={
            <Page>
              <SetupPage standalone />
            </Page>
          }
        />
        <Route path="*" element={<AuthPages setupReady={health.data?.ready ?? true} />} />
      </Routes>
    )
  }
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<LibraryPage />} />
        <Route
          path="/new"
          element={
            <Page>
              <NewVideoPage />
            </Page>
          }
        />
        <Route
          path="/videos/:id"
          element={
            <Page>
              <VideoPage />
            </Page>
          }
        />
        <Route
          path="/videos/:id/edit/:n"
          element={
            <Page>
              <EditPage />
            </Page>
          }
        />
        <Route
          path="/media"
          element={
            <Page>
              <MediaPage />
            </Page>
          }
        />
        <Route
          path="/keys"
          element={
            <Page>
              <KeysPage />
            </Page>
          }
        />
        <Route
          path="/admin"
          element={
            <Page>
              <AdminPage />
            </Page>
          }
        />
        <Route
          path="/setup"
          element={
            <Page>
              <SetupPage />
            </Page>
          }
        />
        <Route path="/docs" element={<DocsRedirect />} />
        <Route
          path="/docs/api"
          element={
            <Page>
              <DocsApiPage />
            </Page>
          }
        />
        <Route
          path="/docs/mcp"
          element={
            <Page>
              <DocsMcpPage />
            </Page>
          }
        />
        <Route
          path="/docs/skills"
          element={
            <Page>
              <DocsSkillsPage />
            </Page>
          }
        />
        <Route path="/docs/*" element={<Navigate to="/docs/api" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
