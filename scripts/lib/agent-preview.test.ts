// The agent run preview page (scripts/build.ts): a video run shows its video, or a link when .render/ isn't there.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isPreviewBuild, videoRunOf, writeVideoRunPreview } from './agent-preview.js'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'agent-preview-'))
  dirs.push(d)
  return d
}
const RUN = { jobId: 'vid_1', attemptId: 'att-1', versionN: 2 }

/** A checkout after a video run: the run manifest, the summary and (optionally) the rendered files. */
function checkout(o: { rendered?: boolean; title?: string } = {}) {
  const root = tmp()
  mkdirSync(join(root, '.render', RUN.attemptId), { recursive: true })
  writeFileSync(join(root, '.render', 'run-manifest.json'), JSON.stringify({ v: 1, kind: 'create', ...RUN }))
  mkdirSync(join(root, 'video'))
  writeFileSync(
    join(root, 'video', 'summary.json'),
    JSON.stringify({ title: o.title ?? 'Webhooks <for> "Sales"' }),
  )
  if (o.rendered ?? true) {
    writeFileSync(join(root, '.render', RUN.attemptId, 'video.mp4'), 'mp4')
    writeFileSync(join(root, '.render', RUN.attemptId, 'poster.jpg'), 'jpg')
  }
  return root
}

describe('agent run preview', () => {
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('finds a video run from its run manifest, and nothing in any other checkout', () => {
    expect(videoRunOf(checkout())).toEqual(RUN)
    expect(videoRunOf(tmp())).toBeNull()
    const bad = tmp()
    mkdirSync(join(bad, '.render'))
    writeFileSync(join(bad, '.render', 'run-manifest.json'), '{"jobId": 3}')
    expect(videoRunOf(bad)).toBeNull()
  })

  it('shows the rendered video with its poster, the title escaped, and a link to it in the app', () => {
    const root = checkout()
    const out = join(root, 'ui/dist')
    expect(
      writeVideoRunPreview({ root, outDir: out, run: RUN, siteUrl: 'https://video.example.com/' }),
    ).toEqual({
      embedded: true,
    })
    expect(readFileSync(join(out, 'video.mp4'), 'utf8')).toBe('mp4')
    expect(existsSync(join(out, 'poster.jpg'))).toBe(true)
    const html = readFileSync(join(out, 'index.html'), 'utf8')
    expect(html).toContain('This is not what the site renders.')
    expect(html).toContain('<video src="video.mp4" poster="poster.jpg" controls')
    expect(html).toContain('Webhooks &lt;for&gt; &quot;Sales&quot; <span>v2</span>')
    expect(html).toContain('href="https://video.example.com/videos/vid_1"')
  })

  it('links to the video in the app when the build has no rendered files', () => {
    const root = checkout({ rendered: false })
    const out = join(root, 'ui/dist')
    expect(
      writeVideoRunPreview({ root, outDir: out, run: RUN, siteUrl: 'https://video.example.com' }),
    ).toEqual({
      embedded: false,
    })
    expect(existsSync(join(out, 'video.mp4'))).toBe(false)
    const html = readFileSync(join(out, 'index.html'), 'utf8')
    expect(html).not.toContain('<video')
    expect(html).toContain('Watch it in Video Agent instead.')
    expect(html).toContain('href="https://video.example.com/videos/vid_1"')
  })

  it('treats agent runs, deploy previews and branch deploys as preview builds, and production as the app', () => {
    expect(isPreviewBuild({ NETLIFY_AGENT_RUNNER_ID: 'x', CONTEXT: 'production' })).toBe(true)
    expect(isPreviewBuild({ CONTEXT: 'deploy-preview' })).toBe(true)
    expect(isPreviewBuild({ CONTEXT: 'branch-deploy' })).toBe(true)
    expect(isPreviewBuild({ CONTEXT: 'production' })).toBe(false)
    expect(isPreviewBuild({ CONTEXT: 'dev' })).toBe(false)
    expect(isPreviewBuild({})).toBe(false)
  })
})
