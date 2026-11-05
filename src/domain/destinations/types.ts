// Publish destinations (docs/plans/2026-11-04-publish-destinations.md §2.2): the interface every kind implements.
// A kind does one bounded step of an operation at a time; the worker (run.ts) commits each step under a fenced
// lease, so a stale worker or a late callback can never undo a newer decision.
import type { Deps } from '../../deps.js'
import type { Principal } from '../policy.js'
import type { Repo } from '../../store/types.js'
import type {
  DestinationConnectionRow,
  DestinationKindName,
  DestinationPublicationRow,
  DestinationRow,
  SafeError,
  Target,
} from '../types.js'
import type { OptionsSchema } from '../../lib/options-schema.js'
import type { Manifest, PublishManifest } from './manifest.js'

export type { SafeError, Target }

/** A destination as the app sees it: built-in kinds have fixed ids and no row. */
export interface Destination {
  id: string
  kind: DestinationKindName
  name: string
  /** HTTP destinations only. */
  row: DestinationRow | null
}

export type StepResult =
  | { status: 'continue'; state: object }
  | { status: 'waiting'; state?: object; checkAfterSec: number | null; message?: string; externalId?: string }
  | { status: 'retry'; state?: object; error: SafeError; retryAfterSec?: number; retryAt?: string }
  | { status: 'live'; url: string | null; externalId: string | null; warnings?: string[]; message?: string }
  | { status: 'removed' }
  | { status: 'failed'; error: SafeError }

export interface ReadyCtx {
  deps: Deps
  repo: Repo
  destination: Destination
  principal: Principal
}

export interface StepCtx {
  deps: Deps
  destination: Destination
  publication: DestinationPublicationRow
  operation: { action: 'publish' | 'remove'; generation: number; fence: number; id: string }
  state: Record<string, unknown>
  manifest: Manifest
  connection: DestinationConnectionRow | null
  /** Fresh signed links for the manifest's files, after re-checking the video still exists and may still go out. */
  files(): Promise<Record<string, string>>
  /** Streams one of the manifest's files from the videos store (null when it's gone). */
  stream(kind: string, range?: { start: number; end: number }): Promise<ReadableStream<Uint8Array> | null>
}

export interface DestinationKind {
  kind: DestinationKindName
  optionsSchema(d: Destination): OptionsSchema | null
  unpublishOptionsSchema(d: Destination): OptionsSchema | null
  /** Can this person publish here now? The reason is shown as-is ("Connect YouTube first"). */
  ready(ctx: ReadyCtx): Promise<{ ok: true } | { ok: false; reason: string }>
  /** Refuses options that can't work with this version before anything starts (null: fine). */
  checkOptions?(options: Record<string, unknown>, manifest: PublishManifest): string | null
  /** One bounded step of the current operation (one HTTP call, one upload chunk). */
  step(ctx: StepCtx): Promise<StepResult>
}

/** Plain text, at most `max` characters (messages, warnings, error text). */
export function safeText(v: unknown, max = 300): string | null {
  if (typeof v !== 'string') return null
  // eslint-disable-next-line no-control-regex -- strip control characters from text a receiver sent
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return t ? t.slice(0, max) : null
}

export function safeWarnings(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v.map((w) => safeText(w)).filter((w): w is string => w !== null)
  return out.length ? out.slice(0, 5) : undefined
}

export const safeError = (code: string, message: string): SafeError => ({
  code: code.slice(0, 60),
  message: safeText(message) ?? code,
})
