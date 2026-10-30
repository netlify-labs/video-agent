import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'test/**/*.test.ts', 'ui/src/**/*.test.{ts,tsx}'],
    exclude: ['ui/e2e/**', 'node_modules/**'],
    environment: 'node',
  },
})
