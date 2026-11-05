// The features registry for GET /api/v1/config (docs/plans/2026-11-04-cli-and-sdk.md §5.1; roadmap shared rule 1).
// A string is listed only when this deployment has the feature AND it's switched on, so the SDK, CLI, MCP and the
// GitHub Action can hide what a server doesn't offer. Each plan adds its own string here, in its own PR.
import type { Deps } from '../deps.js'
import { narrationEnabled } from './narration-settings.js'
import { remixEnabled } from './remix-settings.js'
import { youtubeAvailable } from './destinations/registry.js'
import { scopeCheckFor } from './engines.js'

export const FEATURES = [
  'remix', // remixing; admin switch remixEnabled
  'narration', // recorded voice-over in the editor; admin switch narrationEnabled
  'planning', // Plan it first (AI Gateway available)
  'rest_wait', // RESERVED: a server-side wait on GET /videos/{id} (cli-and-sdk §14); never listed in v1
  'cli_login', // video-agent login's browser approval; admin switch cliLoginEnabled (cli-and-sdk 3.3)
  'looks', // named visual styles (looks plan)
  'engines', // render engines beyond HyperFrames (render-engines plan)
  'scoped_revision', // redo one scene (regenerate-beat plan)
  'screen_recording', // screen recording → demo (screen-recording-demo plan)
  'context', // run context from the GitHub Action (github-action plan)
  'external_ref', // external references on jobs (github-action plan)
  'destinations', // publish destinations (publish-destinations plan)
  'youtube', // the YouTube destination, when it's set up and on
] as const

export type Feature = (typeof FEATURES)[number]

/**
 * Screen recordings are listed only once the whole API is in: the upload role and trace routes (phase 1) and
 * `recording` on create and remix (va-rsk5.3.16 sets ready), so clients never see half the feature.
 */
export const screenRecordingApi: { ready: boolean } = { ready: false }

/** The features this deployment offers right now. Before the database is set up, switches read as their defaults. */
export async function enabledFeatures(deps: Deps): Promise<Feature[]> {
  const on: Feature[] = []
  if (await remixEnabled(deps).catch(() => true)) on.push('remix')
  if (await narrationEnabled(deps).catch(() => true)) on.push('narration')
  if (deps.gateway.available()) on.push('planning')
  if (screenRecordingApi.ready) on.push('screen_recording')
  if (deps.looks.catalog().length) on.push('looks')
  on.push('destinations')
  // Redo a scene: once HyperFrames' scope check is registered (prodDeps does it at startup).
  if (scopeCheckFor('hyperframes')) on.push('scoped_revision')
  if (await youtubeAvailable(deps, deps.store).catch(() => false)) on.push('youtube')
  return on
}
