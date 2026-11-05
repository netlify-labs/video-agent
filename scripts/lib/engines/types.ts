// The run side of a render engine (docs/plans/2026-11-04-render-engines.md §4.3): what render-job and prepare-run call
// instead of naming HyperFrames. Phase 1 builds only what render-job needs (entry, contract, render, version); the
// optional hooks arrive with their first consumer (scaffold, hydrate, check and snapshot with Remotion in Phase 2).
import type { EngineId } from '../../../src/domain/engines.js'

export interface RenderReport {
  /** Renders the engine's license counts (Remotion: the video, each still, any audio render). HyperFrames: none. */
  renders?: { video: number; stills: number; audio: number }
}

export interface RunEngine {
  id: EngineId
  /** Seed video/ for an author run. Phase 2. */
  scaffold?(videoDir: string): Promise<void>
  /** Install what a restored source needs, after checking its files are allowed. Phase 2. */
  hydrate?(videoDir: string): Promise<void>
  /** The engine's own checks; 0 errors means ready to render. Phase 2. */
  check?(videoDir: string): Promise<{ errors: string[]; warnings: string[] }>
  /** Why there's nothing to render yet (the entry file is missing), as messages for the agent; [] when there is. */
  entryProblems(videoDir: string): string[]
  /**
   * The editing contract: null when the composition doesn't declare it (not editable), [] when it keeps it, else one
   * message for the agent per problem.
   */
  contract(videoDir: string): string[] | null
  /** PNG stills at these seconds into .render/snapshots/, in one call. Phase 2. */
  snapshot?(videoDir: string, atSec: number[]): Promise<string[]>
  /** The MP4 at the given quality, reporting whole percentages as it goes. */
  render(
    videoDir: string,
    out: string,
    quality: string,
    onProgress: (pct: number) => void,
  ): Promise<RenderReport>
  /** The editor's preview bundle. Phase 3. */
  previewBundle?(videoDir: string): Promise<void>
  /** Render-job's guard and splice for a scoped revision (regenerate-beat): ScopeCheck's result shape. */
  scopeCheck?(
    frozenDir: string,
    videoDir: string,
    beats: string[],
  ): { problems: string[]; files: Map<string, Uint8Array> | null }
  /** The engine's version, for the manifest. */
  version(videoDir: string): string
}
