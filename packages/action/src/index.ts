// The Video Agent GitHub Action (docs/plans/2026-11-04-github-action.md). Private: never published to npm. src/entry.ts
// is what runs; scripts/build.ts bundles it to dist/index.cjs, which action.yml runs on node24.
export { run, productionDeps, type ActionDeps, type RunResult } from './main.js'
export { INPUTS, OUTPUTS } from './spec.js'

export const PACKAGE_NAME = 'video-agent-action'
