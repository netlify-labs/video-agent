CREATE TABLE "media_refs" (
	"media_id" text,
	"owner_kind" text,
	"owner_id" text,
	"job_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "media_refs_pkey" PRIMARY KEY("media_id","owner_kind","owner_id")
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
ALTER TABLE "media" ADD COLUMN "role" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "scope_job_id" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "retain_until" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "deleting_at" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "narration_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "transcription_provider" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "take_quota_bytes" bigint DEFAULT 2147483648 NOT NULL;--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "narration" jsonb;--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "captions" jsonb;--> statement-breakpoint
CREATE INDEX "media_uploader_role_idx" ON "media" ("uploader_id","role");--> statement-breakpoint
CREATE INDEX "media_refs_media_idx" ON "media_refs" ("media_id");--> statement-breakpoint
CREATE INDEX "media_refs_job_idx" ON "media_refs" ("job_id","owner_kind");