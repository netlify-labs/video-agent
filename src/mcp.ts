// MCP server: lets people make videos from their AI tools (Claude, Cursor, any MCP client).
// Stateless Streamable HTTP at /api/mcp (alias /mcp), authenticated with the same API keys as the REST API.
// Seven tools; inputs are forgiving (aspect names, "30s", pasted URLs) and every result says what to do next.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import type { Deps } from './deps.js'
import { PRIVATE_URL_TTL_SEC, signedFilePath } from './domain/files.js'
import { addComment, listComments } from './domain/comments.js'
import { getProgress } from './domain/progress.js'
import { listMedia } from './domain/media.js'
import * as planning from './domain/plans.js'
import { can, type Principal } from './domain/policy.js'
import type { Aspect } from './domain/types.js'
import {
  cancelVersion,
  createVideo,
  listVideos,
  setVerdict,
  publishVersion,
  reviseVideo,
  unpublishVersion,
  videoDto,
  type VideoDto,
} from './domain/videos.js'
import { ApiError } from './lib/errors.js'

const SERVER_INSTRUCTIONS = `Make short videos from a prompt. Each video is made by an AI agent with HyperFrames (HTML/CSS/GSAP rendered to MP4) and takes 3 to 8 minutes.

Typical flow:
1. create_video with a prompt (quote any exact on-screen text). It returns immediately with status "queued".
2. get_video with the id every minute or so (wait_seconds up to 8 to wait in one call) until status is "ready" or "failed".
3. When ready, the result has signed download URLs (valid 1 hour) and the web page for the video.
4. revise_video to change something ("make the end card orange"); it creates the next version from the latest ready one.
5. publish_video to get a public share page, MP4 URL and embed snippet.

Optional planning (when plan_video is listed): call plan_video with the prompt first. If it returns questions, ask your user (they can skip any), then call plan_brief with their answers, show the brief, and pass plan_id to create_video (or revise_video). Skip planning when the request is already specific.

Videos are silent, with captions. The company's brand context is applied automatically. Don't create a new video to fix a small thing: revise it.`

// ───────────── forgiving inputs ─────────────

const ASPECT_ALIASES: Record<string, Aspect> = {
  '16:9': '16:9',
  '16x9': '16:9',
  '169': '16:9',
  landscape: '16:9',
  horizontal: '16:9',
  wide: '16:9',
  widescreen: '16:9',
  youtube: '16:9',
  '9:16': '9:16',
  '9x16': '9:16',
  '916': '9:16',
  vertical: '9:16',
  story: '9:16',
  stories: '9:16',
  reel: '9:16',
  reels: '9:16',
  shorts: '9:16',
  tiktok: '9:16',
  '1:1': '1:1',
  '1x1': '1:1',
  '11': '1:1',
  square: '1:1',
  '4:5': '4:5',
  '4x5': '4:5',
  '45': '4:5',
  portrait: '4:5',
  feed: '4:5',
  instagram: '4:5',
  linkedin: '4:5',
}

export function normalizeAspect(v: string | undefined): Aspect | undefined {
  if (v === undefined || v.trim() === '') return undefined
  const key = v.trim().toLowerCase().replace(/\s+/g, '')
  const hit = ASPECT_ALIASES[key]
  if (!hit) {
    throw new ToolError('INVALID_ARGUMENT', `Unknown aspect "${v}".`, {
      fix_hint: 'Use one of 16:9 (landscape), 9:16 (vertical), 1:1 (square) or 4:5 (portrait).',
      available_options: ['16:9', '9:16', '1:1', '4:5'],
    })
  }
  return hit
}

export function normalizeDuration(v: string | number | undefined): number | undefined {
  if (v === undefined || v === '' || (typeof v === 'string' && /^(auto|any|default)$/i.test(v.trim())))
    return undefined
  if (typeof v === 'number') return Math.round(v)
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?)?\s*$/i.exec(v)
  if (!m?.[1]) {
    throw new ToolError('INVALID_ARGUMENT', `Can't read duration "${v}".`, {
      fix_hint: 'Give seconds as a number (30), or "30s", "2 min", or leave it out for Auto.',
    })
  }
  const n = Number(m[1])
  return Math.round(/^m/i.test(m[2] ?? '') ? n * 60 : n)
}

/** Accepts vid_… ids, web app URLs (/videos/vid_…) and API URLs. */
export function normalizeVideoId(v: string): string {
  const m = /vid_[a-z0-9]+/i.exec(v.trim())
  if (!m) {
    throw new ToolError('INVALID_ARGUMENT', `"${v}" is not a video id.`, {
      fix_hint: 'Video ids look like vid_01jc8x2k4m5n6p7q8r9s0t1v2w. Use list_videos to find one.',
      suggested_tool_calls: [{ name: 'list_videos', arguments: {} }],
    })
  }
  return m[0].toLowerCase()
}

// ───────────── errors ─────────────

class ToolError extends Error {
  constructor(
    readonly type: string,
    message: string,
    readonly data: Record<string, unknown> = {},
    readonly recoverable = true,
  ) {
    super(message)
  }
}

function fromApiError(e: ApiError, videoId?: string): ToolError {
  const byCode: Record<string, [string, Record<string, unknown>]> = {
    not_found: [
      'NOT_FOUND',
      {
        fix_hint: 'Check the id, or find the video with list_videos.',
        suggested_tool_calls: [{ name: 'list_videos', arguments: {} }],
      },
    ],
    forbidden: ['FORBIDDEN', { fix_hint: "Only the video's owner or an admin can do this." }],
    conflict: [
      'CONFLICT',
      videoId
        ? {
            fix_hint: 'Wait for the version in progress to finish, then try again.',
            suggested_tool_calls: [{ name: 'get_video', arguments: { video_id: videoId, wait_seconds: 8 } }],
          }
        : {},
    ],
    not_ready: [
      'NOT_READY',
      videoId ? { suggested_tool_calls: [{ name: 'get_video', arguments: { video_id: videoId } }] } : {},
    ],
    setup_required: [
      'SETUP_REQUIRED',
      { fix_hint: 'An admin needs to finish setup at /setup before videos can be made.' },
    ],
    invalid_request: ['INVALID_ARGUMENT', {}],
    unauthorized: [
      'UNAUTHORIZED',
      {
        fix_hint:
          'The API key is missing, revoked or its owner was removed. Create a new key in the web app.',
      },
    ],
  }
  const [type, data] = byCode[e.code] ?? ['ERROR', {}]
  return new ToolError(
    type,
    e.message,
    { ...data, ...(e.details ? { details: e.details } : {}) },
    e.code !== 'unauthorized',
  )
}

type ToolResult = {
  content: { type: 'text'; text: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

function ok(body: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body }
}

async function run(fn: () => Promise<Record<string, unknown>>, videoId?: string): Promise<ToolResult> {
  try {
    return ok(await fn())
  } catch (e) {
    const err =
      e instanceof ToolError
        ? e
        : e instanceof ApiError
          ? fromApiError(e, videoId)
          : new ToolError('INTERNAL', 'Something went wrong. Try again in a moment.', {}, true)
    const body = {
      error: { type: err.type, message: err.message, recoverable: err.recoverable, data: err.data },
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
      structuredContent: body,
      isError: true,
    }
  }
}

// ───────────── results shaped for agents ─────────────

async function summarize(deps: Deps, v: VideoDto) {
  const job = (await deps.store.getJob(v.id)) ?? { id: v.id, private: v.private, accessEpoch: 0 }
  const ttl = v.private ? PRIVATE_URL_TTL_SEC : 3600
  const ready = v.versions.find((x) => x.status === 'ready')
  const latest = v.versions[0]
  const versions = await Promise.all(
    v.versions.map(async (x) => ({
      version: x.n,
      status: x.status,
      prompt: x.prompt,
      from_version: x.parentN,
      ...(x.error ? { error: x.error } : {}),
      ...(x.latestStep && x.status !== 'ready' ? { agent_activity: x.latestStep } : {}),
      ...(x.output
        ? {
            output: {
              duration_sec: Math.round(x.output.durationSec * 10) / 10,
              width: x.output.width,
              height: x.output.height,
              bytes: x.output.bytes,
              summary: x.output.summary,
            },
            downloads: {
              mp4: `${deps.config.siteUrl}${await signedFilePath(deps, job, x.n, 'video', ttl, true)}`,
              poster: `${deps.config.siteUrl}${await signedFilePath(deps, job, x.n, 'poster', ttl)}`,
              gif: `${deps.config.siteUrl}${await signedFilePath(deps, job, x.n, 'gif', ttl)}`,
              captions: `${deps.config.siteUrl}${await signedFilePath(deps, job, x.n, 'captions', ttl)}`,
              expires_in_sec: ttl,
            },
          }
        : {}),
      ...(x.publications.some((p) => p.urls) ? { public: x.publications.find((p) => p.urls) } : {}),
      credits: x.usage?.totalCreditsCost ?? null,
    })),
  )
  const next: string[] = []
  if (latest && ['queued', 'running', 'finishing'].includes(latest.status)) {
    next.push(
      `Version ${latest.n} is ${latest.status}. Call get_video with video_id "${v.id}" again in about a minute (wait_seconds: 8 waits in this call).`,
    )
  } else if (latest?.status === 'ready') {
    next.push(
      'Share the downloads.mp4 URL, or call publish_video for a permanent public link and embed snippet.',
    )
    next.push('To change something, call revise_video with what should change; it keeps everything else.')
  } else if (latest) {
    next.push(
      latest.error?.category === 'needs_input'
        ? 'The agent needed more detail. Call revise_video or create_video with a more specific prompt.'
        : `Version ${latest.n} ${latest.status}. Try again with create_video or revise_video, or open the web page for details.`,
    )
  }
  return {
    video_id: v.id,
    title: v.title,
    status: v.status,
    aspect: v.aspect,
    web_url: `${deps.config.siteUrl}/videos/${v.id}`,
    latest_version: v.latestVersion,
    ready_version: ready?.n ?? null,
    created_at: v.createdAt,
    versions,
    next_actions: next,
  }
}

// ───────────── server ─────────────

export function buildMcpServer(deps: Deps, principal: Principal, kick: () => void): McpServer {
  const server = new McpServer(
    { name: 'video-agent', version: '1.0.0' },
    { instructions: SERVER_INSTRUCTIONS },
  )
  const load = (id: string) => videoDto(deps.store, deps, id, principal)

  const createTool = server.registerTool(
    'create_video',
    {
      title: 'Create a video',
      description: `Start making a new video from a prompt. Returns at once with status "queued"; the video is ready in 3 to 8 minutes.

When to use: the user wants a new video. NOT for changing an existing video (use revise_video).

Do: say who it's for, the one message, any exact on-screen words in quotes, and how it ends (end card, call to action).
Don't: call it again for the same request while one is in progress; poll with get_video instead.

Example: {"prompt": "A 20-second launch video for our new webhooks feature, ending with \\"Available today\\"", "aspect": "16:9"}`,
      inputSchema: {
        prompt: z
          .string()
          .min(10)
          .max(4000)
          .describe('What the video should show. Quote exact on-screen text.'),
        aspect: z
          .string()
          .optional()
          .describe(
            '16:9 (landscape, default), 9:16 (vertical), 1:1 (square) or 4:5 (portrait). Names like "vertical" work.',
          ),
        duration_sec: z
          .union([z.number(), z.string()])
          .optional()
          .describe('Target length in seconds ("30s", "2 min" work). Leave out to let the agent choose.'),
        title: z.string().max(120).optional().describe('Optional title. The agent names it otherwise.'),
        plan_id: z
          .string()
          .optional()
          .describe('Optional. A plan from plan_video + plan_brief; its brief is added to the run.'),
        media_ids: z
          .array(z.string())
          .max(12)
          .optional()
          .describe('Optional. Library items (from list_media) to use: logos, screenshots, clips, fonts.'),
        idempotency_key: z
          .string()
          .max(200)
          .optional()
          .describe('Optional. Reusing the same key returns the same video instead of a duplicate.'),
      },
      annotations: {
        title: 'Create a video',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (args) =>
      run(async () => {
        const res = await createVideo(
          deps,
          principal,
          {
            prompt: args.prompt,
            aspect: normalizeAspect(args.aspect),
            durationSec: normalizeDuration(args.duration_sec),
            title: args.title,
            planId: args.plan_id,
            mediaIds: args.media_ids,
          },
          args.idempotency_key,
        )
        if (!res.replayed) kick()
        return {
          ...(await summarize(deps, res.body)),
          next_actions: [
            `Call get_video with video_id "${res.body.id}" in about a minute. It usually takes 3 to 8 minutes.`,
          ],
        }
      }),
  )

  server.registerTool(
    'get_video',
    {
      title: 'Get a video',
      description: `Get a video's status, versions, download URLs (signed, valid 1 hour) and public links.

When to use: to check progress after create_video or revise_video, or to fetch download links.
wait_seconds (0-8) waits in this call for the status to change, so you can poll less often.

Example: {"video_id": "vid_01jc8x2k4m5n6p7q8r9s0t1v2w", "wait_seconds": 8}`,
      inputSchema: {
        video_id: z.string().describe('The video id (vid_…) or its web URL.'),
        wait_seconds: z
          .number()
          .min(0)
          .max(8)
          .optional()
          .describe('Wait up to this many seconds for a change in status (max 8).'),
      },
      annotations: { title: 'Get a video', readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        const id = normalizeVideoId(args.video_id)
        let v = await load(id)
        const until = Date.now() + Math.min(args.wait_seconds ?? 0, 8) * 1000
        const start = v.etag
        while (Date.now() < until && ['queued', 'running', 'finishing'].includes(v.status)) {
          await new Promise((r) => setTimeout(r, 2000))
          v = await load(id)
          if (v.etag !== start) break
        }
        const summary = await summarize(deps, v)
        if (!['queued', 'running', 'finishing'].includes(v.status)) return summary
        // Live progress for a version in progress (plan v2 §6).
        const p = await getProgress(deps, principal, id)
        return {
          ...summary,
          progress: {
            version: p.versionN,
            stage: p.stage,
            step: p.step,
            steps: p.steps,
            credits: p.credits,
            observed_at: p.observedAt,
            stale: p.stale,
          },
        }
      }, args.video_id),
  )

  server.registerTool(
    'list_videos',
    {
      title: 'List videos',
      description: `List videos, newest first, with a short summary of each. Search matches prompts and titles.

When to use: to find a video id, or to see what's been made. Use get_video for details and downloads.

Example: {"query": "webhooks", "mine": true, "limit": 10}`,
      inputSchema: {
        query: z.string().max(200).optional().describe('Words to search for in prompts and titles.'),
        mine: z.boolean().optional().describe('Only videos made with your account.'),
        status: z
          .enum(['queued', 'running', 'finishing', 'ready', 'failed', 'cancelled', 'timed_out'])
          .optional(),
        limit: z.number().int().min(1).max(25).optional().describe('How many to return (default 10).'),
      },
      annotations: { title: 'List videos', readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        const res = await listVideos(deps, principal, {
          owner: args.mine ? 'me' : 'all',
          ...(args.query ? { q: args.query } : {}),
          ...(args.status ? { status: args.status } : {}),
          limit: args.limit ?? 10,
        })
        return {
          videos: res.items.map((v) => ({
            video_id: v.id,
            title: v.title,
            status: v.status,
            aspect: v.aspect,
            versions: v.versions.length,
            prompt: v.versions[0]?.prompt.slice(0, 200),
            owner: v.owner.name ?? v.owner.email,
            created_at: v.createdAt,
            public: v.published,
            web_url: `${deps.config.siteUrl}/videos/${v.id}`,
          })),
          more: res.nextCursor !== null,
          next_actions: ['Call get_video with a video_id for its status and download URLs.'],
        }
      }),
  )

  const reviseTool = server.registerTool(
    'revise_video',
    {
      title: 'Revise a video',
      description: `Make the next version of a video from a ready version, changing only what you describe. Returns at once; ready in a few minutes.

When to use: the user wants a change to an existing video ("make the end card orange", "shorter", "add our URL").
Don't: describe the whole video again; describe the change. Only one version per video can be in progress.
Incorporate feedback: pass comment_ids (from list_comments; open comments on from_version) and use change for your note. Only the video's owner or an admin can.

Example: {"video_id": "vid_01jc8x2k4m5n6p7q8r9s0t1v2w", "change": "Make the end card say \\"Start free today\\""}`,
      inputSchema: {
        video_id: z.string().describe('The video id (vid_…) or its web URL.'),
        change: z.string().min(3).max(4000).describe('What should change. Everything else stays.'),
        plan_id: z
          .string()
          .optional()
          .describe('Optional. A revision plan from plan_video (with video_id) + plan_brief.'),
        from_version: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Which ready version to start from (default: the latest ready one).'),
        duration_sec: z
          .union([z.number(), z.string()])
          .optional()
          .describe('A new target length, if it should change.'),
        comment_ids: z
          .array(z.string())
          .max(50)
          .optional()
          .describe('Optional. Comments to incorporate (owner or admin), from list_comments.'),
        media_ids: z
          .array(z.string())
          .max(12)
          .optional()
          .describe(
            'Optional. More library items (from list_media); the version keeps the media it revises.',
          ),
      },
      annotations: {
        title: 'Revise a video',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (args) =>
      run(async () => {
        const id = normalizeVideoId(args.video_id)
        const res = await reviseVideo(deps, principal, id, {
          prompt: args.change,
          fromVersion: args.from_version,
          planId: args.plan_id,
          durationSec: normalizeDuration(args.duration_sec),
          commentIds: args.comment_ids,
          mediaIds: args.media_ids,
        })
        if (!res.replayed) kick()
        return {
          ...(await summarize(deps, res.body)),
          next_actions: [
            `Call get_video with video_id "${id}" in about a minute to follow version ${res.body.latestVersion}.`,
          ],
        }
      }, args.video_id),
  )

  const publishTool = server.registerTool(
    'publish_video',
    {
      title: 'Publish a video',
      description: `Publish a ready version to a public link: a share page (with link previews for Slack and social), the MP4, a GIF and an embed snippet. Anyone with the link can watch it.

When to use: the user wants to share or embed the video publicly. For private sharing, use get_video's download URLs instead.
Only the video's owner or an admin can publish. Publishing a version that is already public returns its existing links.

Example: {"video_id": "vid_01jc8x2k4m5n6p7q8r9s0t1v2w"}`,
      inputSchema: {
        video_id: z.string().describe('The video id (vid_…) or its web URL.'),
        version: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Which version (default: the latest ready one).'),
      },
      annotations: {
        title: 'Publish a video',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args) =>
      run(async () => {
        const id = normalizeVideoId(args.video_id)
        const v = await load(id)
        const n = args.version ?? v.versions.find((x) => x.status === 'ready')?.n
        if (!n)
          throw new ToolError('NOT_READY', 'This video has no ready version yet.', {
            suggested_tool_calls: [{ name: 'get_video', arguments: { video_id: id, wait_seconds: 8 } }],
          })
        const pub = await publishVersion(deps, principal, id, n)
        return {
          video_id: id,
          version: n,
          ...pub,
          next_actions: [
            'Share urls.page (it unfurls in Slack and social), or paste embed into a page. unpublish_video takes it down.',
          ],
        }
      }, args.video_id),
  )

  const unpublishTool = server.registerTool(
    'unpublish_video',
    {
      title: 'Unpublish a video',
      description: `Take a version's public link down. It stops working on the next request; copies people already downloaded can't be recalled.

Example: {"video_id": "vid_01jc8x2k4m5n6p7q8r9s0t1v2w", "version": 2}`,
      inputSchema: {
        video_id: z.string().describe('The video id (vid_…) or its web URL.'),
        version: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Which version (default: whichever version is public).'),
      },
      annotations: {
        title: 'Unpublish a video',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args) =>
      run(async () => {
        const id = normalizeVideoId(args.video_id)
        const v = await load(id)
        const n = args.version ?? v.versions.find((x) => x.publications.some((p) => !p.unpublishedAt))?.n
        if (!n) return { video_id: id, unpublished: false, message: 'No version of this video is public.' }
        await unpublishVersion(deps, principal, id, n)
        return { video_id: id, version: n, unpublished: true }
      }, args.video_id),
  )

  server.registerTool(
    'cancel_video',
    {
      title: 'Cancel a video in progress',
      description: `Stop the version of a video that is queued or being made. Earlier versions are kept.

Example: {"video_id": "vid_01jc8x2k4m5n6p7q8r9s0t1v2w"}`,
      inputSchema: { video_id: z.string().describe('The video id (vid_…) or its web URL.') },
      annotations: {
        title: 'Cancel a video',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args) =>
      run(async () => {
        const id = normalizeVideoId(args.video_id)
        const v = await load(id)
        const busy = v.versions.find((x) => ['queued', 'running', 'finishing'].includes(x.status))
        if (!busy)
          return { video_id: id, cancelled: false, message: 'Nothing is in progress for this video.' }
        const after = await cancelVersion(deps, principal, id, busy.n)
        kick()
        return { ...(await summarize(deps, after)), cancelled: true }
      }, args.video_id),
  )

  const verdictTool = server.registerTool(
    'set_verdict',
    {
      title: 'Approve a version or request changes',
      description: `Record your review of a ready version: "approved" or "changes_requested", with an optional short note. Use null to clear your verdict. You can't review your own version.

Example: {"video_id": "vid_01jc8x2k4m5n6p7q8r9s0t1v2w", "version": 2, "verdict": "approved", "note": "Ship it"}`,
      inputSchema: {
        video_id: z.string().describe('Video id (vid_…) or a link to it.'),
        version: z.number().int().positive(),
        verdict: z.enum(['approved', 'changes_requested']).nullable(),
        note: z.string().max(500).optional(),
      },
    },
    async (args) =>
      run(async () => {
        const id = normalizeVideoId(args.video_id)
        const v = await setVerdict(deps, principal, id, args.version, {
          verdict: args.verdict,
          note: args.note,
        })
        return {
          video_id: v.id,
          version: args.version,
          verdicts: v.versions.find((x) => x.n === args.version)?.verdicts,
        }
      }, args.video_id),
  )

  server.registerTool(
    'list_comments',
    {
      title: 'List comments on a video',
      description: `Read the feedback people left on a video, oldest first. Pass version to see one version only. Pinned comments carry time_sec (seconds into the video) and x/y (0–1 across and down the frame). resolved_at is set once the owner marked it done; addressed_in is the version that took it into account.

Example: {"video_id": "vid_01jc8x2k4m5n6p7q8r9s0t1v2w", "version": 2}`,
      inputSchema: {
        video_id: z.string().describe('Video id (vid_…) or a link to it.'),
        version: z.number().int().positive().optional(),
        cursor: z.string().optional().describe('next_cursor from the previous page.'),
      },
      annotations: { title: 'List comments', readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      run(async () => {
        const id = normalizeVideoId(args.video_id)
        const page = await listComments(deps, principal, id, { versionN: args.version, cursor: args.cursor })
        return {
          video_id: id,
          comments: page.items.map((c) => ({
            id: c.id,
            version: c.versionN,
            author: c.author.name ?? c.author.email,
            body: c.body,
            time_sec: c.timeSec,
            x: c.x,
            y: c.y,
            created_at: c.createdAt,
            resolved_at: c.resolvedAt,
            addressed_in: c.addressedInN,
          })),
          next_cursor: page.nextCursor,
        }
      }, args.video_id),
  )

  server.registerTool(
    'list_media',
    {
      title: 'List the media library',
      description: `The team's uploaded media: logos, screenshots, clips and fonts, newest first. Pass media ids to create_video or revise_video (media_ids) so the agent uses them. A caption says what an item is.

Example: {"kind": "image"}`,
      inputSchema: {
        kind: z.enum(['image', 'svg', 'video', 'font']).optional(),
        cursor: z.string().optional().describe('next_cursor from the previous page.'),
      },
      annotations: { title: 'List media', readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      run(async () => {
        const page = await listMedia(deps, principal, { kind: args.kind, cursor: args.cursor })
        return {
          media: page.items
            .filter((m) => m.status === 'ready')
            .map((m) => ({
              id: m.id,
              kind: m.kind,
              filename: m.filename,
              caption: m.caption,
              width: m.width,
              height: m.height,
              duration_sec: m.durationSec,
            })),
          next_cursor: page.nextCursor,
        }
      }),
  )

  const addCommentTool = server.registerTool(
    'add_comment',
    {
      title: 'Comment on a version',
      description: `Leave feedback on one version of a video. Optionally pin it to a moment with time_sec (seconds from the start; the version must be ready). The video's owner is notified.

Do: say what to change and why ("The logo at 12s is too small to read"). Don't: post one comment per word; one comment per point.

Example: {"video_id": "vid_01jc8x2k4m5n6p7q8r9s0t1v2w", "version": 2, "body": "The CTA flashes by too fast", "time_sec": 27.5}`,
      inputSchema: {
        video_id: z.string().describe('Video id (vid_…) or a link to it.'),
        version: z.number().int().positive(),
        body: z.string().min(1).max(2000),
        time_sec: z.number().min(0).optional(),
      },
    },
    async (args) =>
      run(async () => {
        const id = normalizeVideoId(args.video_id)
        const c = await addComment(deps, principal, id, {
          versionN: args.version,
          body: args.body,
          timeSec: args.time_sec ?? null,
        })
        return { video_id: id, comment_id: c.id, version: c.versionN, time_sec: c.timeSec }
      }, args.video_id),
  )

  const planVideoTool = server.registerTool(
    'plan_video',
    {
      title: 'Plan a video with a few questions',
      description: `Optional first step before create_video (or revise_video). Reads the request and returns 0–6 multiple-choice questions whose answers would change the video. Ask your user these questions (they may skip any or give their own answer), then call plan_brief.

Pass video_id to plan a revision of an existing video; the questions are about the change. If "questions" is empty, call plan_brief with no answers.

Example: {"prompt": "A 30-second launch video for org webhooks, ending on our logo"}`,
      inputSchema: {
        prompt: z.string().min(10).max(4000).describe('The video request, as the user wrote it.'),
        aspect: z.string().optional().describe('16:9, 9:16, 1:1 or 4:5, if the user already chose one.'),
        duration_sec: z.union([z.number(), z.string()]).optional(),
        video_id: z.string().optional().describe('Plan a revision of this video instead of a new one.'),
        media_ids: z
          .array(z.string())
          .max(12)
          .optional()
          .describe(
            "Optional. Library items (from list_media) to plan around; the video made from the plan uses them, so don't pass them again.",
          ),
      },
    },
    async (args) =>
      run(async () => {
        const created = await planning.createPlan(deps, principal, {
          prompt: args.prompt,
          aspect: normalizeAspect(args.aspect),
          durationSec: normalizeDuration(args.duration_sec),
          ...(args.video_id ? { revisionOf: { videoId: normalizeVideoId(args.video_id) } } : {}),
          mediaIds: args.media_ids,
        })
        const plan = await planning.generateQuestions(deps, principal, created.id)
        return {
          plan_id: plan.id,
          suggested_aspect: plan.route?.suggestedAspect ?? null,
          questions: (plan.questions ?? []).map((q) => ({
            question_id: q.id,
            question: q.question,
            why: q.why,
            multi_select: q.multiSelect,
            allow_other: q.allowOther,
            choices: q.options.map((o) => ({ choice_id: o.id, label: o.label, description: o.description })),
          })),
          next_actions: [
            (plan.questions ?? []).length > 0
              ? 'Ask the user these questions (each can be skipped), then call plan_brief with plan_id and their answers.'
              : `The request covers it: call plan_brief with plan_id "${plan.id}" and no answers.`,
          ],
        }
      }),
  )
  const planBriefTool = server.registerTool(
    'plan_brief',
    {
      title: 'Turn the answers into a brief',
      description: `Second planning step. Send the user's answers to the plan_video questions (choice_ids and/or "other" text; mark a question skipped if they skip it). Returns a short brief. Show it to the user, then call create_video (or revise_video) with plan_id.

Example: {"plan_id": "plan_…", "answers": [{"question_id": "q1", "choice_ids": ["a"]}, {"question_id": "q2", "skipped": true}]}`,
      inputSchema: {
        plan_id: z.string(),
        answers: z
          .array(
            z.object({
              question_id: z.string(),
              choice_ids: z.array(z.string()).optional(),
              other: z.string().max(500).optional(),
              skipped: z.boolean().optional(),
            }),
          )
          .max(6)
          .default([]),
      },
    },
    async (args) =>
      run(async () => {
        const plan = await planning.generateBrief(
          deps,
          principal,
          args.plan_id,
          args.answers.map((a) => ({
            questionId: a.question_id,
            ...(a.choice_ids ? { optionIds: a.choice_ids } : {}),
            ...(a.other ? { other: a.other } : {}),
            ...(a.skipped ? { skipped: true } : {}),
          })),
        )
        return {
          plan_id: plan.id,
          brief: plan.brief,
          next_actions: [
            plan.revisionOf
              ? `Show the brief, then call revise_video with video_id "${plan.revisionOf.videoId}", the change, and plan_id "${plan.id}".`
              : `Show the brief, then call create_video with the original prompt and plan_id "${plan.id}".`,
          ],
        }
      }),
  )

  // Keys inherit their owner's role, so the tool list shows only what that role can do (plan v2 §3).
  if (!can(principal, 'video:create')) {
    for (const t of [createTool, reviseTool, publishTool, unpublishTool]) t.remove()
  }
  if (!can(principal, 'verdict:set')) verdictTool.remove()
  if (!can(principal, 'comment:create')) addCommentTool.remove()
  if (!can(principal, 'plan:create') || !deps.gateway.available()) {
    planVideoTool.remove()
    planBriefTool.remove()
  }
  return server
}

/** Handles one MCP HTTP request (stateless: a fresh server and transport per request). */
export async function handleMcp(
  deps: Deps,
  principal: Principal,
  req: Request,
  kick: () => void,
): Promise<Response> {
  const server = buildMcpServer(deps, principal, kick)
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true }) // no sessionIdGenerator: stateless
  await server.connect(transport)
  try {
    return await transport.handleRequest(req)
  } finally {
    void server.close()
  }
}
