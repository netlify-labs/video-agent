CREATE TABLE "comments" (
	"id" text PRIMARY KEY,
	"job_id" text NOT NULL,
	"version_n" integer NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"time_sec" double precision,
	"x" double precision,
	"y" double precision,
	"created_at" text NOT NULL,
	"edited_at" text,
	"resolved_at" text,
	"resolved_by" text,
	"addressed_in_n" integer,
	"deleted_at" text
);
--> statement-breakpoint
CREATE INDEX "comments_job_idx" ON "comments" ("job_id","created_at");