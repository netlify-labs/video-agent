// The WebMCP tools every signed-in page offers (va-qago): where the person is, and moving to another page. Each page
// then registers its own tools while it's open, so after navigate an agent asks the browser for the tools again.
import { useLocation, useNavigate } from 'react-router'
import { fail, ok } from './tools'
import { useWebMcpTool } from './useWebMcpTool'

const PAGES = ['library', 'new_video', 'video', 'editor', 'media', 'admin', 'setup', 'docs'] as const
type PageName = (typeof PAGES)[number]

/** The page a path is, with its video and version when it has them. */
export function pageOf(pathname: string): { page: PageName | 'other'; video_id?: string; version?: number } {
  const edit = /^\/videos\/([^/]+)\/edit\/(\d+)/.exec(pathname)
  if (edit?.[1]) return { page: 'editor', video_id: edit[1], version: Number(edit[2]) }
  const video = /^\/videos\/([^/]+)/.exec(pathname)
  if (video?.[1]) return { page: 'video', video_id: video[1] }
  if (pathname === '/') return { page: 'library' }
  if (pathname === '/new') return { page: 'new_video' }
  for (const p of ['media', 'admin', 'setup'] as const) if (pathname.startsWith(`/${p}`)) return { page: p }
  if (pathname.startsWith('/docs')) return { page: 'docs' }
  return { page: 'other' }
}

const VIDEO_ID = { type: 'string', description: 'A video id (vid_…).', minLength: 3, maxLength: 64 } as const

export function WebMcpGlobalTools() {
  const { pathname } = useLocation()
  const navigate = useNavigate()

  useWebMcpTool<Record<string, never>>({
    name: 'get_page',
    title: 'Get the current page',
    kind: 'read',
    description:
      "Which page of Video Agent the person has open (library, new_video, video, editor, media, admin, setup, docs), with the video id and version when there is one. Each page offers its own tools: after moving to another page, list the page's tools again.",
    input: { type: 'object', properties: {}, additionalProperties: false },
    run: () => ok({ ...pageOf(pathname), path: pathname, title: document.title }),
  })

  useWebMcpTool<{ page: PageName; video_id?: string; version?: number }>({
    name: 'navigate',
    title: 'Open a page',
    kind: 'act',
    description:
      "Open a page of Video Agent in this tab: library, new_video, video (needs video_id), editor (needs video_id and version), media, admin, setup or docs. The page's own tools appear once it has loaded.",
    input: {
      type: 'object',
      properties: {
        page: { type: 'string', enum: PAGES },
        video_id: VIDEO_ID,
        version: { type: 'integer', minimum: 1, description: 'The version to edit (editor only).' },
      },
      required: ['page'],
      additionalProperties: false,
    },
    run: async ({ page, video_id, version }) => {
      if ((page === 'video' || page === 'editor') && !video_id)
        return fail(
          'invalid_input',
          `${page} needs video_id.`,
          'Find one with list_videos on the library page.',
        )
      if (page === 'editor' && !version)
        return fail(
          'invalid_input',
          'editor needs version.',
          'Use get_video on the video page to see its versions.',
        )
      const to: Record<PageName, string> = {
        library: '/',
        new_video: '/new',
        video: `/videos/${encodeURIComponent(video_id ?? '')}`,
        editor: `/videos/${encodeURIComponent(video_id ?? '')}/edit/${String(version ?? 1)}`,
        media: '/media',
        admin: '/admin',
        setup: '/setup',
        docs: '/docs',
      }
      await navigate(to[page])
      return ok({ page, path: to[page] })
    },
  })
  return null
}
