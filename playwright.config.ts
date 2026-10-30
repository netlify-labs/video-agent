import { defineConfig } from '@playwright/test'

// UI smoke tests against the mock build (VITE_MOCK=1): no backend, real sample media.
export default defineConfig({
  testDir: 'ui/e2e',
  timeout: 30_000,
  use: { baseURL: 'http://localhost:4198', trace: 'retain-on-failure', ...(process.env.CI ? {} : { channel: 'chrome' }) },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: 'VITE_MOCK=1 npx vite build ui --outDir dist-mock && VITE_MOCK=1 npx vite preview ui --outDir dist-mock --port 4198 --strictPort',
    url: 'http://localhost:4198',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
