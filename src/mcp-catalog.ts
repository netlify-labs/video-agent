// The MCP tools and prompts in plain words, for the API docs page (ui/src/pages/docs). No imports, so the UI can
// bundle it. test/mcp-catalog.test.ts lists what buildMcpServer registers for each role and checks it against this,
// so a tool added to src/mcp.ts without a line here fails the tests.

/** Who sees an entry: tools and prompts follow the caller's role, and planning also needs AI Gateway. */
export type McpAccess = 'everyone' | 'reviewers' | 'creators' | 'planning'

export interface McpCatalogEntry {
  name: string
  summary: string
  access: McpAccess
}

export const MCP_ACCESS_LABELS: Record<McpAccess, string> = {
  everyone: 'Everyone',
  reviewers: 'Reviewers and up',
  creators: 'Creators and admins',
  planning: 'Creators and admins, with AI Gateway',
}

export const MCP_TOOLS: readonly McpCatalogEntry[] = [
  {
    name: 'create_video',
    summary:
      'Start a new video from a prompt (aspect, length, media and sound optional). Returns at once; ready in 3 to 8 minutes.',
    access: 'creators',
  },
  {
    name: 'get_video',
    summary:
      'Status, versions, signed download URLs (1 hour) and public links. Can wait up to 8 seconds for a change.',
    access: 'everyone',
  },
  {
    name: 'show_video',
    summary:
      'Show a video in the chat: live progress while it’s made, then a player (in clients that show MCP Apps).',
    access: 'everyone',
  },
  {
    name: 'list_videos',
    summary: 'Find videos by words in their prompt or title, yours or everyone’s.',
    access: 'everyone',
  },
  {
    name: 'revise_video',
    summary: 'Make the next version, changing only what you describe.',
    access: 'creators',
  },
  {
    name: 'publish_video',
    summary: 'Public share page, MP4, GIF and embed snippet for a ready version.',
    access: 'creators',
  },
  { name: 'unpublish_video', summary: 'Take a public link down.', access: 'creators' },
  { name: 'cancel_video', summary: 'Stop the version in progress.', access: 'everyone' },
  {
    name: 'set_verdict',
    summary: 'Approve a version or request changes (not on your own version).',
    access: 'reviewers',
  },
  {
    name: 'list_comments',
    summary: 'Read the feedback on a video, oldest first, with pinned times and positions.',
    access: 'everyone',
  },
  {
    name: 'add_comment',
    summary: 'Leave feedback on a version, optionally pinned to a moment. The owner is notified.',
    access: 'reviewers',
  },
  {
    name: 'list_media',
    summary: 'The team’s logos, screenshots, clips, fonts and music, to pass as media_ids.',
    access: 'everyone',
  },
  {
    name: 'search_music',
    summary: 'Find openly licensed music on Openverse (CC0 and CC BY only), with listen links.',
    access: 'creators',
  },
  {
    name: 'import_music',
    summary: 'Import a track from search_music into the media library and get its media id.',
    access: 'creators',
  },
  {
    name: 'get_music_job',
    summary: 'Check a music search or import that answered “pending” because Openverse was slow.',
    access: 'creators',
  },
  {
    name: 'plan_video',
    summary: 'Optional: a few multiple-choice questions to plan the video first.',
    access: 'planning',
  },
  {
    name: 'plan_brief',
    summary: 'Turns the answers into a brief; pass its plan_id to create_video or revise_video.',
    access: 'planning',
  },
]

/** The netlify-video skill's recipes as MCP prompts (src/mcp-prompts.ts). */
export const MCP_PROMPTS: readonly McpCatalogEntry[] = [
  {
    name: 'pr_video',
    summary: 'Pull request → demo or launch video: reads the diff and screenshots, writes a brief, creates.',
    access: 'creators',
  },
  {
    name: 'changelog_video',
    summary: 'Release notes → changelog video, one beat per change.',
    access: 'creators',
  },
  { name: 'social_cut', summary: 'A 15-second vertical cut of an existing video.', access: 'creators' },
  {
    name: 'localize_video',
    summary: 'Captions and on-screen text in other languages, one revision each.',
    access: 'creators',
  },
  {
    name: 'review_video',
    summary: 'Read and add feedback, approve or request changes, and revise with it.',
    access: 'reviewers',
  },
]
