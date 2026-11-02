CREATE TABLE "openverse_jobs" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"params" jsonb NOT NULL,
	"status" text NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "openverse_jobs_inflight_idx" ON "openverse_jobs" ("user_id","kind","key") WHERE "status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "openverse_jobs_key_idx" ON "openverse_jobs" ("kind","key","updated_at");--> statement-breakpoint
CREATE INDEX "openverse_jobs_user_idx" ON "openverse_jobs" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "openverse_jobs_expires_idx" ON "openverse_jobs" ("expires_at");