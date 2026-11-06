import { Center, Loader } from '@mantine/core'
import { lazy, Suspense, useEffect, type ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router'
import { $api } from './api/client'
import { useAuth } from './auth'
import { Layout } from './components/Layout'
import { RunWatcher } from './components/RunWatcher'
import { CreatorHint } from './components/RemixDialog'
import { LibraryPage } from './pages/Library'
import { AuthPages } from './pages/SignIn'
import * as routes from './routes'
import { claimMediaCache, registerMediaCache } from './sw/register'

// The library and sign-in are in the main bundle; every other page is its own chunk (the API reference
// and the editor's contract code are large).
const VideoPage = routes.lazyPage(routes.videoRoute, (m) => m.VideoPage)
const NewVideoPage = routes.lazyPage(routes.newVideoRoute, (m) => m.NewVideoPage)
const NewDemoPage = routes.lazyPage(routes.newDemoRoute, (m) => m.NewDemoPage)
const EditPage = routes.lazyPage(routes.editRoute, (m) => m.EditPage)
const MediaPage = routes.lazyPage(routes.mediaRoute, (m) => m.MediaPage)
const KeysPage = routes.lazyPage(routes.keysRoute, (m) => m.KeysPage)
const AdminPage = routes.lazyPage(routes.adminRoute, (m) => m.AdminPage)
const SetupPage = routes.lazyPage(routes.setupRoute, (m) => m.SetupPage)
const CliApprovePage = routes.lazyPage(routes.cliApproveRoute, (m) => m.CliApprovePage)
const DocsApiPage = routes.lazyPage(routes.docsApiRoute, (m) => m.default)
const DocsMcpPage = routes.lazyPage(routes.docsMcpRoute, (m) => m.default)
const DocsSkillsPage = routes.lazyPage(routes.docsSkillsRoute, (m) => m.default)
const DocsDestinationsPage = routes.lazyPage(routes.docsDestinationsRoute, (m) => m.default)
const DocsSdkPage = routes.lazyPage(routes.docsSdkRoute, (m) => m.default)
const DocsLooksPage = routes.lazyPage(routes.docsLooksRoute, (m) => m.default)
const DocsGithubPage = routes.lazyPage(routes.docsGithubRoute, (m) => m.default)
// Mock builds only: the narration timeline on fixture data (/dev/timeline). The import is dropped from real builds.
const TimelineDemo = import.meta.env.VITE_MOCK ? lazy(() => import('./mock/TimelineDemo')) : null
// And the narration lock and stale-base banners on a mock draft (/dev/narration).
const NarrationDemo = import.meta.env.VITE_MOCK ? lazy(() => import('./mock/NarrationDemo')) : null
// Mock builds only: the voice-over recorder on its own (/dev/recorder).
const RecorderDemo = import.meta.env.VITE_MOCK ? lazy(() => import('./mock/RecorderDemo')) : null
// Mock builds only: the recorder's picture clock on a muted MP4 (/dev/clock).
const ClockDemo = import.meta.env.VITE_MOCK ? lazy(() => import('./mock/ClockDemo')) : null

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
      {/* RunWatcher: the Notify button's notifications, on every signed-in page. */}
      <Route
        element={
          <>
            <RunWatcher />
            <CreatorHint />
            <Layout />
          </>
        }
      >
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
          path="/new/demo"
          element={
            <Page>
              <NewDemoPage />
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
        {/* video-agent login's approval. Signed out, the sign-in page shows here and this page follows it; no code
            is ever carried in the URL. */}
        <Route
          path="/cli/approve"
          element={
            <Page>
              <CliApprovePage />
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
        <Route
          path="/docs/destinations"
          element={
            <Page>
              <DocsDestinationsPage />
            </Page>
          }
        />
        <Route
          path="/docs/sdk"
          element={
            <Page>
              <DocsSdkPage />
            </Page>
          }
        />
        <Route
          path="/docs/looks"
          element={
            <Page>
              <DocsLooksPage />
            </Page>
          }
        />
        <Route
          path="/docs/github"
          element={
            <Page>
              <DocsGithubPage />
            </Page>
          }
        />
        <Route path="/docs/*" element={<Navigate to="/docs/api" replace />} />
        {TimelineDemo ? (
          <Route
            path="/dev/timeline"
            element={
              <Page>
                <TimelineDemo />
              </Page>
            }
          />
        ) : null}
        {NarrationDemo ? (
          <Route
            path="/dev/narration"
            element={
              <Page>
                <NarrationDemo />
              </Page>
            }
          />
        ) : null}
        {RecorderDemo ? (
          <Route
            path="/dev/recorder"
            element={
              <Page>
                <RecorderDemo />
              </Page>
            }
          />
        ) : null}
        {ClockDemo ? (
          <Route
            path="/dev/clock"
            element={
              <Page>
                <ClockDemo />
              </Page>
            }
          />
        ) : null}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
