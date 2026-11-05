import { expect, it } from 'vitest'
import { PACKAGE_NAME } from '../src/index.js'

it('builds and imports', () => {
  expect(PACKAGE_NAME).toMatch(/video-agent/)
})
