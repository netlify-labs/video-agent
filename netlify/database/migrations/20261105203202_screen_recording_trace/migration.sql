ALTER TABLE "media" ADD COLUMN "trace_key" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "trace_sha256" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "trace_writes" jsonb;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "recording_quota_bytes" bigint DEFAULT 2147483648 NOT NULL;--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "recording" jsonb;