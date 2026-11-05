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
ALTER TABLE "settings" ADD COLUMN "youtube_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "destination_connections_user_kind_idx" ON "destination_connections" ("user_id","kind");--> statement-breakpoint
CREATE INDEX "destination_publications_job_idx" ON "destination_publications" ("job_id");--> statement-breakpoint
CREATE INDEX "destination_publications_due_idx" ON "destination_publications" ("next_run_at") WHERE "status" in ('queued', 'running', 'waiting', 'removing');--> statement-breakpoint
CREATE UNIQUE INDEX "destination_publications_active_idx" ON "destination_publications" ("job_id","version_n","kind",coalesce("destination_id", ''),"target_key") WHERE "desired" = 'published';