ALTER TABLE "jobs" ADD COLUMN "remix_of_job_id" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "remix_of_n" integer;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "remix_from_job_id" text;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "remix_from_n" integer;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "remix_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "remix" jsonb;