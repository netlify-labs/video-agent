// Request and response schemas: one definition drives validation, types, the OpenAPI spec and the
// web app's generated client.
import { z } from '@hono/zod-openapi'

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
export const StatusSchema = z
  .enum(['queued', 'running', 'finishing', 'ready', 'failed', 'cancelled', 'timed_out'])
  .openapi('VideoStatus')
export const StageSchema = z
  .enum([
    'queued',
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
      })
      .nullable(),
    embed: z.string().nullable(),
  })
  .openapi('Publication')

export const VerdictSchema = z.enum(['approved', 'changes_requested']).openapi('Verdict')
export const SetVerdictSchema = z
  .object({ verdict: VerdictSchema.nullable(), note: z.string().max(500).optional() })
  .openapi('SetVerdict')

export const VersionSchema = z
  .object({
    verdicts: z.object({
      approved: z.number().int(),
      changesRequested: z.number().int(),
      mine: VerdictSchema.nullable(),
    }),
    n: z.number().int(),
    status: StatusSchema,
    prompt: z.string(),
    authorId: z.string(),
    parentN: z.number().int().nullable(),
    targetDurationSec: z.number().int().nullable(),
    createdAt: z.string(),
    attempts: z.number().int(),
    stage: StageSchema.nullable(),
    latestStep: z.string().nullable(),
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
      })
      .nullable(),
    links: z.object({
      video: z.string(),
      poster: z.string(),
      gif: z.string(),
      captions: z.string(),
      netlifyRun: z.string().nullable(),
    }),
    publications: z.array(PublicationSchema),
  })
  .openapi('Version')

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
  })
  .openapi('CreateVideo')

export const ReviseSchema = z
  .object({
    prompt: z.string().min(3).max(4000),
    fromVersion: z.number().int().positive().optional(),
    durationSec: z.number().int().positive().optional(),
    webhookUrl: z.url().optional(),
    planId: z.string().optional(),
  })
  .openapi('Revise')

export const UpdateVideoSchema = z
  .object({ title: z.string().min(1).max(120).optional(), private: z.boolean().optional() })
  .refine((v) => v.title !== undefined || v.private !== undefined, { message: 'Send title or private.' })
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
  })
  .openapi('User')
const PlanQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  why: z.string(),
  options: z.array(z.object({ id: z.string(), label: z.string(), description: z.string() })),
  multiSelect: z.boolean(),
  allowOther: z.boolean(),
})
const PlanAnswerSchema = z.object({
  questionId: z.string(),
  optionIds: z.array(z.string()).max(4).optional(),
  other: z.string().max(500).optional(),
  skipped: z.boolean().optional(),
})
export const PlanBriefSchema = z
  .object({
    goal: z.string().max(400),
    audience: z.string().max(300),
    keyMessage: z.string().max(300),
    beats: z.array(z.object({ text: z.string().max(300), seconds: z.number().min(0).max(600) })).max(12),
    tone: z.string().max(200),
    callToAction: z.string().max(200),
    mustInclude: z.array(z.string().max(200)).max(10),
    avoid: z.array(z.string().max(200)).max(10),
  })
  .openapi('PlanBrief')
export const PlanSchema = z
  .object({
    id: z.string(),
    prompt: z.string(),
    revisionOf: z.object({ videoId: z.string(), version: z.number().int().nullable() }).nullable(),
    route: z
      .object({
        needsQuestions: z.boolean(),
        template: z.string(),
        suggestedAspect: z.enum(['16:9', '9:16', '1:1', '4:5']).nullable(),
      })
      .nullable(),
    questions: z.array(PlanQuestionSchema).nullable(),
    answers: z.array(PlanAnswerSchema).nullable(),
    brief: PlanBriefSchema.nullable(),
    briefRev: z.number().int(),
    expiresAt: z.string(),
  })
  .openapi('Plan')
export const CreatePlanSchema = z
  .object({
    prompt: z.string().min(1).max(4000),
    aspect: z.enum(['16:9', '9:16', '1:1', '4:5']).optional(),
    durationSec: z.number().int().min(3).max(600).optional(),
    revisionOf: z.object({ videoId: z.string(), version: z.number().int().optional() }).optional(),
  })
  .openapi('CreatePlan')
export const PlanAnswersSchema = z
  .object({ answers: z.array(PlanAnswerSchema).max(6) })
  .openapi('PlanAnswers')
export const PatchPlanSchema = z.object({ brief: PlanBriefSchema }).openapi('PatchPlan')

export const MyUsageSchema = z
  .object({
    since: z.string(),
    runs: z.object({ credits: z.number(), videos: z.number().int(), unknown: z.boolean() }),
    planning: z.object({ credits: z.number(), calls: z.number().int(), unknown: z.number().int() }),
  })
  .openapi('MyUsage')

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

export const MeSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    role: RoleSchema,
    via: z.enum(['session', 'apiKey']),
  })
  .openapi('Me')

export const StatsSchema = z
  .object({
    inFlight: z.array(
      z.object({
        attemptId: z.string(),
        jobId: z.string(),
        title: z.string(),
        versionN: z.number().int(),
        stage: StageSchema,
        startedAt: z.string().nullable(),
        runUrl: z.string().nullable(),
      }),
    ),
    queued: z.number().int(),
    oldestQueuedAt: z.string().nullable(),
    unresolved: z.array(
      z.object({
        attemptId: z.string(),
        jobId: z.string(),
        title: z.string(),
        versionN: z.number().int(),
        runUrl: z.string().nullable(),
      }),
    ),
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
  })
  .openapi('PublicConfig')
