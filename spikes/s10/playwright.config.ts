// Spike S10 only (not part of CI): spikes/s10/make-media.sh && npx playwright test -c spikes/s10
// chromium runs the whole pipeline on media/fake-mic.wav: looped in-page by default (the "synthetic" mic, see
// web/page.ts), or through Chromium's fake capture device below with S10_MIC=device (that getUserMedia hangs on the
// macOS agent host). webkit and firefox, when their Playwright browsers are installed, run only the API matrix.
// S10_LONG=1 adds the 10-minute take.
import { defineConfig, devices, firefox, webkit } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const media = join(new URL('.', import.meta.url).pathname, 'media')

export default defineConfig({
  testDir: '.',
  testMatch: 's10.spec.ts',
  timeout: 120_000,
  workers: 1,
  reporter: 'list',
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // the full Chrome for Testing build (H.264 MP4 playback); the headless shell lacks proprietary codecs
        channel: 'chromium',
        launchOptions: {
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            `--use-file-for-fake-audio-capture=${join(media, 'fake-mic.wav')}`,
            '--autoplay-policy=no-user-gesture-required',
            '--enable-precise-memory-info',
          ],
        },
      },
    },
    // matrix only, and only when that Playwright browser is installed (never installed by this spike)
    ...(existsSync(webkit.executablePath())
      ? [{ name: 'webkit', grep: /@matrix/, use: { ...devices['Desktop Safari'] } }]
      : []),
    ...(existsSync(firefox.executablePath())
      ? [{ name: 'firefox', grep: /@matrix/, use: { ...devices['Desktop Firefox'] } }]
      : []),
  ],
})
