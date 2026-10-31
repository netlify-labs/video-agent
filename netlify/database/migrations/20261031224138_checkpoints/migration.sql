CREATE TABLE "checkpoints" (
	"attempt_id" text PRIMARY KEY,
	"job_id" text NOT NULL,
	"seq" integer NOT NULL,
	"message" text,
	"render_percent" integer,
	"bundle_key" text,
	"created_at" text NOT NULL,
	"window_start" text NOT NULL,
	"window_count" integer NOT NULL
);
