// scripts/build.ts bakes the deployed commit and release tag into app/server/generated/build-info.ts (cli-and-sdk §5.1).
import { describe, expect, it } from 'vitest'
import { buildInfoModule, buildInfoOf } from '../../scripts/lib/build-info.js'
import { buildInfo } from '../server/generated/build-info.js'

describe('build info', () => {
  it("takes the commit from Netlify's COMMIT_REF", () => {
    expect(buildInfoOf({ COMMIT_REF: 'abc123' }, 'v1.2.0')).toEqual({ commit: 'abc123', release: 'v1.2.0' })
    expect(buildInfoOf({}, null)).toEqual({ commit: null, release: null })
    expect(buildInfoOf({ COMMIT_REF: '' }, null).commit).toBeNull()
  })

  it('writes a module that reads back the same values', () => {
    const src = buildInfoModule({ commit: 'abc123', release: null })
    expect(src).toContain('"commit": "abc123"')
    expect(src).toContain('export const buildInfo')
  })

  it('the committed module is the null one the build overwrites', () => {
    expect(buildInfo).toEqual({ commit: null, release: null })
  })
})
