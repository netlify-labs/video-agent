// netlify-video-agent-sdk: a typed client for a Video Agent deployment's REST API
// (docs/plans/2026-11-04-cli-and-sdk.md §4).
import type { components } from './generated/schema.js'
export { VideoAgent, type ServerConfig, type VideoAgentOptions } from './client.js'
export { VideoAgentError, isVideoAgentError } from './errors.js'
export type { Logger } from './http.js'
export type { CallOptions, Input, Ok } from './transport.js'
export { PAGEABLE, type Resources } from './generated/resources.js'
export type { paths, components, operations } from './generated/schema.js'
export { VERSION } from './version.js'

/** This package's name, as published. */
export const PACKAGE_NAME = 'netlify-video-agent-sdk'
export {
  parseWebhook,
  verifyWebhook,
  type VerifyWebhookOptions,
  type WebhookEvent,
  type WebhookEventType,
} from './webhooks.js'
export type { VideoHelpers } from './client.js'
export type { Pageable, ResolvedVideo, WaitOptions, WaitProgress } from './helpers/videos.js'
export type { FileHelpers } from './client.js'
export type { FileOptions, VersionFile } from './helpers/files.js'
export type { ConfigHelpers, MediaHelpers, MusicHelpers } from './client.js'
export { SINGLE_UPLOAD_MAX, type UploadOptions, type UploadProgress } from './helpers/media.js'

/** A video, as GET /api/v1/videos/{id} returns it. */
export type Video = components['schemas']['Video']
/** One version of a video. */
export type Version = components['schemas']['Version']
/** A media library item. */
export type Media = components['schemas']['Media']
/** A plan (Plan it first). */
export type Plan = components['schemas']['Plan']
/** A comment on a video. */
export type Comment = components['schemas']['Comment']
/** A publication of a version (share link, MP4 link, embed snippet). */
export type Publication = components['schemas']['Publication']
