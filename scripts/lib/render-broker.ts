// Local mode's render broker (cli-and-sdk plan §7; docs/spikes.md C2). Rendering serves the composition to Chrome on
// 127.0.0.1, and a macOS sandbox that lets the agent's shell listen there also lets it reach the person's own local
// services. So with VA_RENDER_BROKER=file, render-job doesn't render: it asks the CLI, outside the sandbox, through
// files in .render/<attempt>/, and the agent's shell never needs the loopback.
//   render-request.json   { quality }                written by render-job
//   render-progress.json  { pct }                    written by the CLI as it goes
//   render-result.json    { ok, error? }             written by the CLI when the MP4 is in place (video.mp4)
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const REQUEST = 'render-request.json'
export const PROGRESS = 'render-progress.json'
export const RESULT = 'render-result.json'

export const writeJson = (file: string, body: unknown) => {
  writeFileSync(`${file}.tmp`, JSON.stringify(body))
  renameSync(`${file}.tmp`, file)
}
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the file's shape
const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

/** Asks the CLI to render video.mp4 into `out` and waits for it, reporting its progress. */
export async function brokeredRender(
  out: string,
  quality: string,
  onProgress: (pct: number) => void,
  o: { pollMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const started = Date.now()
  writeJson(join(out, REQUEST), { quality })
  let last = -1
  for (;;) {
    const result = readJson<{ ok: boolean; error?: string }>(join(out, RESULT))
    if (result) {
      if (!result.ok) throw new Error(`The render failed: ${result.error ?? 'no reason given'}`)
      if (!existsSync(join(out, 'video.mp4')))
        throw new Error('The render reported success but made no video.mp4')
      return
    }
    const pct = readJson<{ pct: number }>(join(out, PROGRESS))?.pct
    if (typeof pct === 'number' && pct !== last) {
      last = pct
      onProgress(pct)
    }
    if (Date.now() - started > (o.timeoutMs ?? 25 * 60_000))
      throw new Error('The CLI never finished the render (is video-agent local still running?)')
    await new Promise((r) => setTimeout(r, o.pollMs ?? 500))
  }
}
