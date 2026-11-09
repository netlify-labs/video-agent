ALTER TABLE "jobs" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
CREATE INDEX "jobs_tags_idx" ON "jobs" USING gin ("tags");