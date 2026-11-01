// MCP prompts: the netlify-video skill's recipes (skills/netlify-video/references/recipes.md) for clients without
// skills. Each returns one user message that walks the agent through the tool flow. Like the tools, the list shows
// only what the caller's role can do.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

export interface PromptAccess {
  /** create_video and revise_video are listed. */
  create: boolean
  /** add_comment and set_verdict are listed. */
  review: boolean
  /** plan_video and plan_brief are listed. */
  planning: boolean
}

const message = (text: string) => ({
  messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }],
})

const CONFIRM =
  'Each create or revise starts a run that costs credits, so show me the prompt, aspect and length and wait for my go-ahead before calling it.'
const FOLLOW =
  'Then follow it with get_video (wait_seconds: 8) about once a minute, telling me what the agent is doing, until it is ready or failed. When it is ready, give me the web_url.'

function plan(access: PromptAccess) {
  return access.planning
    ? ' If the request still feels open, call plan_video with the prompt (and media_ids), ask me its questions, call plan_brief with my answers, show me the brief, and pass plan_id along.'
    : ''
}

export function registerPrompts(server: McpServer, access: PromptAccess) {
  const prPrompt = server.registerPrompt(
    'pr_video',
    {
      title: 'Pull request → demo or launch video',
      description:
        'Read a pull request (diff, description, screenshots) and make a demo or launch video of it.',
      argsSchema: {
        pr_url: z.string().describe('The pull request URL.'),
        audience: z
          .string()
          .optional()
          .describe('Who the video is for (default: people who use the product).'),
        aspect: z.string().optional().describe('16:9 (default), 9:16, 1:1 or 4:5.'),
      },
    },
    (a) =>
      message(
        [
          `Make a demo video of the pull request ${a.pr_url} with the video agent, for ${a.audience ?? 'people who use the product'}.`,
          '1. Read the PR: title, description, linked issues, the diff and any screenshots (for example `gh pr view` and `gh pr diff`). Work out what users can do now that they could not before, and the one or two screens that show it. Leave out refactors, tests and internals.',
          '2. Check list_media for the logo and product shots. If the PR has screenshots and you have an API key, upload them to the media library (POST /api/v1/media, see the API docs) with a caption each, and keep their ids for media_ids.',
          `3. Write a prompt: who it is for, the one message, three or four beats, exact on-screen text in quotes, and an end card.${plan(access)}`,
          `4. ${CONFIRM} Call create_video with the prompt, aspect ${a.aspect ?? '16:9'}, duration_sec 20 to 45, media_ids, and the PR URL as idempotency_key.`,
          `5. ${FOLLOW} Offer publish_video for a share page or GIF to paste into the PR.`,
        ].join('\n'),
      ),
  )

  const changelogPrompt = server.registerPrompt(
    'changelog_video',
    {
      title: 'Release notes → changelog video',
      description: 'Turn release notes or a changelog section into a short changelog video.',
      argsSchema: {
        notes: z.string().describe('The release notes text, or a URL to them.'),
        version: z.string().optional().describe('The release name or version, for the title.'),
        aspect: z.string().optional().describe('16:9 (default), 1:1 for social feeds, 9:16 or 4:5.'),
      },
    },
    (a) =>
      message(
        [
          `Make a changelog video${a.version ? ` for ${a.version}` : ''} with the video agent from these release notes:`,
          '',
          a.notes,
          '',
          '1. Pick the three to five changes a user would notice. Each becomes one beat with a short headline in quotes, and a screenshot from list_media if there is one.',
          `2. Write a prompt: an opening title, one beat per change, ending on the product URL or a call to action, 30 to 60 seconds.${plan(access)}`,
          `3. ${CONFIRM} Call create_video with the prompt, a title, media_ids and aspect ${a.aspect ?? '16:9'}.`,
          `4. ${FOLLOW} When I approve it, publish_video for a share page or embed for the release notes.`,
        ].join('\n'),
      ),
  )

  const socialPrompt = server.registerPrompt(
    'social_cut',
    {
      title: 'Long video → short vertical social cut',
      description: 'Make a 15-second vertical cut of an existing video for social feeds.',
      argsSchema: {
        video_id: z.string().describe('The long video (vid_… or its link).'),
        duration_sec: z.string().optional().describe('Length of the cut in seconds (default 15).'),
        aspect: z.string().optional().describe('9:16 (default), 1:1 or 4:5.'),
      },
    },
    (a) =>
      message(
        [
          `Make a ${a.duration_sec ?? '15'}-second ${a.aspect ?? '9:16'} social cut of the video ${a.video_id}. Aspect is fixed per video, so the cut is a new video.`,
          '1. Call get_video on it and read the latest ready version: its prompt, output.summary and title.',
          '2. Pick the single strongest message. A short cut holds one idea and an end card.',
          `3. ${CONFIRM} Call create_video with aspect ${a.aspect ?? '9:16'}, duration_sec ${a.duration_sec ?? '15'}, the media the long video used (as media_ids, from list_media), and a prompt saying it is a social cut of that video: the hook in the first two seconds, large captions that read without sound, and the same end card.`,
          `4. ${FOLLOW} For small changes, revise_video the cut instead of creating another.`,
        ].join('\n'),
      ),
  )

  const localizePrompt = server.registerPrompt(
    'localize_video',
    {
      title: 'Localise captions and on-screen text',
      description: 'Translate a video’s captions and on-screen text into other languages, one revision each.',
      argsSchema: {
        video_id: z.string().describe('The video (vid_… or its link).'),
        languages: z
          .string()
          .describe('Languages, comma-separated (for example "German, French, Japanese").'),
        from_version: z
          .string()
          .optional()
          .describe('The version to translate from (default: latest ready).'),
      },
    },
    (a) => {
      const langs = a.languages
        .split(',')
        .map((l) => l.trim())
        .filter(Boolean)
      return message(
        [
          `Localise the video ${a.video_id} into ${langs.join(', ')}.`,
          `1. Call get_video and note the base version (${a.from_version ? `version ${a.from_version}` : 'the latest ready one'}). Ask me whether names, product terms and the URL stay as they are.`,
          `2. ${CONFIRM} That is ${langs.length} run${langs.length === 1 ? '' : 's'}, one per language.`,
          '3. For each language in turn, call revise_video with from_version set to the base and a change like: "Translate every caption and on-screen text into <language>. Keep timing, layout, names and the URL. Shorten lines that no longer fit rather than shrinking the type."',
          '4. Only one version can be in progress, so wait for each with get_video (wait_seconds: 8) before starting the next. Keep track of which version is which language.',
          '5. Give me each version with its language, and offer publish_video with version for each.',
        ].join('\n'),
      )
    },
  )

  const reviewPrompt = server.registerPrompt(
    'review_video',
    {
      title: 'Review a video and its feedback',
      description:
        'Read the comments on a video, add your own, record a verdict and (if you can) revise with them.',
      argsSchema: {
        video_id: z.string().describe('The video (vid_… or its link).'),
        version: z.string().optional().describe('The version to review (default: the latest ready one).'),
      },
    },
    (a) =>
      message(
        [
          `Review the video ${a.video_id}${a.version ? `, version ${a.version}` : ''}.`,
          '1. Call get_video for its versions and the MP4, and list_comments for the feedback. Open comments have no resolved_at; pinned ones have time_sec.',
          '2. Summarise the open feedback for me. Suggest your own points, and after I agree add each with add_comment (one comment per point, saying what to change and why, pinned with time_sec when it is about a moment).',
          '3. Ask me for a verdict and record it with set_verdict: "approved" or "changes_requested", with a short note. Nobody can review their own version.',
          ...(access.create
            ? [
                `4. To act on the feedback (the owner or an admin only): ${CONFIRM} Then call revise_video with the comment_ids to incorporate and a change that summarises them. ${FOLLOW}`,
              ]
            : []),
        ].join('\n'),
      ),
  )

  if (!access.create) for (const p of [prPrompt, changelogPrompt, socialPrompt, localizePrompt]) p.remove()
  if (!access.review) reviewPrompt.remove()
}
