// Which mock asset stands in for each video's files. Kept apart from server.ts so the app can import it without
// pulling the mock API (and its contract code) into the production bundle.
const ASSETS: Record<string, string> = {
  vid_teaser: 'teaser-v2',
  vid_webhooks: 'launch-webhooks',
  vid_sales: 'sales-vertical',
  vid_docs: 'docs-envvars',
}

export function mockFile(videoId: string, file: 'video' | 'poster' | 'gif' | 'captions'): string {
  const base = ASSETS[videoId] ?? 'teaser-v2'
  const ext = { video: 'mp4', poster: 'jpg', gif: 'gif', captions: 'vtt' }[file]
  if (file === 'video' && base === 'sales-vertical') return '/sales-vertical.mp4'
  return `/${file === 'video' || file === 'captions' ? 'teaser-v2' : base}.${ext}`
}
