import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'scripts/**/*.test.ts',
      'test/**/*.test.ts',
      'ui/src/**/*.test.{ts,tsx}',
      'packages/*/test/**/*.test.ts',
    ],
    exclude: ['ui/e2e/**', '**/node_modules/**', 'packages/*/dist/**'],
    environment: 'node',
  },
})
