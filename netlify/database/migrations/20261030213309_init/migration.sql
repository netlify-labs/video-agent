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
	"usage" jsonb,
	"error_category" text,
	"error_message" text,
	"queued_at" text NOT NULL,
	"started_at" text,
	"finishing_at" text,
	"ended_at" text,
	"authoring_deadline_at" text
);
--> statement-breakpoint
CREATE TABLE "callback_receipts" (
	"attempt_id" text PRIMARY KEY,
	"manifest" jsonb NOT NULL,
	"manifest_hash" text NOT NULL,
	"received_at" text NOT NULL
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
	"version" integer NOT NULL
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
	CONSTRAINT "outputs_pkey" PRIMARY KEY("job_id","version_n")
);
--> statement-breakpoint
CREATE TABLE "publications" (
	"slug" text PRIMARY KEY,
	"job_id" text NOT NULL,
	"version_n" integer NOT NULL,
	"published_by" text NOT NULL,
	"published_at" text NOT NULL,
	"unpublished_at" text
);
--> statement-breakpoint
CREATE TABLE "queue_control" (
	"id" integer PRIMARY KEY
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY,
	"file_signing_secret" text NOT NULL,
	"data_encryption_key" text NOT NULL,
	"queue_paused_reason" text,
	"created_at" text NOT NULL
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
CREATE TABLE "versions" (
	"job_id" text,
	"n" integer,
	"prompt" text NOT NULL,
	"author_id" text NOT NULL,
	"api_key_id" text,
	"target_duration_sec" integer,
	"parent_n" integer,
	"webhook_url" text,
	"status" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "versions_pkey" PRIMARY KEY("job_id","n")
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"event_id" text PRIMARY KEY,
	"job_id" text NOT NULL,
	"version_n" integer NOT NULL,
	"attempt_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"api_key_id" text NOT NULL,
	"url" text NOT NULL,
	"lease_until" text,
	"next_retry_at" text,
	"deliver_until" text NOT NULL,
	"attempts" integer NOT NULL,
	"last_result" text,
	"delivered_at" text
);
--> statement-breakpoint
CREATE INDEX "api_keys_owner_idx" ON "api_keys" ("owner_id");--> statement-breakpoint
CREATE INDEX "attempts_due_idx" ON "attempts" ("next_action_at") WHERE "stage" not in ('ready','failed','cancelled','timed_out','queued','unresolved');--> statement-breakpoint
CREATE INDEX "attempts_queued_idx" ON "attempts" ("queued_at") WHERE "stage" = 'queued';--> statement-breakpoint
CREATE INDEX "attempts_job_idx" ON "attempts" ("job_id","version_n");--> statement-breakpoint
CREATE UNIQUE INDEX "cleanup_store_prefix_idx" ON "cleanup" ("store","prefix");--> statement-breakpoint
CREATE INDEX "jobs_created_idx" ON "jobs" ("created_at","id");--> statement-breakpoint
CREATE INDEX "jobs_owner_idx" ON "jobs" ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "publications_job_idx" ON "publications" ("job_id");--> statement-breakpoint
CREATE INDEX "webhook_events_due_idx" ON "webhook_events" ("next_retry_at") WHERE "delivered_at" is null;