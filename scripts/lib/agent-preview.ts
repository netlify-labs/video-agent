// What an agent run's preview deploy shows (scripts/build.ts). A video run (prepare-run.ts wrote
// .render/run-manifest.json) gets a page with the video it rendered, or a link to it in Video Agent when the build
// can't see .render/ (it's git-ignored, so it never reaches a commit or pull request). Any other agent run, someone
// changing the app itself, builds the app as usual.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Whether this build is a preview that can't run the app: an agent run's preview, a deploy preview or a branch deploy.
 * Only the published production deploy serves the API and data, and sign-in can't return to a preview's address, so
 * the app opens the How we built it page there instead of a sign-in form that leads nowhere.
 */
export function isPreviewBuild(env: NodeJS.ProcessEnv): boolean {
  const agentRun = Object.keys(env).some((k) => k.startsWith('NETLIFY_AGENT_RUNNER_'))
  return agentRun || env.CONTEXT === 'deploy-preview' || env.CONTEXT === 'branch-deploy'
}

export interface VideoRun {
  jobId: string
  attemptId: string
  versionN: number
}

/** The video run this checkout made, from .render/run-manifest.json; null for any other run. */
export function videoRunOf(root: string): VideoRun | null {
  try {
    const m = JSON.parse(
      readFileSync(join(root, '.render', 'run-manifest.json'), 'utf8'),
    ) as Partial<VideoRun>
    return typeof m.jobId === 'string' && typeof m.attemptId === 'string' && typeof m.versionN === 'number'
      ? { jobId: m.jobId, attemptId: m.attemptId, versionN: m.versionN }
      : null
  } catch {
    return null
  }
}

const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )

/** The video's title from video/summary.json, as the run wrote it. */
function titleOf(root: string): string | null {
  try {
    const t = (JSON.parse(readFileSync(join(root, 'video', 'summary.json'), 'utf8')) as { title?: unknown })
      .title
    return typeof t === 'string' && t.trim() ? t.trim().slice(0, 120) : null
  } catch {
    return null
  }
}

/**
 * Writes the preview page for a video run into `outDir`: index.html, plus video.mp4 and poster.jpg when the render is
 * there. `siteUrl` is the deployment's main URL (the URL build variable), for the link to the video in the app.
 */
export function writeVideoRunPreview(o: {
  root: string
  outDir: string
  run: VideoRun
  siteUrl: string | null
}) {
  const rendered = join(o.root, '.render', o.run.attemptId)
  const embedded = existsSync(join(rendered, 'video.mp4'))
  mkdirSync(o.outDir, { recursive: true })
  if (embedded) {
    copyFileSync(join(rendered, 'video.mp4'), join(o.outDir, 'video.mp4'))
    if (existsSync(join(rendered, 'poster.jpg')))
      copyFileSync(join(rendered, 'poster.jpg'), join(o.outDir, 'poster.jpg'))
  }
  const poster = embedded && existsSync(join(o.outDir, 'poster.jpg')) ? ' poster="poster.jpg"' : ''
  const title = titleOf(o.root)
  const app = o.siteUrl ? `${o.siteUrl.replace(/\/$/, '')}/videos/${encodeURIComponent(o.run.jobId)}` : null
  const heading = title ? `${escape(title)} <span>v${o.run.versionN}</span>` : `Version ${o.run.versionN}`
  const body = embedded
    ? `<video src="video.mp4"${poster} controls playsinline preload="metadata"></video>`
    : `<p class="empty">The rendered video isn't in this preview build.${app ? ' Watch it in Video Agent instead.' : ''}</p>`
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Video preview</title>
<style>
  :root { color-scheme: dark; --ground: #0b0d10; --text: #f4f5f7; --muted: #9aa3ad; --rule: #23272e; }
  body { margin: 0; background: var(--ground); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
  .note { color: var(--muted); font-size: 13px; margin: 0 0 4px; }
  h1 { font-size: 22px; margin: 0 0 16px; }
  h1 span { color: var(--muted); font-weight: 400; }
  video { display: block; width: 100%; max-height: 75vh; background: #000; border-radius: 12px; }
  .empty { border: 1px solid var(--rule); border-radius: 12px; padding: 32px; color: var(--muted); }
  a { color: var(--text); }
</style>
</head>
<body>
<main>
<p class="note">Video preview: the video this agent run made. This is not what the site renders.</p>
<h1>${heading}</h1>
${body}
${app ? `<p><a href="${escape(app)}" target="_blank" rel="noopener">Open it in Video Agent</a></p>` : ''}
</main>
</body>
</html>
`
  writeFileSync(join(o.outDir, 'index.html'), html)
  return { embedded }
}
