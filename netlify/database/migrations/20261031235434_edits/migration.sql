CREATE TABLE "edits" (
	"id" text PRIMARY KEY,
	"job_id" text NOT NULL,
	"base_n" integer NOT NULL,
	"author_id" text NOT NULL,
	"rev" integer NOT NULL,
	"ops" jsonb NOT NULL,
	"bundle_sha256" text,
	"rendered_n" integer,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "edits_author_idx" ON "edits" ("author_id","job_id");--> statement-breakpoint
CREATE INDEX "edits_expires_idx" ON "edits" ("expires_at");