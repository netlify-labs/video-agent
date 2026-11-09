// The video card: an MCP App (ui://video-agent/video-card.html) that clients like Claude show in the chat for
// create_video, revise_video and show_video. It follows the video with get_video while it's being made, then
// plays it in place. scripts/lib/mcp-app.ts bundles this file into app/server/generated/video-card.ts.
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps'

/** The parts of the get_video result the card reads (app/server/mcp.ts summarize). */
interface VersionResult {
  version: number
  status: string
  error?: { message?: string; category?: string }
  agent_activity?: string
  output?: { duration_sec: number; width: number; height: number }
  downloads?: { mp4: string; poster: string }
}
interface VideoResult {
  video_id: string
  title: string | null
  status: string
  web_url: string
  latest_version: number
  versions: VersionResult[]
  progress?: { stage?: string; step?: number; steps?: number; stale?: boolean }
}
interface ToolError {
  error: { message: string }
}

const IN_PROGRESS = ['queued', 'running', 'finishing']
const WAIT_SEC = 8
/** Stop following after this long; the web page still shows the video. */
const GIVE_UP_MS = 30 * 60_000
const STAGES: Record<string, string> = {
  queued: 'Waiting to start',
  running: 'Making the video',
  finishing: 'Rendering the MP4',
}

const root = document.getElementById('card') as HTMLElement
const app = new App({ name: 'Video card', version: '1.0.0' })
let current: VideoResult | null = null
let following = false
let gaveUp = false
let toldModel = false

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  e.append(...children)
  return e
}

function button(label: string, onClick: () => void, primary = false) {
  const b = el('button', { type: 'button', class: primary ? 'primary' : '' }, label)
  b.addEventListener('click', onClick)
  return b
}

function applyContext(ctx: McpUiHostContext | undefined) {
  if (!ctx) return
  if (ctx.theme) applyDocumentTheme(ctx.theme)
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables)
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts)
}

function displayModes() {
  return app.getHostContext()?.availableDisplayModes ?? []
}

function render(v: VideoResult) {
  current = v
  const latest = v.versions.find((x) => x.version === v.latest_version) ?? v.versions[0]
  const status = latest?.status ?? v.status
  const head = el(
    'header',
    {},
    el('h1', {}, v.title ?? 'Untitled video'),
    el('span', { class: `badge ${status}` }, status === 'ready' ? 'Ready' : (STAGES[status] ?? status)),
  )
  const actions = el('div', { class: 'actions' })
  let body: HTMLElement

  if (status === 'ready' && latest?.downloads) {
    // The mp4 link carries &download=1 after its signature; without it the file plays instead of downloading.
    const src = latest.downloads.mp4.replace('&download=1', '')
    const video = el('video', {
      controls: '',
      playsinline: '',
      preload: 'metadata',
      poster: latest.downloads.poster,
      src,
    })
    // Signed links last an hour: on an expired link, fetch fresh ones and pick up where it stopped.
    video.addEventListener('error', () => void refresh(video.currentTime), { once: true })
    body = el('div', { class: 'player' }, video)
    if (latest.output)
      body.append(
        el(
          'p',
          { class: 'meta' },
          `Version ${latest.version} · ${Math.round(latest.output.duration_sec)} s · ${latest.output.width}×${latest.output.height}`,
        ),
      )
    actions.append(
      button('Download MP4', () => void app.openLink({ url: latest.downloads?.mp4 ?? v.web_url }), true),
    )
    if (displayModes().includes('pip'))
      actions.append(button('Keep on the side', () => void app.requestDisplayMode({ mode: 'pip' })))
    if (displayModes().includes('fullscreen'))
      actions.append(button('Full screen', () => void app.requestDisplayMode({ mode: 'fullscreen' })))
  } else if (IN_PROGRESS.includes(status)) {
    const p = v.progress
    const bar = el('div', { class: 'bar' }, el('span', {}))
    const fill = bar.firstElementChild as HTMLElement
    if (p?.step && p.steps) fill.style.width = `${Math.min(100, Math.round((p.step / p.steps) * 100))}%`
    else bar.classList.add('indeterminate')
    body = el(
      'div',
      { class: 'progress' },
      bar,
      el(
        'p',
        { class: 'meta' },
        [
          `Version ${latest?.version ?? v.latest_version}`,
          p?.stage,
          p?.step && p.steps ? `step ${p.step} of ${p.steps}` : null,
          'usually 3 to 8 minutes',
        ]
          .filter(Boolean)
          .join(' · '),
      ),
    )
    if (latest?.agent_activity) body.append(el('p', { class: 'activity' }, latest.agent_activity))
    if (gaveUp) body.append(el('p', { class: 'meta' }, 'Stopped checking. Open the page for the latest.'))
  } else {
    body = el(
      'p',
      { class: 'error' },
      latest?.error?.message ?? `Version ${latest?.version ?? v.latest_version} ${status}.`,
    )
  }
  actions.append(button('Open in Video Agent', () => void app.openLink({ url: v.web_url })))
  root.replaceChildren(head, body, actions)
}

function renderError(message: string) {
  root.replaceChildren(el('p', { class: 'error' }, message))
}

function read(result: {
  structuredContent?: Record<string, unknown> | undefined
  isError?: boolean | undefined
}): VideoResult | null {
  const body = result.structuredContent
  if (!body) return null
  if (result.isError || 'error' in body) {
    renderError((body as unknown as ToolError).error.message)
    return null
  }
  return 'video_id' in body ? (body as unknown as VideoResult) : null
}

async function getVideo(waitSec: number) {
  if (!current) return null
  const r = await app.callServerTool({
    name: 'get_video',
    arguments: { video_id: current.video_id, wait_seconds: waitSec },
  })
  return read(r)
}

/** Re-reads the video for fresh signed links, keeping the playback position. */
async function refresh(at: number) {
  const v = await getVideo(0).catch(() => null)
  if (!v) return
  render(v)
  const video = root.querySelector('video')
  if (video && at > 0) video.currentTime = at
}

/** Follows a video in progress with get_video (which waits up to 8 s per call) until it's ready or fails. */
async function follow() {
  if (following) return
  following = true
  const until = Date.now() + GIVE_UP_MS
  let pause = 0
  while (current && IN_PROGRESS.includes(statusOf(current)) && Date.now() < until) {
    if (pause) await new Promise((r) => setTimeout(r, pause))
    try {
      const v = await getVideo(WAIT_SEC)
      if (!v) break
      render(v)
      pause = 0
    } catch {
      pause = Math.min((pause || 2_000) * 2, 30_000)
    }
  }
  following = false
  if (current) {
    gaveUp = IN_PROGRESS.includes(statusOf(current))
    render(current)
    await tellModel(current)
  }
}

function statusOf(v: VideoResult) {
  return (v.versions.find((x) => x.version === v.latest_version) ?? v.versions[0])?.status ?? v.status
}

/** Lets the model know how it ended, without starting a turn, so its next answer is current. */
async function tellModel(v: VideoResult) {
  const status = statusOf(v)
  if (toldModel || IN_PROGRESS.includes(status)) return
  toldModel = true
  await app
    .updateModelContext({
      content: [
        {
          type: 'text',
          text:
            status === 'ready'
              ? `The video card shows "${v.title ?? v.video_id}" (${v.video_id}) version ${v.latest_version} as ready and playing. Web page: ${v.web_url}`
              : `The video card shows "${v.title ?? v.video_id}" (${v.video_id}) version ${v.latest_version} as ${status}.`,
        },
      ],
    })
    .catch(() => undefined)
}

app.addEventListener('toolresult', (result) => {
  const v = read(result)
  if (!v) return
  render(v)
  if (IN_PROGRESS.includes(statusOf(v))) void follow()
})
app.addEventListener('hostcontextchanged', (ctx) => {
  applyContext(ctx)
  if (current && 'availableDisplayModes' in ctx) render(current)
})
app.onteardown = async () => {
  current = null
  return {}
}

void app.connect().then(() => applyContext(app.getHostContext()))
