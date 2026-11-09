import { defineConfig } from '@playwright/test'

// UI smoke tests against the mock build (VITE_MOCK=1): no backend, real sample media. Paths here, the web server's
// working directory and the output folders (test-results/, playwright-report/) are relative to app/web/.
// GitHub's runners are several times slower than a laptop: the 200-clip timeline fixture and the audio clocks need
// more than 5 s there. CI also retries a failed spec once; the report lists it as flaky, so nothing is hidden.
const CI = Boolean(process.env.CI)

export default defineConfig({
  testDir: 'e2e',
  timeout: CI ? 60_000 : 30_000,
  // A stuck spec fails the suite in CI instead of holding the job (ci.yml also times the step out).
  ...(CI ? { globalTimeout: 30 * 60_000 } : {}),
  expect: { timeout: CI ? 15_000 : 5_000 },
  retries: CI ? 1 : 0,
  use: {
    baseURL: 'http://localhost:4198',
    trace: 'retain-on-failure',
    ...(process.env.CI ? {} : { channel: 'chrome' }),
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    // vendor/va-recording.js in real Chromium on a static fixture served by route (screen-recording plan, va-rsk5.3.8).
    {
      name: 'recording-runtime',
      testDir: '../test/recording-runtime',
      use: { viewport: { width: 1920, height: 1080 } },
    },
  ],
  webServer: {
    command:
      'VITE_MOCK=1 npx vite build --outDir dist-mock && VITE_MOCK=1 npx vite preview --outDir dist-mock --port 4198 --strictPort',
    url: 'http://localhost:4198',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
