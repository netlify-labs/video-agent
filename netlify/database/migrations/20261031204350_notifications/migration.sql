CREATE TABLE "notification_reads" (
	"user_id" text PRIMARY KEY,
	"read_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"job_id" text NOT NULL,
	"version_n" integer,
	"type" text NOT NULL,
	"actor_id" text NOT NULL,
	"summary" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" ("user_id","created_at");