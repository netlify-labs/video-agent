// Request and response schemas: one definition drives validation, types, the OpenAPI spec and the
// web app's generated client.
import { z } from '@hono/zod-openapi'
import { SOUNDS } from './domain/types.js'
import { MAX_NARRATION } from './lib/contract.js'
import { LANGUAGES } from './lib/language.js'
import {
  GAIN_DB_RANGE,
  MAX_FADE_SAMPLES,
  MAX_CLIP_ALTERNATIVES,
  MAX_NARRATION_CLIPS,
  MAX_OUTPUT_SAMPLES,
  NARRATION_CLEANUP_PRESETS,
  SAMPLE_RATE,
  maxFade,
} from './lib/timeline.js'
import { SPEED_RANGE, VOICE_ID } from './lib/voice.js'
import { MEDIA_KINDS } from './lib/media/classify.js'

export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: 'not_found' }),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .openapi('Error')

export const AspectSchema = z.enum(['16:9', '9:16', '1:1', '4:5']).openapi('Aspect')
export const SoundSchema = z.enum(SOUNDS).openapi('Sound', {
  description:
    'silent: no audio (the default). music: a music bed (a picked audio item, else the brand music in context/, else none). music_sfx: music plus sound effects on visible actions.',
})
/** A voice-over request (docs/spikes.md S9). `enabled: false` turns it off; omitted fields are left to the run. */
export const VoiceoverInputSchema = z
  .object({
    enabled: z.boolean(),
    voice: z.string().regex(VOICE_ID).optional().openapi({
      description:
        'A Kokoro voice (af_heart, af_nova, af_sky, am_adam, am_michael, bf_emma, bf_isabella, bm_george, …) or, when the deployment has an ElevenLabs key, an ElevenLabs voice id. Default: af_heart (or the ElevenLabs default).',
    }),
    speed: z
      .number()
      .min(SPEED_RANGE[0])
      .max(SPEED_RANGE[1])
      .optional()
      .openapi({ description: 'Default 1.' }),
    script: z.array(z.string().trim().min(1).max(600)).max(12).optional().openapi({
      description:
        "The narration, one line per beat in order, spoken word for word. Omit to let the plan's narration or the agent write it.",
    }),
  })
  .openapi('VoiceoverInput')
// Nullable spots use the plain shape (openapi-typescript can't express a nullable $ref).
export const voiceoverShape = z.object({
  voice: z.string().nullable(),
  speed: z.number().nullable(),
  script: z.array(z.string()).nullable(),
})
export const StatusSchema = z
  .enum(['queued', 'running', 'finishing', 'ready', 'failed', 'cancelled', 'timed_out'])
  .openapi('VideoStatus')
const MusicPickSchema = z
  .object({
    status: z.enum(['searching', 'importing', 'picked', 'skipped']),
    query: z.string().nullable().openapi({ description: 'The Openverse search words' }),
    title: z.string().nullable().openapi({ description: "The chosen track's title, once one is chosen" }),
    mediaId: z.string().nullable().openapi({ description: 'The library item the track became, once picked' }),
    reason: z.string().nullable().openapi({ description: 'Why the pick was skipped' }),
    source: z.enum(['openverse', 'library']).nullable().openapi({
      description:
        "Where the picked track came from: an Openverse search, or the team's library when Openverse found none in time. Null until picked",
    }),
    tried: z
      .array(
        z.object({
          query: z.string(),
          outcome: z.enum(['searching', 'failed', 'empty', 'chosen', 'import_failed']).openapi({
            description:
              "searching: in progress. failed: Openverse didn't answer. empty: nothing importable. chosen: a track was chosen from it. import_failed: that track couldn't be imported",
          }),
        }),
      )
      .openapi({ description: 'The Openverse searches tried so far, in order (at most 7)' }),
  })
  .openapi('MusicPick', {
    description:
      "Music the server picked before the run, because the version asked for music and had no track: from Openverse, or from the team's library when Openverse found none in time.",
  })
export const StageSchema = z
  .enum([
    'queued',
    'finding_music',
    'starting',
    'running',
    'cancelling',
    'unresolved',
    'finishing',
    'ready',
    'failed',
    'cancelled',
    'timed_out',
  ])
  .openapi('Stage')

const UsageSchema = z
  .object({
    totalCreditsCost: z.number().optional(),
    totalTokens: z.number().optional(),
    stepsCount: z.number().optional(),
  })
  .openapi('Usage')

export const CreditSchema = z
  .object({
    mediaId: z.string().nullable().openapi({
      description:
        'The library item, or null for music or a sound effect the run fetched from Openverse itself',
    }),
    kind: z.enum(MEDIA_KINDS),
    role: z.string().openapi({ example: 'Music' }),
    title: z.string(),
    creator: z.string().nullable(),
    creatorUrl: z.string().nullable(),
    license: z.string().openapi({ example: 'by' }),
    licenseLabel: z.string().openapi({ example: 'CC BY 4.0' }),
    licenseUrl: z.string().nullable(),
    sourceUrl: z.string().nullable().openapi({ description: 'The work on its source site' }),
    source: z.string().openapi({ example: 'openverse' }),
    text: z.string().openapi({ example: '"Calm Piano" by Ada, CC BY 4.0, https://www.jamendo.com/track/1' }),
  })
  .openapi('Credit')

export const PublicationSchema = z
  .object({
    slug: z.string(),
    versionN: z.number().int(),
    publishedAt: z.string(),
    unpublishedAt: z.string().nullable(),
    urls: z
      .object({
        page: z.string(),
        mp4: z.string(),
        poster: z.string(),
        gif: z.string(),
        captions: z.string(),
        posterWebp: z
          .string()
          .optional()
          .describe('A 960px-wide WebP poster, for versions rendered with preview variants.'),
        narration: z
          .string()
          .optional()
          .describe('The recorded narration as an MP3, for versions that have one.'),
        transcript: z
          .string()
          .optional()
          .describe("The narration's transcript as plain text, when the publication shows it."),
      })
      .nullable(),
    showTranscript: z.boolean().describe("Whether the share page offers the narration's transcript."),
    embed: z.string().nullable().openapi({
      description: 'HTML to embed the video; with CC BY media it includes the credit line as a caption',
    }),
  })
  .openapi('Publication')

export const PublishSchema = z
  .object({
    showTranscript: z
      .boolean()
      .optional()
      .describe(
        "Offer the narration's transcript on the share page. Default off; publishing again changes only this.",
      ),
  })
  .openapi('Publish')

export const CaptionCueSchema = z
  .object({
    id: z.string().min(1).max(64),
    start: z.number().min(0),
    end: z.number().min(0),
    text: z.string().max(2000),
  })
  .openapi('CaptionCue')

export const ReviseCaptionsSchema = z
  .object({
    expectedRev: z
      .number()
      .int()
      .min(0)
      .describe('The revision the corrections are based on (versions[].captions.rev).'),
    cues: z
      .array(CaptionCueSchema)
      .max(2000)
      .describe(
        'Every cue of the current captions, in order, with the same ids and timings; only text may change.',
      ),
  })
  .openapi('ReviseCaptions')

export const VersionCaptionsSchema = z
  .object({
    status: z
      .enum(['ok', 'failed', 'off', 'timeout'])
      .describe("How the narration's transcription went; anything but ok means no narration cues."),
    policy: z.enum(['sidecar', 'burned']).describe('Burned-in captions are corrected by rendering again.'),
    rev: z.number().int().describe('Bumped by every correction; send it back as expectedRev.'),
  })
  .openapi('VersionCaptions')

export const VerdictSchema = z.enum(['approved', 'changes_requested']).openapi('Verdict')
export const SetVerdictSchema = z
  .object({ verdict: VerdictSchema.nullable(), note: z.string().max(500).optional() })
  .openapi('SetVerdict')

export const planBriefShape = z.object({
  // A short name for the video; it becomes the video's title unless the person gave one.
  title: z.string().max(120).optional(),
  goal: z.string().max(400),
  audience: z.string().max(300),
  keyMessage: z.string().max(300),
  beats: z
    .array(
      z.object({
        text: z.string().max(300),
        seconds: z.number().min(0).max(600),
        // The spoken line for this beat when the video has a voice-over.
        narration: z.string().max(600).optional(),
      }),
    )
    .max(12),
  tone: z.string().max(200),
  callToAction: z.string().max(200),
  mustInclude: z.array(z.string().max(200)).max(10),
  avoid: z.array(z.string().max(200)).max(10),
  // Set by the planner from the request when the person left Sound or Voice-over untouched: the request wins.
  sound: z.enum(['silent', 'music', 'music_sfx']).optional(),
  voiceover: z.boolean().optional(),
})
// Registered for non-null uses; nullable spots use the plain shape (openapi-typescript can't express a nullable $ref).
export const PlanBriefSchema = planBriefShape.openapi('PlanBrief')

export const VersionSchema = z
  .object({
    plan: z
      .object({
        planId: z.string(),
        brief: PlanBriefSchema,
        answers: z.array(
          z.object({ question: z.string(), answer: z.union([z.string(), z.array(z.string())]) }),
        ),
      })
      .nullable()
      .describe('The plan accepted before this version was made, if any.'),
    verdicts: z.object({
      approved: z.number().int(),
      changesRequested: z.number().int(),
      mine: VerdictSchema.nullable(),
    }),
    incorporates: z.number().int().describe('How many comments this version was asked to incorporate.'),
    editable: z
      .boolean()
      .describe('Ready and keeps editing contract v1, so it can be edited in the browser.'),
    mode: z
      .enum(['author', 'render_unchanged'])
      .describe(
        'render_unchanged: an edit made in the browser, rendered as is (no agent authoring). author: an agent run, including an edit fitted to its recorded narration (editedFromN set).',
      ),
    editedFromN: z
      .number()
      .int()
      .nullable()
      .describe(
        'The version an edit made in the browser started from: rendered as is, or (mode author) fitted to its recorded narration.',
      ),
    n: z.number().int(),
    status: StatusSchema,
    prompt: z.string(),
    authorId: z.string(),
    parentN: z.number().int().nullable(),
    targetDurationSec: z.number().nullable(),
    sound: SoundSchema,
    voiceover: voiceoverShape
      .nullable()
      .openapi({ description: 'The voice-over, or null when there is none.' }),
    createdAt: z.string(),
    attempts: z.number().int(),
    stage: StageSchema.nullable(),
    latestStep: z.string().nullable(),
    music: MusicPickSchema.nullable().openapi({
      description: 'The music the server picked before the run (null when none was needed).',
    }),
    error: z.object({ category: z.string(), message: z.string() }).nullable(),
    agent: z
      .object({
        agent: z.string(),
        model: z.string().nullable(),
        effort: z.string().nullable(),
        deployId: z.string().nullable(),
        promptTemplateVersion: z.number().int(),
      })
      .nullable(),
    usage: UsageSchema.nullable(),
    timings: z
      .object({
        queuedAt: z.string(),
        startedAt: z.string().nullable(),
        finishingAt: z.string().nullable(),
        endedAt: z.string().nullable(),
      })
      .nullable(),
    output: z
      .object({
        durationSec: z.number(),
        width: z.number().int(),
        height: z.number().int(),
        bytes: z.number().int(),
        title: z.string(),
        summary: z.string(),
        notices: z
          .array(z.string())
          .describe(
            'Things to know about the video, kept despite them, e.g. a length far from the one asked for',
          ),
      })
      .nullable(),
    captions: VersionCaptionsSchema.nullable().describe(
      'Recorded narration captions and their current correction; null: the render’s own captions.',
    ),
    links: z.object({
      video: z.string(),
      poster: z.string(),
      gif: z.string(),
      captions: z.string(),
      narrationAudio: z
        .string()
        .optional()
        .describe('The recorded narration as a 192 kbps MP3; only versions with recorded narration.'),
      transcript: z
        .string()
        .optional()
        .describe(
          "The narration's transcript as plain text (the latest caption revision); only when there is one.",
        ),
      netlifyRun: z.string().nullable(),
    }),
    files: z
      .object({
        poster: z.string(),
        gif: z.string(),
        posterSources: z
          .array(z.object({ type: z.enum(['image/avif', 'image/webp']), srcset: z.string() }))
          .optional()
          .describe(
            'Smaller poster images (480 and 960 px wide), best format first, ready for <picture><source>. Only for versions rendered with them.',
          ),
        clip: z
          .array(z.object({ type: z.enum(['video/webm', 'video/mp4']), src: z.string() }))
          .optional()
          .describe(
            'A short muted preview clip (480 px wide, a few seconds), best format first, ready for <video><source>. Use instead of the GIF when present.',
          ),
        lqip: z
          .string()
          .optional()
          .describe('A tiny blurred poster as a data URI, to show while the poster loads.'),
      })
      .nullable()
      .describe(
        'Signed URLs for the poster and preview GIF, once the version has files (30 to 60 minutes; 5 to 10 for private videos). Use links for a fresh one.',
      ),
    credits: z.array(CreditSchema).openapi({
      description:
        'CC BY media this version was made with (Openverse music from the library, or fetched by the run itself): show the credit wherever the video is shown',
    }),
    publications: z.array(PublicationSchema),
  })
  .openapi('Version')

export const LanguageSchema = z.enum(LANGUAGES).openapi('Language', {
  description:
    'The language spoken in the video (BCP-47 primary subtag): recorded narration is transcribed for captions in it. The local transcriber covers the European languages; the others need ElevenLabs.',
  example: 'en',
})

export const VideoSchema = z
  .object({
    id: z.string().openapi({ example: 'vid_01jc8k0000000000000000000' }),
    title: z.string(),
    aspect: AspectSchema,
    dimensions: z.object({ width: z.number().int(), height: z.number().int() }),
    status: StatusSchema,
    owner: z.object({ id: z.string(), name: z.string().nullable(), email: z.string().nullable() }),
    latestVersion: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
    etag: z.string(),
    versions: z.array(VersionSchema),
    published: z.boolean(),
    private: z.boolean(),
    language: LanguageSchema,
    comments: z.object({
      count: z.number().int(),
      unread: z.number().int().openapi({ description: "Others' comments since you last read them" }),
    }),
    isRemix: z.boolean().openapi({ description: 'This video was remixed from another one' }),
    remixOf: z
      .object({ id: z.string(), n: z.number().int(), title: z.string() })
      .nullable()
      .openapi({ description: 'The video (and version) this one was remixed from, when you can see it' }),
    favorite: z.boolean().openapi({ description: 'You starred this video (only you see your favorites)' }),
    links: z.object({ self: z.string() }),
  })
  .openapi('Video')

export const VideoListSchema = z
  .object({ items: z.array(VideoSchema), nextCursor: z.string().nullable() })
  .openapi('VideoList')

export const CreateVideoSchema = z
  .object({
    prompt: z
      .string()
      .min(10)
      .max(4000)
      .openapi({ example: 'A 20-second launch video for our new webhooks feature' }),
    aspect: AspectSchema.optional(),
    durationSec: z
      .number()
      .int()
      .positive()
      .optional()
      .openapi({ description: 'Target length in seconds. Omit for Auto.' }),
    title: z.string().min(1).max(120).optional(),
    planId: z
      .string()
      .optional()
      .openapi({ description: 'A plan from POST /api/v1/plans; its brief is added to the run. Optional.' }),
    webhookUrl: z
      .url()
      .optional()
      .openapi({ description: 'HTTPS URL for video.ready / video.failed events (API keys only).' }),
    mediaIds: z.array(z.string()).max(12).optional().openapi({
      description: 'Library items (GET /api/v1/media) the agent should use: images, clips, fonts, audio.',
    }),
    sound: SoundSchema.optional().openapi({
      description: "Omit for the plan's choice, else music when an audio item is picked, else silent.",
    }),
    voiceover: VoiceoverInputSchema.optional().openapi({
      description: "A spoken narration with captions from its words. Omit for the plan's choice, else none.",
    }),
  })
  .openapi('CreateVideo')

export const ReviseSchema = z
  .object({
    prompt: z.string().min(3).max(4000),
    fromVersion: z.number().int().positive().optional(),
    durationSec: z.number().int().positive().optional(),
    webhookUrl: z.url().optional(),
    planId: z.string().optional(),
    mediaIds: z.array(z.string()).max(12).optional().openapi({
      description: 'Library items (GET /api/v1/media) the agent should use: images, clips, fonts, audio.',
    }),
    sound: SoundSchema.optional().openapi({
      description:
        "Omit to keep the revised version's sound (or the plan's choice; a new audio pick on a silent video turns on music).",
    }),
    voiceover: VoiceoverInputSchema.optional().openapi({
      description:
        "Omit to keep the revised version's voice-over (or the plan's choice); unchanged lines keep their audio.",
    }),
    commentIds: z.array(z.string()).max(50).optional().openapi({
      description:
        'Incorporate feedback: open comments on the version being revised (owner or admin). prompt is your note.',
    }),
  })
  .openapi('Revise')

export const RemixSchema = z
  .object({
    prompt: z.string().min(3).max(4000).openapi({
      description: 'What to change: anything from swapping a name to the same format on a new topic.',
      example: 'Same video, but for our payments API instead of webhooks.',
    }),
    fromVersion: z
      .number()
      .int()
      .positive()
      .optional()
      .openapi({ description: 'The version to remix. Omit for the latest ready one.' }),
    aspect: AspectSchema.optional().openapi({ description: "Omit to keep the source's shape." }),
    language: LanguageSchema.optional().openapi({ description: "Omit to keep the source's language." }),
    durationSec: z
      .number()
      .int()
      .positive()
      .optional()
      .openapi({ description: "Target length in seconds. Omit to keep the source's." }),
    sound: SoundSchema.optional().openapi({ description: "Omit to keep the source's sound." }),
    voiceover: VoiceoverInputSchema.optional().openapi({
      description:
        "Omit to keep the source's AI voice-over settings. Recorded narration is never carried over.",
    }),
    mediaIds: z.array(z.string()).max(12).optional().openapi({
      description: "The remix's library media: replaces the source's set. Omit to keep the source's set.",
    }),
    planId: z
      .string()
      .optional()
      .openapi({ description: 'A plan made with remixOf for this same video and version.' }),
    webhookUrl: z
      .url()
      .optional()
      .openapi({ description: 'HTTPS URL for video.ready / video.failed events (API keys only).' }),
  })
  .openapi('Remix')

export const UpdateVideoSchema = z
  .object({
    title: z.string().min(1).max(120).optional(),
    private: z.boolean().optional(),
    language: LanguageSchema.optional(),
  })
  .refine((v) => v.title !== undefined || v.private !== undefined || v.language !== undefined, {
    message: 'Send title, private or language.',
  })
  .openapi('UpdateVideo')

export const KeySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
    revokedAt: z.string().nullable(),
  })
  .openapi('ApiKey')
export const NewKeySchema = KeySchema.extend({
  key: z.string().openapi({ description: 'Shown once.' }),
  webhookSecret: z
    .string()
    .openapi({ description: 'Signs webhooks for videos created with this key. Shown once.' }),
}).openapi('NewApiKey')
export const OAuthGrantSchema = z
  .object({
    id: z.string(),
    clientId: z.string(),
    clientName: z.string(),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
  })
  .openapi('OAuthGrant')
export const CreateKeySchema = z.object({ name: z.string().min(1).max(80) }).openapi('CreateApiKey')

export const RoleSchema = z.enum(['admin', 'creator', 'reviewer', 'viewer']).openapi('Role')
export const UserSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    role: RoleSchema,
    admittedVia: z.enum(['domain', 'invite']),
    createdAt: z.string(),
    lastSeenAt: z.string(),
    disabled: z.boolean(),
    signInMethods: z
      .array(z.string())
      .describe(
        "How the person signs in: 'identity' (Netlify Identity) and/or 'netlify' (Sign in with Netlify).",
      ),
  })
  .openapi('User')
const PlanQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  why: z.string(),
  options: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      description: z.string(),
      recommended: z.boolean().optional().describe("The planner's recommended option; it is listed first."),
    }),
  ),
  multiSelect: z.boolean(),
  allowOther: z.boolean(),
})
export const PlanAnswerSchema = z.object({
  questionId: z.string(),
  optionIds: z.array(z.string()).max(4).optional(),
  other: z.string().max(500).optional(),
  skipped: z.boolean().optional(),
})

export const PlanSchema = z
  .object({
    id: z.string(),
    prompt: z.string(),
    revisionOf: z.object({ videoId: z.string(), version: z.number().int().nullable() }).nullable(),
    remixOf: z
      .object({ videoId: z.string(), version: z.number().int().nullable() })
      .nullable()
      .openapi({ description: 'The video and version this plan remixes, for a remix plan.' }),
    route: z
      .object({
        needsQuestions: z.boolean(),
        template: z.string(),
        suggestedAspect: z.enum(['16:9', '9:16', '1:1', '4:5']).nullable(),
      })
      .nullable(),
    questions: z.array(PlanQuestionSchema).nullable(),
    answers: z.array(PlanAnswerSchema).nullable(),
    brief: planBriefShape.nullable(),
    briefRev: z.number().int(),
    mediaIds: z.array(z.string()).openapi({ description: 'Library items attached while planning.' }),
    sound: SoundSchema.nullable().openapi({ description: 'The Sound chosen while planning, if any.' }),
    voiceover: voiceoverShape.nullable().openapi({
      description: 'The voice-over chosen while planning, if any; the brief then has narration per beat.',
    }),
    expiresAt: z.string(),
  })
  .openapi('Plan')
export const CreatePlanSchema = z
  .object({
    prompt: z.string().min(1).max(4000),
    aspect: z.enum(['16:9', '9:16', '1:1', '4:5']).optional(),
    durationSec: z.number().int().min(3).max(600).optional(),
    revisionOf: z.object({ videoId: z.string(), version: z.number().int().optional() }).optional(),
    remixOf: z
      .object({ videoId: z.string(), version: z.number().int().optional() })
      .optional()
      .openapi({
        description:
          'Plan a remix of this video (and version, else its latest ready one); not with revisionOf.',
      }),
    mediaIds: z.array(z.string()).max(12).optional().openapi({
      description:
        'Library items to plan around. The planner sees the first few images; the video made from this plan uses them all.',
    }),
    sound: SoundSchema.optional(),
    voiceover: VoiceoverInputSchema.optional(),
  })
  .openapi('CreatePlan')
export const PlanAnswersSchema = z
  .object({ answers: z.array(PlanAnswerSchema).max(6) })
  .openapi('PlanAnswers')
export const PatchPlanSchema = z
  .object({
    brief: PlanBriefSchema,
    briefRev: z
      .number()
      .int()
      .optional()
      .describe('The briefRev you loaded; the save is refused if it changed (If-Match also works).'),
  })
  .openapi('PatchPlan')

export const MyUsageSchema = z
  .object({
    since: z.string(),
    runs: z.object({ credits: z.number(), videos: z.number().int(), unknown: z.boolean() }),
    planning: z.object({ credits: z.number(), calls: z.number().int(), unknown: z.number().int() }),
  })
  .openapi('MyUsage')

export const MediaSourceSchema = z
  .object({
    name: z.enum(['openverse']),
    id: z.string().openapi({ description: 'Its id at the source' }),
    url: z.string().nullable().openapi({ description: 'The landing page of the work' }),
    title: z.string().nullable(),
    creator: z.string().nullable(),
    creatorUrl: z.string().nullable(),
    license: z.string().openapi({ description: 'cc0 or by' }),
    licenseVersion: z.string().nullable(),
    licenseLabel: z.string().openapi({ example: 'CC BY 4.0' }),
    licenseUrl: z.string().nullable(),
    attribution: z.string().nullable().openapi({ description: "The source's own attribution text" }),
    creditRequired: z
      .boolean()
      .openapi({ description: 'True for CC BY: videos that use it credit it (CC0 needs no credit)' }),
  })
  .openapi('MediaSource')

export const RecordingSchema = z
  .object({
    role: z.enum(['narration-take', 'narration-upload']).openapi({
      description: 'A voice-over recording (take) or uploaded narration',
    }),
    videoId: z
      .string()
      .nullable()
      .openapi({ description: 'The video it was made for; null if you can no longer see it' }),
    usedIn: z
      .array(
        z.union([
          z.object({ kind: z.literal('version'), videoId: z.string(), n: z.number().int() }),
          z.object({ kind: z.literal('draft'), videoId: z.string(), draftId: z.string() }),
        ]),
      )
      .openapi({ description: 'Versions of videos you can see, and your own drafts, that use it' }),
    retainUntil: z.string().nullable().openapi({
      description: "When it's deleted if nothing uses it by then; null while a draft or version uses it",
    }),
  })
  .openapi('Recording')
export const MediaSchema = z
  .object({
    id: z.string(),
    kind: z.enum(MEDIA_KINDS),
    status: z.enum(['uploading', 'verifying', 'ready', 'rejected']),
    rejectReason: z.string().nullable(),
    filename: z.string(),
    title: z
      .string()
      .nullable()
      .openapi({ description: 'The name given in the library; null shows the file name' }),
    caption: z
      .string()
      .nullable()
      .openapi({ description: 'Notes on the item. The planner and the agent read them.' }),
    mime: z.string(),
    bytes: z.number().int(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    durationSec: z.number().nullable(),
    uploader: z.object({ id: z.string(), name: z.string().nullable(), email: z.string().nullable() }),
    createdAt: z.string(),
    usedIn: z.number().int().openapi({ description: 'Videos you can see that use it' }),
    urls: z
      .object({ file: z.string(), original: z.string(), poster: z.string().nullable() })
      .nullable()
      .openapi({ description: 'Signed for 10 minutes; null until the item is ready' }),
    canDelete: z.boolean(),
    source: MediaSourceSchema.nullable().openapi({
      description: 'Where an imported item came from (Openverse), with its licence; null for uploads',
    }),
    recording: RecordingSchema.nullable().openapi({
      description:
        'For a voice-over recording: its video, where it is used and how long it is kept; null otherwise',
    }),
  })
  .openapi('Media')
export const UploadSessionSchema = z
  .object({
    id: z.string(),
    filename: z.string(),
    size: z.number().int(),
    partSize: z.number().int(),
    partCount: z.number().int(),
    uploaded: z
      .array(z.number().int())
      .openapi({ description: 'Part indexes already received (resume from here)' }),
    status: z.enum(['open', 'assembling', 'done', 'failed']),
    mediaId: z.string().nullable(),
    error: z.string().nullable(),
    expiresAt: z.string(),
    role: z.enum(['narration-take', 'narration-upload']).nullable().openapi({
      description: 'A voice-over recording (take) or uploaded narration; null for library uploads',
    }),
    scopeJobId: z.string().nullable().openapi({ description: 'The video a recording is for' }),
  })
  .openapi('UploadSession')

// A take's waveform peaks and speech spans (voice-over plan §5.1, §6.1).
export const TakePeaksStoredSchema = z
  .object({
    mediaId: z.string(),
    bytes: z.number().int(),
    levels: z.number().int(),
    samples: z.number().int().openapi({ description: 'Source length in samples at 24 kHz' }),
  })
  .openapi('TakePeaksStored')
export const SpeechSummarySchema = z
  .object({
    version: z.number().int().min(1).openapi({ description: 'The VAD version the spans were measured with' }),
    spans: z
      .array(z.tuple([z.number().int().min(0), z.number().int().min(0)]))
      .max(10_000)
      .openapi({
        description: 'Speech as [start, end) in source samples at 24 kHz, in order, not overlapping',
      }),
    samples: z
      .number()
      .int()
      .positive()
      .optional()
      .openapi({ description: "The recording's length in samples at 24 kHz (filled in when it's checked)" }),
  })
  .openapi('SpeechSummary')

export const OpenverseTrackSchema = z
  .object({
    id: z.string().openapi({ description: 'Openverse audio id (pass it to import)' }),
    title: z.string(),
    creator: z.string().nullable(),
    creatorUrl: z.string().nullable(),
    durationSec: z.number().nullable(),
    license: z.enum(['cc0', 'by']),
    licenseVersion: z.string().nullable(),
    licenseLabel: z.string().openapi({ example: 'CC BY 4.0' }),
    licenseUrl: z.string().nullable(),
    attribution: z.string().nullable(),
    landingUrl: z.string().nullable().openapi({ description: 'The work on its source site' }),
    source: z.string().nullable().openapi({ example: 'jamendo' }),
    category: z.string().nullable(),
    genres: z.array(z.string()),
    previewUrl: z
      .string()
      .nullable()
      .openapi({ description: "The provider's file (https), to listen to before importing" }),
    filetype: z.string().nullable(),
    filesize: z.number().int().nullable(),
    importable: z
      .boolean()
      .openapi({ description: 'False when no file fits the library (type, 50 MB, 10 minutes)' }),
    mediaId: z.string().nullable().openapi({ description: 'The library item, when it was already imported' }),
  })
  .openapi('OpenverseTrack')

export const OpenverseSearchSchema = z
  .object({
    items: z.array(OpenverseTrackSchema),
    page: z.number().int(),
    pageCount: z.number().int(),
    total: z.number().int(),
    fetchedAt: z.string().nullable().openapi({
      description: 'When these tracks were fetched from Openverse (searches are shared and stored)',
    }),
    stale: z.boolean().openapi({
      description:
        'True when the stored search is over a day old: it is answered at once and refreshed in the background',
    }),
  })
  .openapi('OpenverseSearch')

export const OpenverseCommonSchema = z
  .object({ queries: z.array(z.string()).openapi({ example: ['upbeat', 'ambient', 'cinematic'] }) })
  .openapi('OpenverseCommon')

export const OpenverseJobSchema = z
  .object({
    id: z
      .string()
      .openapi({ description: 'Poll GET /api/v1/media/openverse/jobs/{id} until done or failed' }),
    kind: z.enum(['search', 'import']),
    status: z.enum(['queued', 'running', 'done', 'failed']),
    // A finished search has its tracks in search; a finished import, its library item in media.
    search: z.union([OpenverseSearchSchema, z.null()]),
    media: z.union([MediaSchema, z.null()]),
    created: z
      .boolean()
      .nullable()
      .openapi({ description: 'A finished import: false when the track was already in the library' }),
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    expiresAt: z.string().openapi({ description: 'The job can be read until then (30 minutes)' }),
  })
  .openapi('OpenverseJob')

export const MusicLibraryMatchesSchema = z
  .object({
    items: z
      .array(MediaSchema)
      .openapi({ description: 'Ready audio in the library matching the words, Openverse imports first' }),
  })
  .openapi('MusicLibraryMatches')

export const MediaCheckSchema = z
  .object({
    files: z
      .array(z.object({ filename: z.string().min(1).max(200), sha256: z.string().regex(/^[0-9a-f]{64}$/) }))
      .min(1)
      .max(50),
  })
  .openapi('MediaCheck')
export const MediaCheckResultSchema = z
  .object({
    files: z.array(
      z.object({
        filename: z.string(),
        sha256: z.string(),
        // An item with exactly these bytes (no need to upload it again), and a different file with the same name.
        sameFile: z.union([MediaSchema, z.null()]),
        sameName: z.union([MediaSchema, z.null()]),
      }),
    ),
  })
  .openapi('MediaCheckResult')

export const DeletedRecordingsSchema = z
  .object({ deleted: z.number().int().openapi({ description: 'How many recordings were deleted' }) })
  .openapi('DeletedRecordings')

export const MediaListSchema = z
  .object({ items: z.array(MediaSchema), nextCursor: z.string().nullable() })
  .openapi('MediaList')
export const RecordingListSchema = z.object({ items: z.array(MediaSchema) }).openapi('RecordingList')

const samples = (min: number, max: number) => z.number().int().min(min).max(max)
const Db = z.number().min(GAIN_DB_RANGE[0]).max(GAIN_DB_RANGE[1])
// Mirrors NarrationOp in src/lib/timeline.ts (plan 2026-11-02 §6.1): integer samples at 24 kHz; zod 4 numbers are
// finite. The 32-take limit (alternatives included), source bounds and output limit need the takes, so the server
// checks them (edits.ts).
const TakeMediaId = z.string().regex(/^med_[a-z0-9]{8,40}$/)
const FitSchema = z
  .object({
    a: z.number().min(-3600).max(3600),
    b: z.number().gt(0).max(1),
    residualMs: z.number().min(0),
  })
  .openapi({ description: 'Recording alignment, t = a + b·sample (identity for uploads); provenance' })
const TakeAlternativeSchema = z
  .object({
    mediaId: TakeMediaId,
    srcStart: samples(0, 2 ** 31),
    srcEnd: samples(1, 2 ** 31),
    fit: FitSchema,
    offsetSamples: samples(-MAX_OUTPUT_SAMPLES, MAX_OUTPUT_SAMPLES).openapi({
      description: 'With the fit, where this take sounds: placeTake(fit, offsetSamples, srcStart)',
    }),
  })
  .refine((t) => t.srcEnd > t.srcStart, { message: 'A take needs srcEnd after srcStart.' })
  .openapi('TakeAlternative', {
    description: "Another take of a clip's slot (an earlier punch-in over the same range); draft-only",
  })
const NarrationClipSchema = z
  .object({
    id: z.string().min(1).max(80).openapi({ description: 'Stable slot id; a split piece gets <id>~n' }),
    mediaId: TakeMediaId,
    srcStart: samples(0, 2 ** 31).openapi({ description: 'First source sample (integer, 24 kHz)' }),
    srcEnd: samples(1, 2 ** 31).openapi({ description: 'Source sample after the last; > srcStart' }),
    fit: FitSchema,
    offsetSamples: samples(-MAX_OUTPUT_SAMPLES, MAX_OUTPUT_SAMPLES),
    start: samples(0, MAX_OUTPUT_SAMPLES).openapi({
      description: 'Composition sample where srcStart sounds',
    }),
    gainDb: Db.nullable().openapi({ description: 'Clip gain in dB; null is silent' }),
    fadeInSamples: samples(0, MAX_FADE_SAMPLES),
    fadeOutSamples: samples(0, MAX_FADE_SAMPLES),
    alternatives: z.array(TakeAlternativeSchema).min(1).max(MAX_CLIP_ALTERNATIVES).optional().openapi({
      description:
        "The slot's other takes, oldest first, the clip's own left out; a render plays only the clip's own take",
    }),
    take: samples(1, MAX_CLIP_ALTERNATIVES + 1)
      .optional()
      .openapi({
        description: "With alternatives: the clip's own take number in its slot (default: the newest)",
      }),
  })
  .refine((c) => c.srcEnd > c.srcStart, { message: 'A clip needs srcEnd after srcStart.' })
  .refine((c) => c.take === undefined || c.take <= (c.alternatives?.length ?? 0) + 1, {
    message: "A clip's take number is one of its slot's takes.",
  })
  .refine(
    (c) =>
      c.fadeInSamples <= maxFade(c.srcEnd - c.srcStart) && c.fadeOutSamples <= maxFade(c.srcEnd - c.srcStart),
    { message: "A clip's fades are at most half the clip and 2 s." },
  )
export const NarrationOpSchema = z
  .object({
    op: z.literal('narration'),
    schema: z.literal(1),
    sampleRate: z.literal(SAMPLE_RATE),
    clips: z.array(NarrationClipSchema).max(MAX_NARRATION_CLIPS),
    tracks: z.object({
      narration: z.object({ volumeDb: Db, muted: z.boolean(), solo: z.boolean() }),
      aiVoice: z.object({ mode: z.enum(['replace', 'under', 'keep']), volumeDb: Db }),
      music: z.object({ duck: z.boolean(), duckDb: z.number().min(GAIN_DB_RANGE[0]).max(0) }),
      original: z.object({ muteAll: z.boolean() }),
    }),
    cleanup: z.enum(NARRATION_CLEANUP_PRESETS),
  })
  .openapi('NarrationOp', {
    description:
      'The whole recorded narration track (at most one per draft): clips of takes placed in integer samples at 24 kHz; later clips win where they overlap',
  })

const EditOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('text'), id: z.string().max(80), text: z.string().max(500) }),
  z.object({ op: z.literal('retime'), beat: z.string().max(80), duration: z.number().min(0.5).max(120) }),
  z.object({ op: z.literal('reorder'), order: z.array(z.string().max(80)).max(100) }),
  z.object({ op: z.literal('delete'), beat: z.string().max(80) }),
  z.object({ op: z.literal('color'), role: z.string().max(40), value: z.string().max(20) }),
  z.object({
    op: z.literal('media'),
    slot: z.string().max(80),
    src: z.string().max(200),
    kind: z.enum(['image', 'video']),
    fit: z.enum(['cover', 'contain']),
  }),
  z
    .object({
      op: z.literal('audio'),
      id: z.string().max(80),
      src: z
        .string()
        .max(200)
        .optional()
        .openapi({ description: 'A ready audio item from the library, as assets/media/<media id>.<ext>' }),
      volume: z.number().min(0).max(4).optional(),
      muted: z.boolean().optional(),
    })
    .openapi({ description: "Swap an audio track's file, set its level or mute it, by its id" }),
  z
    .object({
      op: z.literal('voice'),
      beat: z.string().max(80),
      text: z.string().min(1).max(MAX_NARRATION),
    })
    .openapi({
      description:
        "Change a voiced beat's narration line (plain text). The draft preview keeps the old audio; the render re-voices the line, lengthening the beat only if the new line no longer fits",
    }),
  NarrationOpSchema,
])
const CompositionSchema = z
  .object({
    duration: z.number(),
    colors: z.record(z.string(), z.string()),
    beats: z.array(
      z.object({
        id: z.string(),
        start: z.number(),
        duration: z.number(),
        authoredDuration: z.number(),
        label: z.string().nullable(),
        texts: z.array(z.object({ id: z.string(), text: z.string(), label: z.string().nullable() })),
        media: z.array(
          z.object({
            slot: z.string(),
            label: z.string().nullable(),
            kind: z.enum(['image', 'video']),
            src: z.string(),
            beat: z.string().nullable(),
            fit: z.string().nullable(),
          }),
        ),
        voice: z
          .object({ id: z.string(), src: z.string(), start: z.number(), duration: z.number() })
          .nullable()
          .openapi({
            description:
              "The beat's AI voice-over clip, in seconds into the beat; null when it has none. A changed line may lengthen its beat when re-voiced",
          }),
      }),
    ),
    layers: z.array(z.string()),
    audio: z.array(
      z.object({
        id: z.string(),
        role: z.enum(['music', 'voice', 'sfx', 'narration']),
        label: z.string().nullable(),
        src: z.string(),
        volume: z
          .number()
          .openapi({ description: 'The level set (a gain: 1 is as authored, up to 4), kept while muted' }),
        muted: z.boolean(),
        beat: z
          .string()
          .nullable()
          .openapi({ description: 'The beat it plays in; null for music and narration' }),
      }),
    ),
    narration: z
      .array(
        z.object({
          beat: z.string(),
          text: z.string(),
          revoice: z
            .boolean()
            .openapi({ description: 'The line changed since it was spoken; the render re-voices it' }),
        }),
      )
      .openapi({ description: "Each voiced beat's narration line, in beat order" }),
  })
  .openapi('Composition')

export const EditSchema = z
  .object({
    id: z.string(),
    videoId: z.string(),
    baseN: z.number().int(),
    rev: z.number().int(),
    ops: z.array(EditOpSchema),
    composition: CompositionSchema,
    base: CompositionSchema,
    palette: z.array(z.string()),
    expiresAt: z.string(),
    renderedN: z.number().int().nullable(),
    newerVersion: z.number().int().nullable().openapi({
      description: 'A newer version exists: start from it, or render this draft as the next version',
    }),
    narrationChanged: z
      .object({
        inVersion: z.number().int(),
        by: z.object({ userId: z.string(), name: z.string() }),
        at: z.string(),
        yoursReplaces: z.boolean().openapi({
          description:
            "The draft has its own narration: rendering it replaces that version's (warn before rendering)",
        }),
      })
      .nullable()
      .openapi({
        description:
          "The newest ready version's narration differs from this draft's base: rebase onto it (rebase-narration), or keep yours",
      }),
  })
  .openapi('Edit')
export const RebaseNarrationSchema = z
  .object({
    toN: z.number().int().min(1).openapi({ description: 'The version to move your narration onto' }),
  })
  .openapi('RebaseNarration')
export const SaveEditSchema = z
  .object({ ops: z.array(EditOpSchema).max(500), rev: z.number().int().min(0) })
  .openapi('SaveEdit')
export const RenderEditSchema = z
  .object({
    mode: z.enum(['keep_visuals', 'fit_to_narration']).optional().openapi({
      description:
        'keep_visuals (default): render the draft as is, recorded narration mixed over it. fit_to_narration: an authoring run (about 250 credits) retimes the visuals from the draft to the narration, which it cannot change; it always replaces the AI voice-over, and needs recorded narration in the draft (no holdFinalFrame or excludeNarration)',
    }),
    holdFinalFrame: z.boolean().optional().openapi({
      description:
        'Narration that runs past the end holds the last frame, plus 0.5 s, instead of being cut off',
    }),
    captions: z
      .enum(['sidecar', 'burned'])
      .optional()
      .openapi({ description: 'How narration captions are delivered: a VTT sidecar (default) or burned in' }),
    excludeNarration: z.boolean().optional().openapi({
      description:
        "Render picture first: render the draft's other edits without its recorded narration, so you can record against the new picture. The narration stays in the draft; move it onto the new version with rebase-narration",
    }),
  })
  .openapi('RenderEdit')

// The narration soft lock (plan 2026-11-02 §2.7).
const LockHolderSchema = z
  .object({
    userId: z.string(),
    name: z.string(),
    since: z.string().openapi({ description: 'When they took the lock' }),
  })
  .openapi('NarrationLockHolder')
export const NarrationLockSchema = z
  .object({
    videoId: z.string(),
    holder: LockHolderSchema.nullable().openapi({
      description: 'Who is editing the narration; null when no one is',
    }),
    mine: z.boolean().openapi({ description: 'You hold the lock' }),
    draftId: z.string().nullable().openapi({ description: "The holder's draft (shown to the holder only)" }),
    heartbeatAt: z.string().nullable(),
    expiresAt: z
      .string()
      .nullable()
      .openapi({ description: 'The lock is free from then on unless the holder heartbeats (every 30 s)' }),
  })
  .openapi('NarrationLock')
export const AcquireNarrationLockSchema = z
  .object({
    draftId: z.string().max(64).openapi({ description: 'Your draft of this video' }),
    heartbeat: z.boolean().optional().openapi({
      description:
        'You believe you hold the lock (a heartbeat): if someone took it over, the 409 says who (details.takenOverBy, details.at)',
    }),
  })
  .openapi('AcquireNarrationLock')
export const NarrationTakeOverSchema = z
  .object({
    lock: NarrationLockSchema,
    previous: LockHolderSchema.nullable().openapi({
      description: 'Who held it before you; null when no one did',
    }),
  })
  .openapi('NarrationTakeOver')

export const PreviewLinkSchema = z
  .object({
    url: z
      .string()
      .openapi({ description: 'Load in <iframe sandbox="allow-scripts">; append #ch=<channel id>' }),
    expiresAt: z.string(),
    seq: z
      .number()
      .int()
      .nullable()
      .openapi({ description: 'For live=1: the checkpoint this snapshot is from' }),
  })
  .openapi('PreviewLink')

export const ProgressSchema = z
  .object({
    attemptId: z.string().nullable(),
    versionN: z.number().int().nullable(),
    stage: StageSchema.nullable(),
    step: z.string().nullable().openapi({ description: "The agent's latest step, in its own words" }),
    music: MusicPickSchema.nullable().openapi({
      description: 'The music the server is picking (or picked) before the run; null when none was needed.',
    }),
    steps: z
      .number()
      .int()
      .nullable()
      .openapi({ description: 'Agent steps so far (a count, not a percentage)' }),
    credits: z.number().nullable().openapi({ description: 'Credits used so far' }),
    observedAt: z
      .string()
      .nullable()
      .openapi({ description: 'When the run was last read (null: from stored rows)' }),
    stale: z
      .boolean()
      .openapi({ description: "True when the run couldn't be read and this is the last known value" }),
    checkpoint: z
      .object({
        seq: z.number().int(),
        message: z.string().nullable(),
        renderPercent: z.number().int().nullable(),
        at: z.string(),
        hasBundle: z.boolean(),
      })
      .nullable()
      .openapi({ description: 'The latest milestone the run reported itself' }),
  })
  .openapi('Progress')

export const NotificationSchema = z
  .object({
    id: z.string(),
    type: z.enum(['comment.created', 'version.approved', 'version.changes_requested']),
    video: z.object({ id: z.string(), title: z.string() }),
    versionN: z.number().int().nullable(),
    actor: z.object({ id: z.string(), name: z.string().nullable(), email: z.string().nullable() }),
    summary: z.string(),
    createdAt: z.string(),
    unread: z.boolean(),
  })
  .openapi('Notification')
export const NotificationListSchema = z
  .object({
    items: z.array(NotificationSchema),
    unreadCount: z.number().int(),
    nextCursor: z.string().nullable(),
  })
  .openapi('NotificationList')

const PersonRef = z.object({ id: z.string(), name: z.string().nullable(), email: z.string().nullable() })
export const CommentSchema = z
  .object({
    id: z.string(),
    videoId: z.string(),
    versionN: z.number().int(),
    author: PersonRef,
    body: z.string(),
    timeSec: z.number().nullable(),
    x: z
      .number()
      .nullable()
      .openapi({ description: '0–1 across the displayed video, letterboxing excluded' }),
    y: z.number().nullable().openapi({ description: '0–1 down the displayed video, letterboxing excluded' }),
    createdAt: z.string(),
    editedAt: z.string().nullable(),
    resolvedAt: z.string().nullable(),
    resolvedBy: PersonRef.nullable(),
    addressedInN: z.number().int().nullable(),
    can: z.object({ edit: z.boolean(), delete: z.boolean(), resolve: z.boolean() }),
  })
  .openapi('Comment')
export const CommentListSchema = z
  .object({
    items: z.array(CommentSchema),
    unreadCount: z
      .number()
      .int()
      .openapi({ description: "Others' comments on this video since you last read" }),
    readAt: z.string().nullable(),
    nextCursor: z.string().nullable(),
  })
  .openapi('CommentList')
export const CreateCommentSchema = z
  .object({
    versionN: z.number().int().positive(),
    body: z.string().min(1).max(2000),
    timeSec: z.number().min(0).nullable().optional(),
    x: z.number().min(0).max(1).nullable().optional(),
    y: z.number().min(0).max(1).nullable().optional(),
  })
  .openapi('CreateComment')
export const PatchCommentSchema = z
  .object({ body: z.string().min(1).max(2000).optional(), resolved: z.boolean().optional() })
  .openapi('PatchComment')

export const PutWebhookSchema = z
  .object({ url: z.url().max(2000), rotate: z.boolean().optional() })
  .openapi('PutWebhook')
export const WebhookSettingSchema = z
  .object({
    url: z.string(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    secret: z.string().nullable().optional().describe('Shown only when the webhook is created or rotated.'),
  })
  .openapi('WebhookSetting')
export const WebhookTestSchema = z.object({ ok: z.boolean(), result: z.string() }).openapi('WebhookTest')

export const TransferSchema = z
  .object({
    toUserId: z.string().min(1),
    videoIds: z.array(z.string()).max(500).optional(),
    fromUserId: z.string().optional(),
  })
  .refine((v) => (v.videoIds?.length ?? 0) > 0 || v.fromUserId !== undefined, {
    message: 'Send videoIds or fromUserId.',
  })
  .openapi('Transfer')
export const TransferResultSchema = z
  .object({ transferred: z.number().int(), videoIds: z.array(z.string()) })
  .openapi('TransferResult')

export const UpdateUserSchema = z
  .object({ role: RoleSchema.optional(), disabled: z.boolean().optional() })
  .openapi('UpdateUser')

export const TranscriptionProviderSchema = z
  .enum(['local', 'elevenlabs', 'off'])
  .openapi('TranscriptionProvider', {
    description:
      'How recorded narration is transcribed for captions: local (the default, audio stays in this deployment), elevenlabs (sends the audio to ElevenLabs) or off (no captions from recordings).',
  })
export const AdminSettingsSchema = z
  .object({
    narrationEnabled: z
      .boolean()
      .describe(
        'Recorded voice-over is on (the default). Off hides recording and refuses narration changes; versions that already have narration keep playing.',
      ),
    transcriptionProvider: TranscriptionProviderSchema,
    takeQuotaBytes: z
      .number()
      .int()
      .describe("Stored bytes each person's recordings may use (default 2 GiB)."),
    remixEnabled: z
      .boolean()
      .describe(
        'Remixing is on (the default). Off hides every Remix button and refuses new remixes; queued ones still run.',
      ),
  })
  .openapi('AdminSettings')
export const UpdateAdminSettingsSchema = z
  .object({
    narrationEnabled: z.boolean().optional(),
    transcriptionProvider: TranscriptionProviderSchema.optional(),
    takeQuotaBytes: z
      .number()
      .int()
      .min(1024 * 1024)
      .max(1024 ** 4)
      .optional()
      .describe('1 MiB to 1 TiB.'),
    remixEnabled: z.boolean().optional(),
  })
  .openapi('UpdateAdminSettings')

export const MeSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    role: RoleSchema,
    via: z.enum(['session', 'apiKey']),
  })
  .openapi('Me')

const inFlightShape = z.object({
  attemptId: z.string(),
  jobId: z.string(),
  title: z.string(),
  versionN: z.number().int(),
  stage: StageSchema,
  startedAt: z.string().nullable(),
  runUrl: z.string().nullable(),
})
export const StatsSchema = z
  .object({
    inFlight: z.array(inFlightShape),
    queued: z.number().int(),
    oldestQueuedAt: z.string().nullable(),
    unresolved: z.array(inFlightShape.omit({ stage: true, startedAt: true })),
    failuresThisWeek: z.array(z.object({ category: z.string(), count: z.number().int() })),
    usage: z.array(
      z.object({
        userId: z.string(),
        email: z.string().nullable(),
        week: z.string(),
        credits: z.number().nullable(),
        videos: z.number().int(),
        planningCredits: z.number().describe('Estimated AI Gateway credits for planning (Plan it first).'),
        planningUnknown: z
          .number()
          .int()
          .describe('Planning calls whose cost is unknown (errors, timeouts).'),
      }),
    ),
    maxActiveRuns: z.number().int(),
    queuePausedReason: z.string().nullable(),
  })
  .openapi('Stats')

export const CheckSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    status: z.enum(['ok', 'fail', 'warn', 'unknown']),
    detail: z.string(),
    fix: z.string().optional(),
  })
  .openapi('SetupCheck')
export const HealthSchema = z
  .object({ ok: z.boolean(), ready: z.boolean(), checks: z.array(CheckSchema).optional() })
  .openapi('Health')

export const PublicConfigSchema = z
  .object({
    admission: z.union([z.literal('invite-only'), z.array(z.string()), z.null()]),
    siteUrl: z.string(),
    planningAvailable: z.boolean().describe('AI Gateway is available, so Plan it first is offered.'),
    mcpOAuth: z
      .boolean()
      .describe('MCP clients can connect with OAuth (Sign in with Netlify) as well as API keys.'),
    authProvider: z
      .enum(['identity', 'netlify'])
      .describe('How people sign in to the web app: Netlify Identity, or Sign in with Netlify.'),
    requiredTeams: z
      .array(z.string())
      .describe(
        'Netlify teams (slugs or ids) a Netlify sign-in must belong to; empty when there is no team rule.',
      ),
    narrationEnabled: z
      .boolean()
      .describe('Recorded voice-over is on, so the Narration track and Record are offered.'),
    remixEnabled: z
      .boolean()
      .describe('Remixing is on, so Remix is offered to people who can create videos.'),
    missingSettings: z
      .array(z.enum(['RUNNER_API_TOKEN', 'ALLOWED_EMAIL_DOMAINS', 'ADMIN_EMAILS']))
      .describe(
        "Required settings this deployment doesn't have yet (names only), so the sign-in screen and the app can say what to add. Empty once it's set up.",
      ),
  })
  .openapi('PublicConfig')
