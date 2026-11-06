ALTER TABLE "jobs" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "external_url" text;--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "context" jsonb;--> statement-breakpoint
CREATE INDEX "jobs_owner_external_ref_idx" ON "jobs" ("owner_id","external_ref");