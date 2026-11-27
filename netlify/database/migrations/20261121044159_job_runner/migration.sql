CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"secret_hash" text NOT NULL,
	"webhook_secret_enc" text NOT NULL,
	"created_at" text NOT NULL,
	"last_used_at" text,
	"revoked_at" text
);
--> statement-breakpoint
CREATE TABLE "attempts" (
	"id" text PRIMARY KEY,
	"job_id" text NOT NULL,
	"version_n" integer NOT NULL,
	"stage" text NOT NULL,
	"next_action_at" text,
	"lease_until" text,
	"deploy_id" text,
	"agent" text NOT NULL,
	"model" text,
	"effort" text,
	"prompt_template_version" integer NOT NULL,
	"tool_versions" jsonb,
	"parent_source_sha256" text,
	"handle_enc" text,
	"start_request_enc" text,
	"runner_id" text,
	"session_id" text,
	"callback_token_hash" text NOT NULL,
	"send_window" jsonb,
	"cancel_requested_at" text,
	"cancel_reason" text,
	"latest_step" text,
	"result_text" text,
	"usage" jsonb,
	"engine_renders" jsonb,
	"error_category" text,
	"error_message" text,
	"queued_at" text NOT NULL,
	"started_at" text,
	"finishing_at" text,
	"ended_at" text,
	"authoring_deadline_at" text,
	"music_pick" jsonb
);
--> statement-breakpoint
CREATE TABLE "callback_receipts" (
	"attempt_id" text PRIMARY KEY,
	"manifest" jsonb NOT NULL,
	"manifest_hash" text NOT NULL,
	"received_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checkpoints" (
	"attempt_id" text PRIMARY KEY,
	"job_id" text NOT NULL,
	"seq" integer NOT NULL,
	"message" text,
	"render_percent" integer,
	"bundle_key" text,
	"created_at" text NOT NULL,
	"window_start" text NOT NULL,
	"window_count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cleanup" (
	"id" text PRIMARY KEY,
	"kind" text NOT NULL,
	"store" text NOT NULL,
	"prefix" text NOT NULL,
	"next_action_at" text NOT NULL,
	"done_at" text
);
--> statement-breakpoint
CREATE TABLE "cli_login_failures" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cli_logins" (
	"id" text PRIMARY KEY,
	"device_code_hash" text NOT NULL,
	"user_code" text NOT NULL,
	"label" text NOT NULL,
	"host" text NOT NULL,
	"client_ip" text NOT NULL,
	"status" text NOT NULL,
	"user_id" text,
	"approved_at" text,
	"api_key_id" text,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"last_polled_at" text,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comment_reads" (
	"user_id" text,
	"job_id" text,
	"read_at" text NOT NULL,
	CONSTRAINT "comment_reads_pkey" PRIMARY KEY("user_id","job_id")
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" text PRIMARY KEY,
	"job_id" text NOT NULL,
	"version_n" integer NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"time_sec" double precision,
	"x" double precision,
	"y" double precision,
	"created_at" text NOT NULL,
	"edited_at" text,
	"resolved_at" text,
	"resolved_by" text,
	"addressed_in_n" integer,
	"deleted_at" text,
	"group_id" text,
	"media_ids" jsonb
);
--> statement-breakpoint
CREATE TABLE "destination_connections" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"account_id" text NOT NULL,
	"account_label" text NOT NULL,
	"token_enc" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"revoked_at" text
);
--> statement-breakpoint
CREATE TABLE "destination_publications" (
	"id" text PRIMARY KEY,
	"job_id" text NOT NULL,
	"version_n" integer NOT NULL,
	"kind" text NOT NULL,
	"destination_id" text,
	"destination_revision" integer,
	"connection_id" text,
	"target_key" text NOT NULL,
	"target" jsonb,
	"options" jsonb NOT NULL,
	"instructions" text,
	"desired" text NOT NULL,
	"status" text NOT NULL,
	"generation" integer NOT NULL,
	"operation" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"state_enc" text,
	"external_id" text,
	"url" text,
	"message" text,
	"warnings" jsonb,
	"error" jsonb,
	"attempts" integer NOT NULL,
	"next_run_at" text,
	"deadline_at" text NOT NULL,
	"lease_until" text,
	"lease_fence" integer NOT NULL,
	"secret_once_enc" text,
	"secret_once_label" text,
	"secret_once_issued_at" text,
	"secret_once_expires_at" text,
	"secret_once_consumed_at" text,
	"published_by" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"live_at" text,
	"removed_at" text
);
--> statement-breakpoint
CREATE TABLE "destinations" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"enabled" boolean NOT NULL,
	"url" text NOT NULL,
	"secret_enc" text NOT NULL,
	"options_schema" jsonb,
	"capabilities" jsonb NOT NULL,
	"share_publisher_contact" boolean DEFAULT false NOT NULL,
	"revision" integer NOT NULL,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edits" (
	"id" text PRIMARY KEY,
	"job_id" text NOT NULL,
	"base_n" integer NOT NULL,
	"author_id" text NOT NULL,
	"rev" integer NOT NULL,
	"ops" jsonb NOT NULL,
	"bundle_sha256" text,
	"rendered_n" integer,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "favorites" (
	"user_id" text,
	"job_id" text,
	"created_at" text NOT NULL,
	CONSTRAINT "favorites_pkey" PRIMARY KEY("user_id","job_id")
);
--> statement-breakpoint
CREATE TABLE "gateway_calls" (
	"id" text PRIMARY KEY,
	"caller_id" text NOT NULL,
	"plan_id" text,
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_tokens" integer NOT NULL,
	"credits" double precision,
	"estimate" boolean NOT NULL,
	"ok" boolean NOT NULL,
	"error" text,
	"ms" integer NOT NULL,
	"at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"principal_id" text,
	"operation" text,
	"key" text,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"expires_at" text NOT NULL,
	CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY("principal_id","operation","key")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY,
	"title" text NOT NULL,
	"aspect" text NOT NULL,
	"owner_id" text NOT NULL,
	"status" text NOT NULL,
	"latest_version" integer NOT NULL,
	"next_version_n" integer NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text,
	"version" integer NOT NULL,
	"private" boolean DEFAULT false NOT NULL,
	"access_epoch" integer DEFAULT 0 NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"remix_of_job_id" text,
	"remix_of_n" integer,
	"runner" jsonb,
	"external_ref" text,
	"external_url" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" text PRIMARY KEY,
	"uploader_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"reject_reason" text,
	"filename" text NOT NULL,
	"title" text,
	"caption" text,
	"mime" text NOT NULL,
	"ext" text NOT NULL,
	"bytes" bigint NOT NULL,
	"original_key" text NOT NULL,
	"original_sha256" text NOT NULL,
	"clean_key" text NOT NULL,
	"clean_sha256" text NOT NULL,
	"width" integer,
	"height" integer,
	"duration_sec" double precision,
	"poster_key" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text,
	"source" text,
	"source_id" text,
	"source_url" text,
	"source_title" text,
	"license" text,
	"license_version" text,
	"license_url" text,
	"creator" text,
	"creator_url" text,
	"attribution" text,
	"role" text,
	"scope_job_id" text,
	"retain_until" text,
	"deleting_at" text,
	"trace_key" text,
	"trace_sha256" text,
	"trace_writes" jsonb
);
--> statement-breakpoint
CREATE TABLE "media_refs" (
	"media_id" text,
	"owner_kind" text,
	"owner_id" text,
	"job_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "media_refs_pkey" PRIMARY KEY("media_id","owner_kind","owner_id")
);
--> statement-breakpoint
CREATE TABLE "media_upload_parts" (
	"upload_id" text,
	"idx" integer,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	CONSTRAINT "media_upload_parts_pkey" PRIMARY KEY("upload_id","idx")
);
--> statement-breakpoint
CREATE TABLE "media_uploads" (
	"id" text PRIMARY KEY,
	"uploader_id" text NOT NULL,
	"filename" text NOT NULL,
	"caption" text,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"part_size" integer NOT NULL,
	"part_count" integer NOT NULL,
	"status" text NOT NULL,
	"media_id" text,
	"error" text,
	"lease_until" text,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"role" text,
	"scope_job_id" text
);
--> statement-breakpoint
CREATE TABLE "narration_locks" (
	"job_id" text PRIMARY KEY,
	"holder_id" text NOT NULL,
	"draft_id" text NOT NULL,
	"acquired_at" text NOT NULL,
	"heartbeat_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_reads" (
	"user_id" text PRIMARY KEY,
	"read_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"job_id" text NOT NULL,
	"version_n" integer,
	"type" text NOT NULL,
	"actor_id" text NOT NULL,
	"summary" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" text PRIMARY KEY,
	"name" text,
	"redirect_uris" jsonb NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_grants" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"client_name" text,
	"resource" text NOT NULL,
	"created_at" text NOT NULL,
	"last_used_at" text,
	"expires_at" text NOT NULL,
	"revoked_at" text,
	"upstream_token_enc" text,
	"membership_checked_at" text,
	"membership_failed_at" text
);
--> statement-breakpoint
CREATE TABLE "oauth_requests" (
	"id" text PRIMARY KEY,
	"client_id" text NOT NULL,
	"client_name" text,
	"redirect_uri" text NOT NULL,
	"resource" text NOT NULL,
	"state" text NOT NULL,
	"code_challenge" text NOT NULL,
	"user_id" text,
	"consent_hash" text,
	"code_hash" text,
	"grant_id" text,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"used_at" text,
	"upstream_token_enc" text,
	"membership_checked_at" text
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"hash" text PRIMARY KEY,
	"kind" text NOT NULL,
	"grant_id" text NOT NULL,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"used_at" text
);
--> statement-breakpoint
CREATE TABLE "openverse_jobs" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"params" jsonb NOT NULL,
	"status" text NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openverse_search_uses" (
	"key" text,
	"day" text,
	"count" integer NOT NULL,
	CONSTRAINT "openverse_search_uses_pkey" PRIMARY KEY("key","day")
);
--> statement-breakpoint
CREATE TABLE "openverse_searches" (
	"key" text PRIMARY KEY,
	"result" jsonb NOT NULL,
	"fetched_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outputs" (
	"job_id" text,
	"version_n" integer,
	"video_key" text NOT NULL,
	"poster_key" text NOT NULL,
	"gif_key" text NOT NULL,
	"captions_key" text NOT NULL,
	"source_key" text NOT NULL,
	"sha256" jsonb NOT NULL,
	"bytes" bigint NOT NULL,
	"duration_sec" double precision NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"title" text NOT NULL,
	"agent_summary" text NOT NULL,
	"previews" jsonb,
	"run_credits" jsonb,
	"notices" jsonb,
	CONSTRAINT "outputs_pkey" PRIMARY KEY("job_id","version_n")
);
--> statement-breakpoint
CREATE TABLE "ownership_transfers" (
	"id" text PRIMARY KEY,
	"job_id" text NOT NULL,
	"from_user_id" text NOT NULL,
	"to_user_id" text NOT NULL,
	"by_user_id" text NOT NULL,
	"at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"job_id" text,
	"base_n" integer,
	"prompt" text NOT NULL,
	"aspect" text,
	"duration_sec" integer,
	"media_ids" jsonb DEFAULT '[]' NOT NULL,
	"sound" text,
	"voiceover" jsonb,
	"inputs_hash" text NOT NULL,
	"route" jsonb,
	"questions" jsonb,
	"answers" jsonb,
	"brief" jsonb,
	"brief_rev" integer NOT NULL,
	"consumed_by_job_id" text,
	"consumed_by_n" integer,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"remix_from_job_id" text,
	"remix_from_n" integer,
	"look" jsonb,
	"engine" text,
	"work" jsonb
);
--> statement-breakpoint
CREATE TABLE "publications" (
	"slug" text PRIMARY KEY,
	"job_id" text NOT NULL,
	"version_n" integer NOT NULL,
	"published_by" text NOT NULL,
	"published_at" text NOT NULL,
	"unpublished_at" text,
	"show_transcript" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queue_control" (
	"id" integer PRIMARY KEY
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"created_at" text NOT NULL,
	"last_seen_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"rotated_at" text NOT NULL,
	"upstream_token_enc" text,
	"membership_checked_at" text,
	"membership_failed_at" text,
	"revoked_at" text
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY,
	"file_signing_secret" text NOT NULL,
	"data_encryption_key" text NOT NULL,
	"queue_paused_reason" text,
	"created_at" text NOT NULL,
	"team_webhook_url" text,
	"team_webhook_secret_enc" text,
	"plan_deep_model" text,
	"narration_enabled" boolean DEFAULT true NOT NULL,
	"transcription_provider" text DEFAULT 'local' NOT NULL,
	"take_quota_bytes" bigint DEFAULT 2147483648 NOT NULL,
	"recording_quota_bytes" bigint DEFAULT 2147483648 NOT NULL,
	"remix_enabled" boolean DEFAULT true NOT NULL,
	"webmcp_enabled" boolean DEFAULT true NOT NULL,
	"remotion_enabled" boolean DEFAULT false NOT NULL,
	"remotion_license_ack" jsonb,
	"youtube_enabled" boolean DEFAULT false NOT NULL,
	"default_look" text,
	"disabled_looks" jsonb DEFAULT '[]' NOT NULL,
	"cli_login_enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"provider" text,
	"subject" text,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"created_at" text NOT NULL,
	"last_seen_at" text NOT NULL,
	CONSTRAINT "user_identities_pkey" PRIMARY KEY("provider","subject")
);
--> statement-breakpoint
CREATE TABLE "user_webhooks" (
	"user_id" text PRIMARY KEY,
	"url" text NOT NULL,
	"secret_enc" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY,
	"email" text NOT NULL,
	"name" text,
	"role" text NOT NULL,
	"admitted_via" text NOT NULL,
	"created_at" text NOT NULL,
	"last_seen_at" text NOT NULL,
	"disabled_at" text
);
--> statement-breakpoint
CREATE TABLE "verdicts" (
	"job_id" text,
	"version_n" integer,
	"user_id" text,
	"verdict" text NOT NULL,
	"note" text,
	"updated_at" text NOT NULL,
	CONSTRAINT "verdicts_pkey" PRIMARY KEY("job_id","version_n","user_id")
);
--> statement-breakpoint
CREATE TABLE "version_comments" (
	"job_id" text,
	"version_n" integer,
	"comment_id" text,
	"position" integer NOT NULL,
	"author_id" text NOT NULL,
	"author_name" text,
	"body" text NOT NULL,
	"time_sec" double precision,
	"x" double precision,
	"y" double precision,
	"files" jsonb,
	CONSTRAINT "version_comments_pkey" PRIMARY KEY("job_id","version_n","comment_id")
);
--> statement-breakpoint
CREATE TABLE "version_media" (
	"job_id" text,
	"version_n" integer,
	"media_id" text,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"sha256" text NOT NULL,
	"filename" text NOT NULL,
	"caption" text,
	CONSTRAINT "version_media_pkey" PRIMARY KEY("job_id","version_n","media_id")
);
--> statement-breakpoint
CREATE TABLE "versions" (
	"job_id" text,
	"n" integer,
	"prompt" text NOT NULL,
	"author_id" text NOT NULL,
	"api_key_id" text,
	"target_duration_sec" double precision,
	"parent_n" integer,
	"webhook_url" text,
	"status" text NOT NULL,
	"created_at" text NOT NULL,
	"plan" jsonb,
	"contract" integer,
	"mode" text DEFAULT 'author' NOT NULL,
	"edited_from_n" integer,
	"frozen" jsonb,
	"sound" text DEFAULT 'silent' NOT NULL,
	"engine" text DEFAULT 'hyperframes' NOT NULL,
	"voiceover" jsonb,
	"narration" jsonb,
	"captions" jsonb,
	"poster" jsonb,
	"remix" jsonb,
	"recording" jsonb,
	"scope" jsonb,
	"beats" jsonb,
	"look" jsonb,
	"context" jsonb,
	CONSTRAINT "versions_pkey" PRIMARY KEY("job_id","n")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY,
	"event_id" text NOT NULL,
	"dest_kind" text NOT NULL,
	"dest_ref" text NOT NULL,
	"url" text NOT NULL,
	"lease_until" text,
	"next_retry_at" text,
	"deliver_until" text NOT NULL,
	"attempts" integer NOT NULL,
	"last_result" text,
	"delivered_at" text,
	"dropped_at" text
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"event_id" text PRIMARY KEY,
	"job_id" text NOT NULL,
	"version_n" integer,
	"attempt_id" text,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "api_keys_owner_idx" ON "api_keys" ("owner_id");--> statement-breakpoint
CREATE INDEX "attempts_due_idx" ON "attempts" ("next_action_at") WHERE "stage" not in ('ready','failed','cancelled','timed_out','queued','unresolved');--> statement-breakpoint
CREATE INDEX "attempts_queued_idx" ON "attempts" ("queued_at") WHERE "stage" = 'queued';--> statement-breakpoint
CREATE INDEX "attempts_job_idx" ON "attempts" ("job_id","version_n");--> statement-breakpoint
CREATE UNIQUE INDEX "cleanup_store_prefix_idx" ON "cleanup" ("store","prefix");--> statement-breakpoint
CREATE INDEX "cli_login_failures_user_idx" ON "cli_login_failures" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "cli_logins_user_code_idx" ON "cli_logins" ("user_code");--> statement-breakpoint
CREATE INDEX "cli_logins_status_ip_idx" ON "cli_logins" ("status","client_ip");--> statement-breakpoint
CREATE INDEX "cli_logins_expires_idx" ON "cli_logins" ("expires_at");--> statement-breakpoint
CREATE INDEX "comments_job_idx" ON "comments" ("job_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "destination_connections_user_kind_idx" ON "destination_connections" ("user_id","kind");--> statement-breakpoint
CREATE INDEX "destination_publications_job_idx" ON "destination_publications" ("job_id");--> statement-breakpoint
CREATE INDEX "destination_publications_due_idx" ON "destination_publications" ("next_run_at") WHERE "status" in ('queued', 'running', 'waiting', 'removing');--> statement-breakpoint
CREATE UNIQUE INDEX "destination_publications_active_idx" ON "destination_publications" ("job_id","version_n","kind",coalesce("destination_id", ''),"target_key") WHERE "desired" = 'published';--> statement-breakpoint
CREATE INDEX "edits_author_idx" ON "edits" ("author_id","job_id");--> statement-breakpoint
CREATE INDEX "edits_expires_idx" ON "edits" ("expires_at");--> statement-breakpoint
CREATE INDEX "gateway_calls_at_idx" ON "gateway_calls" ("at");--> statement-breakpoint
CREATE INDEX "gateway_calls_caller_idx" ON "gateway_calls" ("caller_id","at");--> statement-breakpoint
CREATE INDEX "jobs_tags_idx" ON "jobs" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "jobs_created_idx" ON "jobs" ("created_at","id");--> statement-breakpoint
CREATE INDEX "jobs_owner_idx" ON "jobs" ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_owner_external_ref_idx" ON "jobs" ("owner_id","external_ref");--> statement-breakpoint
CREATE INDEX "media_created_idx" ON "media" ("created_at");--> statement-breakpoint
CREATE INDEX "media_uploader_idx" ON "media" ("uploader_id");--> statement-breakpoint
CREATE INDEX "media_source_idx" ON "media" ("source","source_id");--> statement-breakpoint
CREATE INDEX "media_uploader_role_idx" ON "media" ("uploader_id","role");--> statement-breakpoint
CREATE INDEX "media_refs_media_idx" ON "media_refs" ("media_id");--> statement-breakpoint
CREATE INDEX "media_refs_job_idx" ON "media_refs" ("job_id","owner_kind");--> statement-breakpoint
CREATE INDEX "media_uploads_uploader_idx" ON "media_uploads" ("uploader_id","status");--> statement-breakpoint
CREATE INDEX "media_uploads_expires_idx" ON "media_uploads" ("expires_at");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "oauth_grants_user_idx" ON "oauth_grants" ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_grants_client_idx" ON "oauth_grants" ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_requests_consent_idx" ON "oauth_requests" ("consent_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_requests_code_idx" ON "oauth_requests" ("code_hash");--> statement-breakpoint
CREATE INDEX "oauth_requests_expires_idx" ON "oauth_requests" ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_tokens_grant_idx" ON "oauth_tokens" ("grant_id");--> statement-breakpoint
CREATE INDEX "oauth_tokens_expires_idx" ON "oauth_tokens" ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "openverse_jobs_inflight_idx" ON "openverse_jobs" ("user_id","kind","key") WHERE "status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "openverse_jobs_key_idx" ON "openverse_jobs" ("kind","key","updated_at");--> statement-breakpoint
CREATE INDEX "openverse_jobs_user_idx" ON "openverse_jobs" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "openverse_jobs_expires_idx" ON "openverse_jobs" ("expires_at");--> statement-breakpoint
CREATE INDEX "openverse_search_uses_day_idx" ON "openverse_search_uses" ("day");--> statement-breakpoint
CREATE INDEX "openverse_searches_fetched_idx" ON "openverse_searches" ("fetched_at");--> statement-breakpoint
CREATE INDEX "plans_user_idx" ON "plans" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "publications_job_idx" ON "publications" ("job_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" ("expires_at");--> statement-breakpoint
CREATE INDEX "user_identities_user_idx" ON "user_identities" ("user_id");--> statement-breakpoint
CREATE INDEX "verdicts_job_idx" ON "verdicts" ("job_id");--> statement-breakpoint
CREATE INDEX "version_media_media_idx" ON "version_media" ("media_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_dest_idx" ON "webhook_deliveries" ("event_id","dest_kind","dest_ref");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" ("next_retry_at") WHERE "delivered_at" is null and "dropped_at" is null;