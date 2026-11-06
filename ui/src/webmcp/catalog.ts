// The WebMCP tools in plain words, per page, for /docs/webmcp. ui/e2e/webmcp.spec.ts checks each page registers exactly
// these, so a tool added to a page without a line here fails the tests.

export type WebMcpPage = 'every page' | 'library' | 'new video' | 'video' | 'editor'
export type WebMcpKind = 'read' | 'act' | 'confirm'

export interface WebMcpCatalogEntry {
  name: string
  page: WebMcpPage
  /** read: changes nothing; act: changes what's on screen or saves a draft or comment; confirm: the person clicks first. */
  kind: WebMcpKind
  summary: string
}

export const WEBMCP_TOOLS: readonly WebMcpCatalogEntry[] = [
  {
    name: 'get_page',
    page: 'every page',
    kind: 'read',
    summary: 'Which page is open, with its video and version.',
  },
  {
    name: 'navigate',
    page: 'every page',
    kind: 'act',
    summary: 'Open another page: library, new video, a video, the editor, media, admin, setup or docs.',
  },
  {
    name: 'list_videos',
    page: 'library',
    kind: 'read',
    summary: "Search and filter the library (the page's own search box and filters change too).",
  },
  { name: 'open_video', page: 'library', kind: 'act', summary: "Open a video's page." },
  {
    name: 'fill_video_form',
    page: 'new video',
    kind: 'act',
    summary:
      'Fill the New video form (prompt, shape, length, title, look, sound, voice-over) without creating.',
  },
  {
    name: 'create_video',
    page: 'new video',
    kind: 'confirm',
    summary: 'Create the video; it spends credits.',
  },
  {
    name: 'get_video',
    page: 'video',
    kind: 'read',
    summary: 'The video, its versions (prompt, length, scenes, public or not) and which one is on screen.',
  },
  { name: 'list_comments', page: 'video', kind: 'read', summary: 'Comments on the video or one version.' },
  { name: 'show_version', page: 'video', kind: 'act', summary: 'Show another version.' },
  { name: 'control_player', page: 'video', kind: 'act', summary: 'Play, pause or seek the player.' },
  { name: 'add_comment', page: 'video', kind: 'act', summary: 'Comment, pinned to a moment if you like.' },
  {
    name: 'revise_video',
    page: 'video',
    kind: 'confirm',
    summary: 'Make the next version from a change in plain words; it spends credits.',
  },
  {
    name: 'restyle_video',
    page: 'video',
    kind: 'confirm',
    summary: 'Make the next version in another look; it spends credits.',
  },
  {
    name: 'remix_video',
    page: 'video',
    kind: 'confirm',
    summary: 'Make a new video from this one; it spends credits.',
  },
  {
    name: 'publish_video',
    page: 'video',
    kind: 'confirm',
    summary: 'Publish a version on a public share page.',
  },
  { name: 'unpublish_video', page: 'video', kind: 'confirm', summary: "Take a version's share page down." },
  {
    name: 'list_scenes',
    page: 'editor',
    kind: 'read',
    summary: "The draft's scenes, lengths and on-screen words.",
  },
  { name: 'edit_text', page: 'editor', kind: 'act', summary: 'Change the words of one text field.' },
  { name: 'set_scene_duration', page: 'editor', kind: 'act', summary: "Set a scene's length." },
  { name: 'reorder_scenes', page: 'editor', kind: 'act', summary: 'Put the scenes in a new order.' },
  { name: 'delete_scene', page: 'editor', kind: 'confirm', summary: 'Delete a scene from the draft.' },
  { name: 'seek', page: 'editor', kind: 'act', summary: 'Move the playhead and the preview.' },
  { name: 'select_clip', page: 'editor', kind: 'act', summary: 'Select a clip on the narration timeline.' },
  { name: 'undo', page: 'editor', kind: 'act', summary: "Undo the timeline's last change." },
  { name: 'redo', page: 'editor', kind: 'act', summary: "Redo the timeline's last undone change." },
  {
    name: 'render_edit',
    page: 'editor',
    kind: 'confirm',
    summary: 'Render the draft as the next version; it spends credits.',
  },
]

export const WEBMCP_KIND_LABELS: Record<WebMcpKind, string> = {
  read: 'Reads',
  act: 'Acts on the page',
  confirm: 'Asks you first',
}
