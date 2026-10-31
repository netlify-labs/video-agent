ALTER TABLE "jobs" ADD COLUMN "private" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "access_epoch" integer DEFAULT 0 NOT NULL;