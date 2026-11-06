// MCP server: lets people make videos from their AI tools (Claude, Cursor, any MCP client).
// Stateless Streamable HTTP at /api/mcp (alias /mcp), authenticated with the same API keys as the REST API.
// Twenty tools and five recipe prompts (mcp-prompts.ts); inputs are forgiving (aspect names, "30s", pasted
// URLs) and every result says what to do next. create_video, revise_video and show_video carry the video card, an
// MCP App (ui/src/mcp-app) that clients like Claude show in the chat: it follows progress, then plays the video.
import { RESOURCE_MIME_TYPE, registerAppResource } from '@modelcontextprotocol/ext-apps/server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import type { Deps } from './deps.js'
import { PRIVATE_URL_TTL_SEC, signedFilePath } from './domain/files.js'
import { addComment, listComments } from './domain/comments.js'
import { getEdit, openEdit, renderEdit, saveEdit, takeSummary, type DraftOp } from './domain/edits.js'
import { acquireNarrationLock } from './domain/narration-lock.js'
import { canReadMedia } from './domain/takes.js'
import { getProgress } from './domain/progress.js'
import { fillBeats } from './domain/beats.js'
import { listMedia } from './domain/media.js'
import { videoCardHtml } from './generated/video-card.js'
import { libraryMatches } from './domain/music-library.js'
import { AUDIO_CATEGORIES, LICENSE_FILTERS, openverseTiming } from './domain/openverse.js'
import {
  getOpenverseJob,
  jobError,
  startOpenverseImport,
  startOpenverseSearch,
  waitForOpenverseJob,
  type OpenverseJobDto,
  type SearchResult,
} from './domain/openverse-jobs.js'
import * as planning from './domain/plans.js'
import { can, type Principal } from './domain/policy.js'
import { SOUNDS, VERDICTS, type Aspect } from './domain/types.js'
import {
  cancelVersion,
  createVideo,
  listVideos,
  setVerdict,
  publishVersion,
  reviseVideo,
  unpublishVersion,
  updateVideo,
  videoDto,
  type VideoDto,
} from './domain/videos.js'
import { ApiError } from './lib/errors.js'
import { LANGUAGES } from './lib/language.js'
import {
  clipEnd,
  GAIN_DB_RANGE,
  IDENTITY_FIT,
  MAX_NARRATION_CLIPS,
  MAX_OUTPUT_SAMPLES,
  resolve,
  SAMPLE_RATE,
  samplesToSeconds,
  secondsToSamples,
  type NarrationOp,
} from './lib/timeline.js'
import { clip } from './lib/log.js'
import { ONE_WAY_WORDS, SPEED_RANGE, VOICE_ID } from './lib/voice.js'
import { MEDIA_KINDS } from './lib/media/classify.js'
import { registerPrompts } from './mcp-prompts.js'
import { enabledEngines, type EngineId } from './domain/engines.js'
import { listLooks } from './domain/looks.js'
import { remixVideo } from './domain/remix.js'
import { listDestinations } from './domain/destinations/list.js'
import { publishToDestination } from './domain/destinations/publish.js'
import { unpublishFromDestination } from './domain/destinations/remove.js'
import { listDestinationTargets } from './domain/destinations/people.js'

const SERVER_INSTRUCTIONS = `Make short videos from a prompt. Each video is made by an AI agent with HyperFrames (HTML/CSS/GSAP rendered to MP4) and takes 3 to 8 minutes.

Typical flow:
1. create_video with a prompt (quote any exact on-screen text). It returns immediately with status "queued".
2. Keep checking without asking: call get_video with the id and wait_seconds 8, again and again, until status is "ready" or "failed". Then tell your user it's done, with the web page link. In clients that show MCP Apps, create_video, revise_video and show_video also show a video card that follows progress and plays the video when it's ready.
3. When ready, the result has signed download URLs (valid 1 hour) and the web page for the video. To play it in the chat again later, call show_video.
4. revise_video to change something ("make the end card orange"); it creates the next version from the latest ready one. remix_video makes a NEW video (yours) that starts from an existing one and changes it as you say: anything from swapping a name to the same format on a new topic.
5. publish_video to get a public share page, MP4 URL and embed snippet.

Optional planning (when plan_video is listed): call plan_video with the prompt first. If it returns questions, ask your user (they can skip any), then call plan_brief with their answers, show the brief, and pass plan_id to create_video (or revise_video). Skip planning when the request is already specific.

Videos have captions and are silent unless you pass sound ("music" or "music_sfx"); for music, pass an audio item from list_media in media_ids (else the brand's music, or a CC0 or CC BY track the agent finds on Openverse, credited automatically); when search_music is listed, it finds CC0 and CC BY music on Openverse to import with import_music (when Openverse is slow they answer status "pending" with a job_id: call get_music_job until it's done). Pass voiceover (true, or a script with a line per beat) for a spoken narration; its captions follow the words. The company's brand context is applied automatically. Don't create a new video to fix a small thing: revise it.

Your own recorded voice-over (when add_narration is listed): upload the recording, place it with add_narration (media ids only), check it with get_narration, then render_with_narration with mode "keep_visuals" (the visuals stay as they are) or "fit_to_narration" (the agent retimes the scenes to it: an authoring run, about 250 credits).

Prompts: prompts/list has step-by-step recipes for what your role can do: pr_video (pull request to demo video), changelog_video (release notes to changelog video), social_cut (short vertical cut of a video), localize_video (captions and on-screen text in other languages) and review_video (read and add feedback, approve, revise).`

// ───────────── forgiving inputs ─────────────

/** The voice-over argument: true for the defaults, false to turn it off, or an object with a voice, speed and script. */
function voiceoverArg(describe: string) {
  return z
    .union([
      z.boolean(),
      z.object({
        voice: z
          .string()
          .regex(VOICE_ID)
          .optional()
          .describe(
            'A Kokoro voice: af_heart (default), af_nova, af_sky, am_adam, am_michael, bf_emma, bm_george.',
          ),
        speed: z.number().min(SPEED_RANGE[0]).max(SPEED_RANGE[1]).optional().describe('0.7-1.3, default 1.'),
        script: z
          .array(z.string().min(1).max(600))
          .max(12)
          .optional()
          .describe(
            `The narration, one line per beat, spoken word for word. Omit to let the agent (or the plan) write it. ${ONE_WAY_WORDS}`,
          ),
      }),
    ])
    .optional()
    .describe(describe)
}
const toVoiceover = (
  v:
    | boolean
    | { voice?: string | undefined; speed?: number | undefined; script?: string[] | undefined }
    | undefined,
) => (v === undefined ? undefined : typeof v === 'boolean' ? { enabled: v } : { enabled: true, ...v })

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

const lookArg = (restyle: boolean) =>
  z
    .string()
    .nullable()
    .optional()
    .describe(
      restyle
        ? 'Optional. A look id from list_looks; leave out to keep the current look, null for none. A different look is a restyle, a full run.'
        : 'Optional. A look id from list_looks (a named visual style); leave out for the default, null for none.',
    )

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
    take_deleted: ['TAKE_DELETED', { fix_hint: 'That recording was deleted. Record or pick another take.' }],
    narration_disabled: [
      'NARRATION_DISABLED',
      { fix_hint: 'Recorded voice-over is turned off; an admin can turn it on in Settings.' },
    ],
    narration_locked: [
      'NARRATION_LOCKED',
      { fix_hint: 'Someone else is editing this narration; wait for them, or take it over in the editor.' },
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
    rate_limited: ['RATE_LIMITED', { fix_hint: 'Wait a minute, then try again.' }],
    upstream_error: ['UPSTREAM_ERROR', { fix_hint: 'Try again shortly.' }],
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

const optionalVersion = (description: string) => z.number().int().positive().optional().describe(description)

type ToolResult = {
  content: { type: 'text'; text: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

function ok(body: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body }
}

/** Runs a tool and shapes its outcome for agents. An unexpected error is logged: the agent only sees "went wrong". */
async function runTool(
  log: Deps['log'],
  fn: () => Promise<Record<string, unknown>>,
  videoId?: string,
): Promise<ToolResult> {
  try {
    return ok(await fn())
  } catch (e) {
    if (!(e instanceof ToolError) && !(e instanceof ApiError))
      log.error('mcp.tool_failed', { videoId: videoId ?? null, error: e })
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

/** What to do while a version is being made: keep checking in the same turn, then say it's done. */
const KEEP_CHECKING = (id: string) =>
  `Keep checking without asking your user: call get_video with video_id "${id}" and wait_seconds 8, and call it again each time it's still in progress, until status is "ready" or "failed". Then tell your user it's done, with web_url.`

/** A demo's recording (screen-recording plan §6.2), on create_video and remix_video. */
const RECORDING_ARGS = {
  recording_media_id: z
    .string()
    .max(80)
    .optional()
    .describe(
      "Optional. Make a demo from a screen recording in the library (role screen-recording, from list_media): the agent turns its steps into scenes with auto zoom, a cursor and hidden areas. Check the version's Hidden list in get_video before publishing.",
    ),
  trim: z
    .array(z.number())
    .length(2)
    .optional()
    .describe('Optional, with recording_media_id. Seconds of the recording to use: [in, out].'),
  redact: z
    .array(
      z.object({
        start: z.number().min(0),
        end: z.number().positive(),
        box: z
          .array(z.number().min(0).max(1))
          .length(4)
          .describe('[x, y, width, height], fractions of the frame.'),
      }),
    )
    .max(50)
    .optional()
    .describe(
      'Optional, with recording_media_id. Areas to hide from the start; the video then starts private.',
    ),
}

function toRecording(args: {
  recording_media_id?: string | undefined
  trim?: number[] | undefined
  redact?: { start: number; end: number; box: number[] }[] | undefined
}) {
  if (!args.recording_media_id) return undefined
  return {
    mediaId: args.recording_media_id,
    ...(args.trim ? { trim: [args.trim[0] ?? 0, args.trim[1] ?? 0] as [number, number] } : {}),
    ...(args.redact
      ? {
          redact: args.redact.map((r) => ({
            start: r.start,
            end: r.end,
            box: [r.box[0] ?? 0, r.box[1] ?? 0, r.box[2] ?? 0, r.box[3] ?? 0] as [
              number,
              number,
              number,
              number,
            ],
          })),
        }
      : {}),
  }
}

const VIDEO_CARD_URI = 'ui://video-agent/video-card.html'
/** Tool metadata that shows the video card (both keys: older MCP Apps hosts read the flat one). */
const VIDEO_CARD = { ui: { resourceUri: VIDEO_CARD_URI }, 'ui/resourceUri': VIDEO_CARD_URI }
/** Annotation hints shared by the tools that start a run (create, remix, revise, render with narration). */
const STARTS_RUN = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }

async function summarize(deps: Deps, v: VideoDto) {
  const job = (await deps.store.getJob(v.id)) ?? { id: v.id, private: v.private, accessEpoch: 0 }
  const ttl = v.private ? PRIVATE_URL_TTL_SEC : 3600
  const ready = v.versions.find((x) => x.status === 'ready')
  const latest = v.versions[0]
  // File names that change after the render: a picked poster's, a caption revision's.
  const names = new Map<number, { poster?: string; captions?: string }>()
  for (const row of await deps.store.listVersions(v.id))
    names.set(row.n, {
      ...(row.poster?.custom ? { poster: row.poster.custom.files.jpg } : {}),
      ...(row.captions ? { captions: row.captions.files.vtt } : {}),
    })
  const versions = await Promise.all(
    v.versions.map(async (x) => ({
      version: x.n,
      status: x.status,
      prompt: x.prompt,
      from_version: x.parentN,
      // Its scenes, to redo some with revise_video's beats; and the scenes it redid itself.
      ...(x.beats ? { beats: x.beats } : {}),
      ...(x.scope ? { redid_scenes: x.scope.beats } : {}),
      ...(x.sound !== 'silent' ? { sound: x.sound } : {}),
      ...(x.voiceover ? { voiceover: x.voiceover } : {}),
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
              mp4: `${deps.config.siteUrl}${await signedFilePath(deps, job, x.n, 'video', { ttlSec: ttl, download: true })}`,
              // A picked poster and a caption revision have their own file names.
              poster: `${deps.config.siteUrl}${await signedFilePath(deps, job, x.n, 'poster', { ttlSec: ttl, name: names.get(x.n)?.poster })}`,
              gif: `${deps.config.siteUrl}${await signedFilePath(deps, job, x.n, 'gif', { ttlSec: ttl })}`,
              captions: `${deps.config.siteUrl}${await signedFilePath(deps, job, x.n, 'captions', { ttlSec: ttl, name: names.get(x.n)?.captions })}`,
              expires_in_sec: ttl,
            },
          }
        : {}),
      ...(x.publications.some((p) => p.urls) ? { public: x.publications.find((p) => p.urls) } : {}),
      // CC BY media it uses: show these lines wherever the video is shared.
      ...(x.credits.length ? { attribution: x.credits.map((c) => c.text) } : {}),
      credits: x.usage?.totalCreditsCost ?? null,
    })),
  )
  const next: string[] = []
  if (latest && ['queued', 'running', 'finishing'].includes(latest.status)) {
    next.push(`Version ${latest.n} is ${latest.status}. ${KEEP_CHECKING(v.id)}`)
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
    // The language spoken in it: recorded narration's captions are transcribed in it.
    language: v.language,
    web_url: `${deps.config.siteUrl}/videos/${v.id}`,
    // A remix: the video and version it was made from, when you can see it (docs/plans/2026-11-03-remix.md §3.6).
    is_remix: v.isRemix,
    remix_of: v.remixOf ? { video_id: v.remixOf.id, version: v.remixOf.n, title: v.remixOf.title } : null,
    latest_version: v.latestVersion,
    ready_version: ready?.n ?? null,
    created_at: v.createdAt,
    versions,
    next_actions: next,
  }
}

// ───────────── recorded narration (plan 2026-11-02 §7) ─────────────

/** A new track's settings, as the editor starts one: your voice at 0 dB, the AI voice replaced, music ducked 12 dB. */
const newNarration = (): NarrationOp => ({
  op: 'narration',
  schema: 1,
  sampleRate: SAMPLE_RATE,
  clips: [],
  tracks: {
    narration: { volumeDb: 0, muted: false, solo: false },
    aiVoice: { mode: 'replace', volumeDb: -12 },
    music: { duck: true, duckDb: -12 },
    original: { muteAll: false },
  },
  cleanup: 'light',
})

const sec = (samples: number) => Math.round(samplesToSeconds(samples) * 100) / 100
const narrationOf = (ops: readonly unknown[]) =>
  (ops.find((o) => (o as { op?: unknown }).op === 'narration') as NarrationOp | undefined) ?? null

/** A narration op in seconds, as agents read it: the clips as they play (later clips win where they overlap). */
function narrationSummary(op: NarrationOp | null) {
  if (!op) return null
  const clips = resolve(op.clips)
  return {
    clips: clips.map((c) => ({
      clip_id: c.id,
      media_id: c.mediaId,
      start_seconds: sec(c.start),
      length_seconds: sec(c.srcEnd - c.srcStart),
      gain_db: c.gainDb,
    })),
    end_seconds: clips.length ? sec(Math.max(...clips.map(clipEnd))) : 0,
    cleanup: op.cleanup,
    ai_voice: op.tracks.aiVoice.mode,
    music_ducked: op.tracks.music.duck,
  }
}

// ───────────── server ─────────────

export function buildMcpServer(
  deps: Deps,
  principal: Principal,
  kick: () => void,
  /** Engines on here right now: create_video offers an engine only when there's more than HyperFrames. */
  opts: { engines?: EngineId[] } = {},
): McpServer {
  const engines = opts.engines ?? ['hyperframes']
  const server = new McpServer(
    { name: 'video-agent', version: '1.0.0' },
    { instructions: SERVER_INSTRUCTIONS },
  )
  const load = (id: string) => videoDto(deps.store, deps, id, principal)
  const run = (fn: () => Promise<Record<string, unknown>>, videoId?: string) => runTool(deps.log, fn, videoId)
  /** A queued run's result: wakes the worker unless the request was a replay, then the video and the next step. */
  const queued = async (res: { replayed: boolean; body: VideoDto }, next: string) => {
    if (!res.replayed) kick()
    return { ...(await summarize(deps, res.body)), next_actions: [next] }
  }

  const contextArg = z
    .object({
      source: z.enum(['github_pr', 'github_release', 'changelog', 'text']),
      label: z.string().min(1).max(120).describe('What it is, like "GitHub PR #123".'),
      url: z
        .url()
        .max(500)
        .refine((u) => u.startsWith('https://'), 'url must be https')
        .optional(),
      text: z.string().min(1).max(16000),
    })
    .optional()
    .describe(
      "Optional. Background the agent reads as data, outside the prompt: a pull request's description, release notes. Up to 16,000 characters.",
    )

  const externalArgs = {
    external_ref: z
      .string()
      .max(200)
      .regex(/^[a-z]+:[^\s]+$/)
      .optional()
      .describe(
        'Optional. What the video is for outside the app, like "github:acme/web#pr-123". Find it again with list_videos.',
      ),
    private: z
      .boolean()
      .optional()
      .describe('Optional. true: only you and admins can see it, from the start.'),
  }

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
          .describe(
            'Optional. Library items (from list_media) to use: logos, screenshots, clips, fonts, music (audio).',
          ),
        sound: z
          .enum(SOUNDS)
          .optional()
          .describe(
            'Optional. "silent" (default), "music" (a music bed: an audio item from media_ids, else the brand\'s music, else none) or "music_sfx" (music plus sound effects on visible actions). Picking an audio item turns music on.',
          ),
        voiceover: voiceoverArg(
          'Optional. A spoken narration, with captions from its words: true, or {voice, speed, script}. Works with any sound; music dips under the voice.',
        ),
        look: lookArg(false),
        ...RECORDING_ARGS,
        // Only where another engine is on (render-engines plan §7): everywhere else the argument doesn't exist.
        ...(engines.length > 1
          ? {
              engine: z
                .enum(engines as [EngineId, ...EngineId[]])
                .optional()
                .describe(
                  "Optional. The render engine; leave out for the look's choice. Some engines can't make sound effects or a voice-over.",
                ),
            }
          : {}),
        idempotency_key: z
          .string()
          .max(200)
          .optional()
          .describe('Optional. Reusing the same key returns the same video instead of a duplicate.'),
        ...externalArgs,
        context: contextArg,
      },
      _meta: VIDEO_CARD,
      annotations: { title: 'Create a video', ...STARTS_RUN },
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
            sound: args.sound,
            voiceover: toVoiceover(args.voiceover),
            look: args.look,
            externalRef: args.external_ref,
            private: args.private,
            context: args.context,
            recording: toRecording(args),
            engine: (args as { engine?: EngineId }).engine,
          },
          args.idempotency_key,
        )
        return queued(res, `It usually takes 3 to 8 minutes. ${KEEP_CHECKING(res.body.id)}`)
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
        // Scenes of editable versions made before versions recorded them (redo a scene): filled once, then stored.
        const unknown = v.versions.filter((x) => x.editable && x.beats === null)
        for (const x of unknown) await fillBeats(deps, principal, id, x.n).catch(() => null)
        if (unknown.length) v = await load(id)
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

  // The video card's page. Its video and poster links are signed file URLs on this site.
  registerAppResource(
    server,
    'Video card',
    VIDEO_CARD_URI,
    { description: 'Follows a video while it is being made, then plays it.' },
    async () => ({
      contents: [
        {
          uri: VIDEO_CARD_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: videoCardHtml,
          _meta: { ui: { csp: { resourceDomains: [deps.config.siteUrl] }, prefersBorder: true } },
        },
      ],
    }),
  )

  server.registerTool(
    'show_video',
    {
      title: 'Show a video',
      description: `Show a video in the chat: it plays when it's ready, and shows live progress while it's being made. Returns the same result as get_video.

When to use: the user wants to watch or see a video ("show me the video", "play it"). NOT for checking progress over and over: use get_video for that, so the chat doesn't fill with cards.

Example: {"video_id": "vid_01jc8x2k4m5n6p7q8r9s0t1v2w"}`,
      inputSchema: {
        video_id: z.string().describe('The video id (vid_…) or its web URL.'),
      },
      _meta: VIDEO_CARD,
      annotations: { title: 'Show a video', readOnlyHint: true, openWorldHint: false },
    },
    (args) => run(async () => summarize(deps, await load(normalizeVideoId(args.video_id))), args.video_id),
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
        favorites: z.boolean().optional().describe('Only videos you starred in the web app.'),
        external_ref: z
          .string()
          .max(200)
          .optional()
          .describe('Only videos made with this external_ref (exact match), like "github:acme/web#pr-123".'),
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
          ...(args.favorites ? { favorite: true } : {}),
          ...(args.external_ref ? { externalRef: args.external_ref } : {}),
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
            favorite: v.favorite,
            is_remix: v.isRemix,
            remix_of: v.remixOf ? { video_id: v.remixOf.id, version: v.remixOf.n } : null,
            ...(v.externalRef ? { external_ref: v.externalRef } : {}),
            web_url: `${deps.config.siteUrl}/videos/${v.id}`,
          })),
          more: res.nextCursor !== null,
          next_actions: ['Call get_video with a video_id for its status and download URLs.'],
        }
      }),
  )

  const remixTool = server.registerTool(
    'remix_video',
    {
      title: 'Remix a video',
      description: `Make a NEW video (owned by you) that starts from an existing video's finished composition and changes it as you describe: anything from "the same video with our new product name" to "a video like this one about webhooks". Its shape, length, sound, AI voice-over and library media come from the source unless you set them; recorded narration, comments and publications don't carry over. Returns at once; ready in a few minutes.

When to use: the user wants a copy of a video with changes, or a new video in the same format. To change the video itself, use revise_video.
Don't: describe the whole source video; describe what should be different.

Example: {"video_id": "vid_01jc8x2k4m5n6p7q8r9s0t1v2w", "change": "Same format, but about our payments API"}`,
      inputSchema: {
        video_id: z.string().describe('The video to remix: its id (vid_…) or web URL.'),
        change: z
          .string()
          .min(3)
          .max(4000)
          .describe('What should be different. Be as descriptive as possible.'),
        from_version: optionalVersion('Which ready version to start from (default: the latest ready one).'),
        aspect: z.string().optional().describe("16:9, 9:16, 1:1 or 4:5. Leave out to keep the source's."),
        duration_sec: z
          .union([z.number(), z.string()])
          .optional()
          .describe("A target length. Leave out to keep the source's."),
        media_ids: z
          .array(z.string())
          .max(12)
          .optional()
          .describe(
            "Optional. The remix's library items (from list_media): replaces the source's. Leave out to keep them.",
          ),
        sound: z
          .enum(SOUNDS)
          .optional()
          .describe('Optional. "silent", "music" or "music_sfx". Leave out to keep the source\'s sound.'),
        voiceover: voiceoverArg(
          "Optional. true, false or {voice, speed, script}. Leave out to keep the source's AI voice-over settings.",
        ),
        plan_id: z
          .string()
          .optional()
          .describe('Optional. A plan from plan_video with remix_of this same video.'),
        look: lookArg(true),
        ...externalArgs,
        context: contextArg,
        ...RECORDING_ARGS,
      },
      _meta: VIDEO_CARD,
      annotations: { title: 'Remix a video', ...STARTS_RUN },
    },
    (args) =>
      run(async () => {
        const id = normalizeVideoId(args.video_id)
        const res = await remixVideo(deps, principal, id, {
          prompt: args.change,
          fromVersion: args.from_version,
          aspect: normalizeAspect(args.aspect),
          durationSec: normalizeDuration(args.duration_sec),
          mediaIds: args.media_ids,
          sound: args.sound,
          voiceover: toVoiceover(args.voiceover),
          planId: args.plan_id,
          look: args.look,
          externalRef: args.external_ref,
          private: args.private,
          context: args.context,
          recording: toRecording(args),
        })
        return queued(res, `The remix usually takes 3 to 8 minutes. ${KEEP_CHECKING(res.body.id)}`)
      }, args.video_id),
  )

  const reviseTool = server.registerTool(
    'revise_video',
    {
      title: 'Revise a video',
      description: `Make the next version of a video from a ready version, changing only what you describe. Returns at once; ready in a few minutes.

When to use: the user wants a change to an existing video ("make the end card orange", "shorter", "add our URL").
Don't: describe the whole video again; describe the change. Only one version per video can be in progress.
Incorporate feedback: pass comment_ids (from list_comments; open comments on from_version) and use change for your note. Only the video's owner or an admin can.
Redo a scene: pass beats (scene ids from get_video's versions[].beats) and from_version to change only those scenes; everything else stays exactly as it is.

Example: {"video_id": "vid_01jc8x2k4m5n6p7q8r9s0t1v2w", "change": "Make the end card say \\"Start free today\\""}`,
      inputSchema: {
        video_id: z.string().describe('The video id (vid_…) or its web URL.'),
        change: z.string().min(3).max(4000).describe('What should change. Everything else stays.'),
        plan_id: z
          .string()
          .optional()
          .describe('Optional. A revision plan from plan_video (with video_id) + plan_brief.'),
        from_version: optionalVersion('Which ready version to start from (default: the latest ready one).'),
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
        sound: z
          .enum(SOUNDS)
          .optional()
          .describe(
            'Optional. "silent", "music" or "music_sfx". Leave out to keep the sound of the version it revises.',
          ),
        voiceover: voiceoverArg(
          'Optional. true, false or {voice, speed, script}. Leave out to keep the voice-over of the version it revises; unchanged lines keep their audio.',
        ),
        beats: z
          .array(z.string())
          .min(1)
          .max(20)
          .optional()
          .describe(
            "Optional. Redo only these scenes (ids from get_video's beats for from_version); everything else stays exactly as it is. Faster and cheaper than revising the whole video. Needs from_version. Can't be combined with plan_id, duration_sec, sound or voiceover.",
          ),
        look: lookArg(true),
        context: contextArg,
      },
      _meta: VIDEO_CARD,
      annotations: { title: 'Revise a video', ...STARTS_RUN },
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
          sound: args.sound,
          voiceover: toVoiceover(args.voiceover),
          scope: args.beats ? { beats: args.beats } : undefined,
          look: args.look,
          context: args.context,
        })
        return queued(
          res,
          `Version ${res.body.latestVersion} usually takes 3 to 8 minutes. ${KEEP_CHECKING(id)}`,
        )
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
        version: optionalVersion('Which version (default: the latest ready one).'),
        destination: z
          .string()
          .optional()
          .describe(
            "Where to publish (list_destinations): 'share_page' (the default), 'youtube', or an HTTP destination's id. Other than the share page, it publishes in the background: get_video shows it under versions[].destinations.",
          ),
        target: z
          .object({
            id: z.string(),
            name: z.string(),
            description: z.string().nullable(),
            url: z.string().nullable(),
            metadata: z
              .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
              .nullable(),
          })
          .optional()
          .describe(
            "One of list_destinations' targets for that destination, exactly as listed; omit for a new one.",
          ),
        options: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("The destination's options form values."),
        instructions: z
          .string()
          .max(4000)
          .optional()
          .describe('Free text for destinations that take instructions.'),
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
        if (args.destination && args.destination !== 'share_page') {
          const dp = await publishToDestination(deps, principal, id, n, {
            destination: args.destination,
            options: args.options,
            target: args.target,
            instructions: args.instructions,
          })
          return {
            video_id: id,
            version: n,
            publication: dp,
            next_actions: [
              'It publishes in the background: call get_video and read versions[].destinations for its status and url. unpublish_video with this publication id removes it.',
            ],
          }
        }
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
        version: optionalVersion('Which version (default: whichever version is public).'),
        publication: z
          .string()
          .optional()
          .describe(
            'A destination publication id (dpub_…) to remove from its destination instead of the share page.',
          ),
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
        if (args.publication) {
          const dp = await unpublishFromDestination(deps, principal, args.publication)
          return { video_id: id, publication: dp, unpublished: true }
        }
        const v = await load(id)
        const n = args.version ?? v.versions.find((x) => x.publications.some((p) => !p.unpublishedAt))?.n
        if (!n) return { video_id: id, unpublished: false, message: 'No version of this video is public.' }
        await unpublishVersion(deps, principal, id, n)
        return { video_id: id, version: n, unpublished: true }
      }, args.video_id),
  )

  server.registerTool(
    'list_looks',
    {
      title: 'List looks',
      description: `The named visual styles a video can be made in (Clean product, Kinetic type, Terminal, …), with what each suits and a preview clip. Pass an id as look to create_video, revise_video or remix_video.

When to use: before creating a video, unless the person already named a style: offer two or three that fit.`,
      inputSchema: {},
      annotations: {
        title: 'List looks',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    () =>
      run(async () => {
        const { looks, default: defaultLook } = await listLooks(deps)
        return {
          // Looks an admin turned off are left out: they can't be picked.
          looks: looks
            .filter((l) => l.enabled)
            .map((l) => ({
              id: l.id,
              name: l.name,
              description: l.description,
              tags: l.tags,
              best_for: l.bestFor,
              preview: {
                mp4: l.preview.mp4 && `${deps.config.siteUrl}${l.preview.mp4}`,
                poster: l.preview.poster && `${deps.config.siteUrl}${l.preview.poster}`,
              },
            })),
          default: defaultLook,
        }
      }),
  )

  const listDestinationsTool = server.registerTool(
    'list_destinations',
    {
      title: 'List publish destinations',
      description: `Where a ready version can be published besides the share page: YouTube (when set up) and HTTP destinations, each with whether it's ready for you. Give video_id and destination to also get that destination's targets (things it already holds for you, such as your sites) to pass to publish_video.

Example: {"video_id": "vid_01jc8x2k4m5n6p7q8r9s0t1v2w", "destination": "dst_…"}`,
      inputSchema: {
        video_id: z.string().optional().describe('The video, to list a destination’s targets for it.'),
        destination: z.string().optional().describe('A destination id, to list its targets.'),
      },
      annotations: {
        title: 'List publish destinations',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args) =>
      run(async () => {
        const destinations = await listDestinations(deps, principal)
        if (args.video_id && args.destination) {
          const t = await listDestinationTargets(
            deps,
            principal,
            args.destination,
            normalizeVideoId(args.video_id),
          )
          return { destinations, targets: t.targets, targets_error: t.error }
        }
        return { destinations }
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
        verdict: z.enum(VERDICTS).nullable(),
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
      description: `The team's uploaded media: logos, screenshots, clips, fonts, audio (music) and PDFs, newest first. Pass media ids to create_video or revise_video (media_ids) so the agent uses them. An item's title is its name in the library; its notes (caption) say what it is. Screen recordings (role screen-recording) are private to their uploader until a video uses them; has_trace says whether one has a pointer trace.

Example: {"query": "launch logo", "kind": "image"}`,
      inputSchema: {
        kind: z.enum(MEDIA_KINDS).optional(),
        query: z
          .string()
          .max(200)
          .optional()
          .describe('Words to find in the title, file name or notes, e.g. "Q3 launch".'),
        cursor: z.string().optional().describe('next_cursor from the previous page.'),
        role: z
          .enum(['screen-recording'])
          .optional()
          .describe('Only items with this role, e.g. "screen-recording" for raw screen recordings.'),
      },
      annotations: { title: 'List media', readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      run(async () => {
        const page = await listMedia(deps, principal, { kind: args.kind, q: args.query, cursor: args.cursor })
        return {
          media: page.items
            // The role filter applies within the page (next_cursor still walks the whole library).
            .filter((m) => m.status === 'ready' && (!args.role || m.role === args.role))
            .map((m) => ({
              id: m.id,
              kind: m.kind,
              title: m.title ?? m.filename,
              filename: m.filename,
              caption: m.caption,
              width: m.width,
              height: m.height,
              duration_sec: m.durationSec,
              role: m.role,
              has_trace: m.hasTrace,
            })),
          next_cursor: page.nextCursor,
        }
      }),
  )

  // Openverse can take a minute: the music tools wait a few seconds, then hand back a job to poll with get_music_job.
  /** Library audio matching a search, for agents to reuse before importing anything new. */
  const inLibrary = async (query: string) =>
    (await libraryMatches(deps, principal, query, 5)).map((m) => ({
      media_id: m.id,
      title: m.source?.title ?? m.caption ?? m.filename,
      creator: m.source?.creator ?? null,
      duration_sec: m.durationSec === null ? null : Math.round(m.durationSec),
      license: m.source?.licenseLabel ?? null,
    }))
  const trackList = (r: SearchResult) => ({
    status: 'done',
    tracks: r.items
      .filter((t) => t.importable)
      .map((t) => ({
        id: t.id,
        title: t.title,
        creator: t.creator,
        duration_sec: t.durationSec === null ? null : Math.round(t.durationSec),
        license: t.licenseLabel,
        credit_required: t.license === 'by',
        genres: t.genres,
        preview_url: t.previewUrl,
        landing_url: t.landingUrl,
        ...(t.mediaId ? { media_id: t.mediaId } : {}),
      })),
    page: r.page,
    page_count: r.pageCount,
    ...(r.stale && r.fetchedAt ? { fetched_at: r.fetchedAt } : {}),
    next_actions: [
      'Pick a track (media_id means it is already in the library), then call import_music with its id.',
    ],
  })
  const imported = (r: { created: boolean; media: OpenverseJobDto['media'] & {} }) => {
    const m = r.media
    return {
      status: 'done',
      media_id: m.id,
      already_in_library: !r.created,
      filename: m.filename,
      duration_sec: m.durationSec,
      license: m.source?.licenseLabel ?? null,
      credit_required: m.source?.creditRequired ?? false,
      next_actions: [`Pass media_ids ["${m.id}"] with sound "music" to create_video or revise_video.`],
    }
  }
  /** A job's answer for an agent: the result, its error (thrown), or "pending" with the call to make next. */
  const jobResult = (job: OpenverseJobDto) => {
    if (job.status === 'failed') throw jobError(job)
    if (job.status === 'done' && job.search) return trackList(job.search)
    if (job.status === 'done' && job.media)
      return imported({ created: job.created ?? true, media: job.media })
    return {
      status: 'pending',
      job_id: job.id,
      kind: job.kind,
      next: 'call get_music_job',
      next_actions: [
        `Openverse is slow right now. Call get_music_job with job_id "${job.id}" (wait_seconds: 8) until status is "done".`,
      ],
      suggested_tool_calls: [{ name: 'get_music_job', arguments: { job_id: job.id, wait_seconds: 8 } }],
    }
  }
  const settle = async (started: number, job: OpenverseJobDto) =>
    jobResult(await waitForOpenverseJob(deps, principal, job.id, started + openverseTiming.mcpWaitMs))

  const searchMusicTool = server.registerTool(
    'search_music',
    {
      title: 'Find music on Openverse',
      description: `Search Openverse for openly licensed music (or sound effects) that is free for commercial videos and edits: only CC0 and CC BY, never NC, ND or SA. Results aren't in the library yet: pass a track's id to import_music, then use the returned media id in create_video or revise_video (media_ids) with sound "music". CC BY tracks are credited on the video and its share page automatically.

When to use: the user wants music and the library (list_media, kind "audio") has nothing that fits. Listen links are in preview_url. in_library lists audio already in the library that matches the words: prefer one of those (pass its media_id) over importing.
Searches are shared and stored, so common ones answer at once. Openverse is sometimes slow: then the answer is {"status": "pending", "job_id": …}; call get_music_job with that job_id until it's done.

Example: {"query": "calm piano", "license": "cc0,by"}`,
      inputSchema: {
        query: z.string().min(1).max(200).describe('What it should sound like: mood, genre, instruments.'),
        license: z
          .enum(LICENSE_FILTERS)
          .optional()
          .describe(
            '"cc0,by" (default; CC BY needs a credit, shown automatically) or "cc0" (no credit at all).',
          ),
        category: z.enum(AUDIO_CATEGORIES).optional().describe('"music" (default), "sound_effect" or "all".'),
        page: z.number().int().min(1).max(10).optional(),
      },
      annotations: { title: 'Search music', readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        const started = Date.now()
        const r = await startOpenverseSearch(deps, principal, {
          q: args.query,
          license: args.license,
          category: args.category,
          page: args.page,
        })
        const out = r.job ? await settle(started, r.job) : trackList(r.done)
        const library = await inLibrary(args.query)
        if (!library.length) return out
        return {
          ...out,
          in_library: library,
          next_actions: [
            `In the library already: ${library.map((m) => `"${m.title}" (media_id ${m.media_id})`).join(', ')}. Pass one in media_ids with sound "music", or pick an Openverse track to import.`,
            ...out.next_actions,
          ],
        }
      }),
  )

  const importMusicTool = server.registerTool(
    'import_music',
    {
      title: 'Import an Openverse track',
      description: `Import a track found with search_music into the team's media library (it's downloaded and checked; importing it again returns the same item). Returns the media id to pass in media_ids.
When Openverse is slow the answer is {"status": "pending", "job_id": …}; call get_music_job with that job_id until it's done.

Example: {"id": "8c0e3c1e-1a2b-4c3d-9e8f-0123456789ab"}`,
      inputSchema: {
        id: z.string().min(1).max(64).describe('The track id from search_music.'),
        caption: z.string().max(500).optional().describe('Optional note on how to use it.'),
      },
      annotations: { title: 'Import music', readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        const started = Date.now()
        const r = await startOpenverseImport(deps, principal, { id: args.id, caption: args.caption })
        return r.job ? settle(started, r.job) : imported(r.done)
      }),
  )

  const musicJobTool = server.registerTool(
    'get_music_job',
    {
      title: 'Check a music search or import',
      description: `Check a search_music or import_music call that answered "pending" because Openverse was slow. Returns the same result that tool returns once the job is done (status "done"), or "pending" again.
wait_seconds (0-8) waits in this call for it to finish, so you can poll less often. Jobs are kept for 30 minutes.

Example: {"job_id": "ovj_3f2a9c0d1e2b4a5c6d7e8f90", "wait_seconds": 8}`,
      inputSchema: {
        job_id: z.string().min(1).max(64).describe('The job_id from search_music or import_music.'),
        wait_seconds: z
          .number()
          .min(0)
          .max(8)
          .optional()
          .describe('Wait up to this many seconds for the job to finish (max 8).'),
      },
      annotations: { title: 'Check music job', readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      run(async () => {
        const wait = Math.min(args.wait_seconds ?? 0, 8) * 1000
        const job = wait
          ? await waitForOpenverseJob(deps, principal, args.job_id, Date.now() + wait)
          : await getOpenverseJob(deps, principal, args.job_id)
        return jobResult(job)
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
      description: `Optional first step before create_video (or revise_video). Reads the request and returns 0–6 multiple-choice questions whose answers would change the video. Ask your user these questions (they may skip any or give their own answer), then call plan_brief. A choice marked recommended is the planner's pick and comes first: show it first with "(Recommended)".

Pass video_id to plan a revision of an existing video; the questions are about the change. If "questions" is empty, call plan_brief with no answers.

Example: {"prompt": "A 30-second launch video for org webhooks, ending on our logo"}`,
      inputSchema: {
        prompt: z.string().min(10).max(4000).describe('The video request, as the user wrote it.'),
        aspect: z.string().optional().describe('16:9, 9:16, 1:1 or 4:5, if the user already chose one.'),
        duration_sec: z.union([z.number(), z.string()]).optional(),
        video_id: z.string().optional().describe('Plan a revision of this video instead of a new one.'),
        remix_of: z
          .string()
          .optional()
          .describe(
            'Plan a remix of this video (a new video from it) instead; not with video_id. Pass plan_id to remix_video.',
          ),
        media_ids: z
          .array(z.string())
          .max(12)
          .optional()
          .describe(
            "Optional. Library items (from list_media) to plan around; the video made from the plan uses them, so don't pass them again.",
          ),
        sound: z
          .enum(SOUNDS)
          .optional()
          .describe(
            'Optional. "silent", "music" or "music_sfx", if the user already chose; the video made from the plan uses it.',
          ),
        voiceover: voiceoverArg(
          'Optional. true or {voice, speed, script} for a voice-over: the brief then has a narration line per beat, which the video speaks.',
        ),
        look: z
          .string()
          .nullable()
          .optional()
          .describe(
            'Optional. A look id from list_looks, or null for none; left out, a new video plan picks one that suits it. The video made from the plan uses it.',
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
          ...(args.remix_of ? { remixOf: { videoId: normalizeVideoId(args.remix_of) } } : {}),
          mediaIds: args.media_ids,
          sound: args.sound,
          voiceover: toVoiceover(args.voiceover),
          ...(args.look !== undefined ? { look: args.look } : {}),
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
            choices: q.options.map((o) => ({
              choice_id: o.id,
              label: o.label,
              description: o.description,
              ...(o.recommended ? { recommended: true } : {}),
            })),
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

  // Recorded narration (plan 2026-11-02 §7): place an uploaded recording on a draft, then render it over the visuals.
  /** The latest ready version, the one a new narration draft starts from. */
  const readyVersion = async (id: string) => {
    const n = (await load(id)).versions.find((x) => x.status === 'ready')?.n
    if (!n)
      throw new ToolError('NOT_READY', 'This video has no ready version yet.', {
        suggested_tool_calls: [{ name: 'get_video', arguments: { video_id: id, wait_seconds: 8 } }],
      })
    return n
  }
  /** The caller's open draft of a version, or null (drafts are per person; nobody else's is visible). */
  const ownDraft = (id: string, n: number) =>
    deps.store.findEdit(principal.userId, id, n, deps.clock.now().toISOString())

  server.registerTool(
    'get_narration',
    {
      title: 'Get a recorded narration',
      description: `Read a video's recorded voice-over: the clips of each recording (media_id, where it starts and how long it plays, in seconds) and its captions' status. With version, that version's narration as it was rendered; without, the latest ready version's, plus your draft's if you have one (from add_narration or the editor).
A version narrated with the AI voice (voiceover) has no recorded narration: narration is null.

Example: {"video_id": "vid_01jc8x2k4m5n6p7q8r9s0t1v2w"}`,
      inputSchema: {
        video_id: z.string().describe('The video id (vid_…) or its web URL.'),
        version: optionalVersion('Which version (default: the latest ready one, and your draft of it).'),
      },
      annotations: { title: 'Get narration', readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        const id = normalizeVideoId(args.video_id)
        const v = await load(id)
        const n = args.version ?? (await readyVersion(id))
        const row = await deps.store.getVersion(id, n)
        if (!row || !v.versions.some((x) => x.n === n))
          throw new ToolError('NOT_FOUND', `Version ${n} not found.`, {
            suggested_tool_calls: [{ name: 'get_video', arguments: { video_id: id } }],
          })
        const draft = args.version === undefined ? await ownDraft(id, n) : null
        const draftOp = draft ? narrationOf(draft.ops) : null
        return {
          video_id: id,
          version: n,
          language: v.language,
          // What finalize recorded, else what the render froze (the same op, while it's being made).
          narration: narrationSummary(
            ((row.narration?.op ?? row.frozen?.narration?.op) as NarrationOp | undefined) ?? null,
          ),
          captions: row.captions
            ? { status: row.captions.status, policy: row.captions.policy, revision: row.captions.rev }
            : null,
          ...(draft
            ? { draft: { edit_id: draft.id, rev: draft.rev, narration: narrationSummary(draftOp) } }
            : {}),
          next_actions: [
            draftOp?.clips.length
              ? `Your draft has a narration: call render_with_narration with video_id "${id}" to render it (a run that costs credits).`
              : `To add a recording, call add_narration with video_id "${id}" and an uploaded audio media_id.`,
          ],
        }
      }, args.video_id),
  )

  const addNarrationTool = server.registerTool(
    'add_narration',
    {
      title: 'Add a recording to the narration',
      description: `Place an uploaded audio recording on your draft of the video's latest ready version, starting at start_seconds into the video. It plays whole; a later clip wins where two overlap. Saves the draft; nothing is rendered until render_with_narration.

Media ids only: upload the recording first (see the skill's narration page), or pick an audio item from list_media. URLs aren't fetched.
It takes the video's narration lock (one person at a time edits a narration; the hold lapses 2 minutes after this call). When someone else holds it, the answer is NARRATION_LOCKED with who: wait for them or ask them to close the editor.
language sets the language spoken in the video, which its narration captions are transcribed in (owner or admin).

Example: {"video_id": "vid_01jc8x2k4m5n6p7q8r9s0t1v2w", "media_id": "med_01jc8x2k4m5n6p7q", "start_seconds": 1.5}`,
      inputSchema: {
        video_id: z.string().describe('The video id (vid_…) or its web URL.'),
        media_id: z
          .string()
          .max(64)
          .describe('An uploaded audio recording (med_…), from list_media or an upload.'),
        start_seconds: z
          .number()
          .min(0)
          .max(MAX_OUTPUT_SAMPLES / SAMPLE_RATE)
          .describe('Where in the video the recording starts, in seconds.'),
        gain_db: z
          .number()
          .min(GAIN_DB_RANGE[0])
          .max(GAIN_DB_RANGE[1])
          .optional()
          .describe(
            `Optional. The clip's level in dB, ${GAIN_DB_RANGE[0]} to ${GAIN_DB_RANGE[1]} (default 0).`,
          ),
        language: z
          .enum(LANGUAGES)
          .optional()
          .describe("Optional. The language spoken (en, es, fr, de, ja, …), if not the video's current one."),
      },
      annotations: {
        title: 'Add narration',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args) =>
      run(async () => {
        const id = normalizeVideoId(args.video_id)
        const v = await load(id)
        // Unavailable reads the same as missing, so a recording's existence doesn't leak.
        const m = await deps.store.getMedia(args.media_id)
        const readable =
          m?.kind === 'audio' &&
          m.status === 'ready' &&
          !m.deletedAt &&
          !m.deletingAt &&
          (await canReadMedia(deps.store, principal, m))
        if (!m || !readable)
          throw new ToolError('NOT_FOUND', `No audio recording ${args.media_id} that you can use.`, {
            fix_hint: 'Upload the recording first, or pick an audio item from list_media.',
            suggested_tool_calls: [{ name: 'list_media', arguments: { kind: 'audio' } }],
          })
        const { samples } = await takeSummary(deps, m)
        if (!samples)
          throw new ToolError('NOT_READY', `Recording ${m.id} can't be placed yet: its length isn't known.`)
        if (args.language && args.language !== v.language)
          await updateVideo(deps, principal, id, { language: args.language })
        const n = await readyVersion(id)
        const { edit } = await openEdit(deps, principal, id, n)
        await acquireNarrationLock(deps, principal, id, { draftId: edit.id })
        const op = narrationOf(edit.ops) ?? newNarration()
        if (op.clips.length >= MAX_NARRATION_CLIPS)
          throw new ToolError('INVALID_ARGUMENT', `A narration has at most ${MAX_NARRATION_CLIPS} clips.`)
        const ids = new Set(op.clips.map((c) => c.id))
        let k = op.clips.length + 1
        while (ids.has(`c${k}`)) k++
        const clip = {
          id: `c${k}`,
          mediaId: m.id,
          srcStart: 0,
          srcEnd: samples,
          fit: IDENTITY_FIT,
          offsetSamples: 0,
          start: secondsToSamples(args.start_seconds),
          gainDb: args.gain_db ?? 0,
          fadeInSamples: 0,
          fadeOutSamples: 0,
        }
        const next: NarrationOp = { ...op, clips: [...op.clips, clip] }
        const ops: DraftOp[] = [...edit.ops.filter((o) => o.op !== 'narration'), next]
        // The same checks as a save from the editor: the lock, the recordings, the clips and the output limit.
        const saved = await saveEdit(deps, principal, edit.id, { ops, rev: edit.rev })
        return {
          video_id: id,
          version: n,
          edit_id: saved.id,
          clip_id: clip.id,
          language: args.language ?? v.language,
          narration: narrationSummary(next),
          video_seconds: Math.round(saved.composition.duration * 100) / 100,
          next_actions: [
            `Add more recordings with add_narration, or render: call render_with_narration with video_id "${id}" (a run that costs credits; confirm with your user first).`,
          ],
        }
      }, args.video_id),
  )

  const renderNarrationTool = server.registerTool(
    'render_with_narration',
    {
      title: 'Render a video with your narration',
      description: `Render your draft (with the narration from add_narration or the editor) as the next version. "keep_visuals" keeps the video exactly as it is and mixes your narration over it; music dips under the voice and captions follow your words. hold_final_frame holds the last frame when the narration runs past the end (instead of cutting it off).
"fit_to_narration" is an authoring run (about 250 credits, against about 34 for keep_visuals): the agent retimes, extends or tightens the scenes so the video ends half a second after the last word. It never changes the narration and always replaces the AI voice-over (whatever the draft's AI voice setting); hold_final_frame doesn't apply. A draft without narration is refused.

Each render starts a run that costs credits: confirm with your user first, with the cost. Returns at once; follow it with get_video.

Example: {"video_id": "vid_01jc8x2k4m5n6p7q8r9s0t1v2w", "mode": "keep_visuals", "hold_final_frame": true}`,
      inputSchema: {
        video_id: z.string().describe('The video id (vid_…) or its web URL.'),
        edit_id: z
          .string()
          .max(64)
          .optional()
          .describe(
            'Optional. The draft (from add_narration); default: your draft of the latest ready version.',
          ),
        mode: z
          .enum(['keep_visuals', 'fit_to_narration'])
          .describe(
            '"keep_visuals" (the visuals as they are) or "fit_to_narration" (the agent fits the scenes to the narration).',
          ),
        hold_final_frame: z
          .boolean()
          .optional()
          .describe(
            'Optional. Hold the last frame while the narration finishes (default false: it is cut off).',
          ),
        idempotency_key: z
          .string()
          .max(200)
          .optional()
          .describe('Optional. Reusing the same key returns the same render instead of a second one.'),
      },
      annotations: { title: 'Render with narration', ...STARTS_RUN },
    },
    (args) =>
      run(async () => {
        const id = normalizeVideoId(args.video_id)
        const edit = args.edit_id
          ? await getEdit(deps, principal, args.edit_id).then((e) => ({
              id: e.id,
              jobId: e.videoId,
              ops: e.ops,
            }))
          : await ownDraft(id, await readyVersion(id))
        if (!edit || edit.jobId !== id)
          throw new ToolError('NOT_FOUND', 'You have no draft of this video.', {
            fix_hint: 'Add a recording with add_narration first.',
          })
        if (!narrationOf(edit.ops)?.clips.length)
          throw new ToolError('INVALID_ARGUMENT', 'This draft has no narration to render.', {
            fix_hint: 'Add a recording with add_narration first.',
            suggested_tool_calls: [{ name: 'get_narration', arguments: { video_id: id } }],
          })
        const res = await renderEdit(deps, principal, edit.id, args.idempotency_key, {
          mode: args.mode,
          holdFinalFrame: args.hold_final_frame,
        })
        return queued(res, `Version ${res.body.latestVersion} is rendering. ${KEEP_CHECKING(id)}`)
      }, args.video_id),
  )

  // Keys inherit their owner's role, so the tool list shows only what that role can do (plan v2 §3).
  if (!can(principal, 'video:create')) {
    for (const t of [createTool, reviseTool, remixTool, publishTool, unpublishTool, listDestinationsTool])
      t.remove()
  }
  if (!can(principal, 'media:upload')) {
    searchMusicTool.remove()
    importMusicTool.remove()
    musicJobTool.remove()
  }
  if (!can(principal, 'edit:create')) {
    addNarrationTool.remove()
    renderNarrationTool.remove()
  }
  if (!can(principal, 'verdict:set')) verdictTool.remove()
  if (!can(principal, 'comment:create')) addCommentTool.remove()
  const canPlan = can(principal, 'plan:create') && deps.gateway.available()
  if (!canPlan) {
    planVideoTool.remove()
    planBriefTool.remove()
  }
  registerPrompts(server, {
    create: can(principal, 'video:create'),
    review: can(principal, 'comment:create') && can(principal, 'verdict:set'),
    planning: canPlan,
  })
  return server
}

/** Handles one MCP HTTP request (stateless: a fresh server and transport per request). */
export async function handleMcp(
  deps: Deps,
  principal: Principal,
  req: Request,
  kick: () => void,
): Promise<Response> {
  const engines = (await enabledEngines(deps)).map((e) => e.id)
  const server = buildMcpServer(deps, principal, kick, { engines })
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true }) // no sessionIdGenerator: stateless
  await server.connect(transport)
  // Kept to explain a refused request (and, verbose, to log the call); the transport reads the original.
  const copy = req.method === 'POST' ? req.clone() : null
  const seen = deps.log.verbose && req.method === 'POST' ? req.clone() : null
  const started = Date.now()
  try {
    const res = await transport.handleRequest(req)
    if (res.status >= 400 && res.status < 500) await logRefused(deps, principal, req, copy, res)
    if (seen) await logCall(deps, principal, seen, res, started)
    return res
  } finally {
    void server.close()
  }
}

/** DEBUG_LEVEL=verbose: each MCP call (tool names and arguments, which carry prompts) and how it ended. */
async function logCall(deps: Deps, principal: Principal, req: Request, res: Response, started: number) {
  let calls: unknown
  try {
    const body: unknown = JSON.parse(await req.text())
    calls = (Array.isArray(body) ? body : [body]).map((m: { method?: unknown; params?: unknown }) => ({
      method: m.method ?? null,
      ...(m.method === 'tools/call' && m.params && typeof m.params === 'object'
        ? {
            tool: (m.params as { name?: unknown }).name ?? null,
            arguments: clip(JSON.stringify((m.params as { arguments?: unknown }).arguments ?? {}), 8000),
          }
        : {}),
    }))
  } catch {
    calls = 'not JSON'
  }
  let isError: boolean | null
  try {
    const out = (await res.clone().json()) as { result?: { isError?: boolean }; error?: unknown }
    isError = Boolean(out.error) || out.result?.isError === true
  } catch {
    isError = null
  }
  deps.log.debug('mcp.call', {
    userId: principal.userId,
    via: principal.kind,
    calls,
    status: res.status,
    isError,
    ms: Date.now() - started,
    client: req.headers.get('user-agent')?.slice(0, 160) ?? null,
  })
}

/**
 * Why the transport refused a request (4xx), for the logs: the JSON-RPC methods asked for, the headers that decide
 * how it's handled and the transport's own message. Never the arguments, tokens or other headers.
 */
async function logRefused(
  deps: Deps,
  principal: Principal,
  req: Request,
  copy: Request | null,
  res: Response,
) {
  let methods: string[] | null = null
  let parse: string | null = null
  if (copy) {
    try {
      const body: unknown = JSON.parse(await copy.text())
      const msgs = Array.isArray(body) ? body : [body]
      methods = msgs.map((m) =>
        m && typeof m === 'object' && 'method' in m
          ? String((m as { method: unknown }).method).slice(0, 80)
          : 'id' in (m as object)
            ? '(response)'
            : '(none)',
      )
    } catch {
      parse = 'not JSON'
    }
  }
  let message: string | null
  try {
    const out = (await res.clone().json()) as { error?: { message?: unknown } }
    message = typeof out.error?.message === 'string' ? out.error.message.slice(0, 300) : null
  } catch {
    message =
      (
        await res
          .clone()
          .text()
          .catch(() => '')
      ).slice(0, 300) || null
  }
  const h = (name: string) => req.headers.get(name)?.slice(0, 200) ?? null
  deps.log.warn('mcp.refused', {
    status: res.status,
    httpMethod: req.method,
    methods,
    ...(parse ? { body: parse } : {}),
    message,
    protocolVersion: h('mcp-protocol-version'),
    sessionId: req.headers.has('mcp-session-id'),
    accept: h('accept'),
    contentType: h('content-type'),
    userAgent: h('user-agent'),
    principal: principal.kind,
  })
}
