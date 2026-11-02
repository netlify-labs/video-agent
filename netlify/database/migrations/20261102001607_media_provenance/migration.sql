ALTER TABLE "media" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "source_title" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "license" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "license_version" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "license_url" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "creator" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "creator_url" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "attribution" text;--> statement-breakpoint
CREATE INDEX "media_source_idx" ON "media" ("source","source_id");