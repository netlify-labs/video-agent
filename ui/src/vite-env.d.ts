/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_MOCK?: string
  /** '1' in a preview build (agent run, deploy preview, branch deploy): the app can't run there. */
  readonly VITE_PREVIEW_DEPLOY?: string
  /** The site's production URL, for the preview's link to the real app. */
  readonly VITE_APP_URL?: string
}
