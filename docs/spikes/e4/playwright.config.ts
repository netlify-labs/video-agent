// Spike E4 only (not part of CI): cd docs/spikes/e4 && npx tsx build.ts, then npx playwright test -c docs/spikes/e4
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: 'e4.spec.ts',
  timeout: 120_000,
  reporter: 'list',
  outputDir: '.work/test-results',
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
})
