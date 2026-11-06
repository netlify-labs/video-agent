// Following a version until it's done (github-action plan §3.8, bead va-mg4i.2.10). State comes from GET (a step update
// doesn't change the video's ETag), progress from /progress while it runs, polls start at 5 s and back off to 15 s, and
// time comes from ActionDeps so tests run a 30-minute wait in moments.
import type { VideoAgent } from '../../sdk/src/index.js'
import type { Run } from './main.js'
import type { Version, Video } from './state.js'

export type Followed =
  | { outcome: 'ready'; video: Video; version: Version }
  | { outcome: 'failed'; video: Video; version: Version }
  | { outcome: 'timeout'; video: Video; version: Version | undefined }

const FAILED = new Set(['failed', 'cancelled', 'timed_out'])
const LIVE = new Set(['running', 'finishing'])
export const POLL_START_MS = 5000
export const POLL_MAX_MS = 15000

export async function follow(
  run: Run,
  va: VideoAgent,
  id: string,
  n: number,
  o: { timeoutMs: number; onRunning?: (v: Version) => Promise<void> },
): Promise<Followed> {
  const { deps, log } = run
  const deadline = deps.now() + o.timeoutMs
  let interval = POLL_START_MS
  let sawRunning = false
  let last = ''
  for (;;) {
    const video = await va.videos.get(id)
    const version = video.versions.find((x) => x.n === n)
    if (version?.status === 'ready') return { outcome: 'ready', video, version }
    if (version && FAILED.has(version.status)) return { outcome: 'failed', video, version }
    if (version && LIVE.has(version.status)) {
      if (!sawRunning) {
        sawRunning = true
        await o.onRunning?.(version)
      }
      const p = await va.videos.progress(id).catch(() => null)
      const now = `${p?.stage ?? version.stage ?? ''}|${p?.step ?? version.latestStep ?? ''}`
      if (now !== last) {
        last = now
        log.line({
          progress: version.status,
          stage: p?.stage ?? version.stage ?? undefined,
          step: p?.step ?? version.latestStep ?? undefined,
        })
      }
    }
    if (deps.now() >= deadline) return { outcome: 'timeout', video, version }
    await deps.sleep(interval)
    interval = Math.min(POLL_MAX_MS, interval + 2500)
  }
}
