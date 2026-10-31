CREATE TABLE "gateway_calls" (
	"id" text PRIMARY KEY,
	"caller_id" text NOT NULL,
	"plan_id" text,
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_tokens" integer NOT NULL,
	"credits" double precision,
	"estimate" boolean NOT NULL,
	"ok" boolean NOT NULL,
	"error" text,
	"ms" integer NOT NULL,
	"at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"job_id" text,
	"base_n" integer,
	"prompt" text NOT NULL,
	"aspect" text,
	"duration_sec" integer,
	"inputs_hash" text NOT NULL,
	"route" jsonb,
	"questions" jsonb,
	"answers" jsonb,
	"brief" jsonb,
	"brief_rev" integer NOT NULL,
	"consumed_by_job_id" text,
	"consumed_by_n" integer,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "plan_deep_model" text;--> statement-breakpoint
CREATE INDEX "gateway_calls_at_idx" ON "gateway_calls" ("at");--> statement-breakpoint
CREATE INDEX "gateway_calls_caller_idx" ON "gateway_calls" ("caller_id","at");--> statement-breakpoint
CREATE INDEX "plans_user_idx" ON "plans" ("user_id","created_at");