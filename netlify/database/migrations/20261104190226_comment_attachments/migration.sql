ALTER TABLE "comments" ADD COLUMN "media_ids" jsonb;--> statement-breakpoint
ALTER TABLE "version_comments" ADD COLUMN "files" jsonb;