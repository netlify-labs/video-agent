import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'app/server/**/*.test.ts',
      'scripts/**/*.test.ts',
      'app/test/**/*.test.ts',
      'app/web/src/**/*.test.{ts,tsx}',
      'packages/*/test/**/*.test.ts',
    ],
    exclude: ['app/web/e2e/**', '**/node_modules/**', 'packages/*/dist/**'],
    environment: 'node',
  },
})
