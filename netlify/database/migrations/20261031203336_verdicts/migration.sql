CREATE TABLE "verdicts" (
	"job_id" text,
	"version_n" integer,
	"user_id" text,
	"verdict" text NOT NULL,
	"note" text,
	"updated_at" text NOT NULL,
	CONSTRAINT "verdicts_pkey" PRIMARY KEY("job_id","version_n","user_id")
);
--> statement-breakpoint
CREATE INDEX "verdicts_job_idx" ON "verdicts" ("job_id");