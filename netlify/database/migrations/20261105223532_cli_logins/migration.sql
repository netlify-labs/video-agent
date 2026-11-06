CREATE TABLE "cli_login_failures" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cli_logins" (
	"id" text PRIMARY KEY,
	"device_code_hash" text NOT NULL,
	"user_code" text NOT NULL,
	"label" text NOT NULL,
	"host" text NOT NULL,
	"client_ip" text NOT NULL,
	"status" text NOT NULL,
	"user_id" text,
	"approved_at" text,
	"api_key_id" text,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"last_polled_at" text,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "cli_login_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "cli_login_failures_user_idx" ON "cli_login_failures" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "cli_logins_user_code_idx" ON "cli_logins" ("user_code");--> statement-breakpoint
CREATE INDEX "cli_logins_status_ip_idx" ON "cli_logins" ("status","client_ip");--> statement-breakpoint
CREATE INDEX "cli_logins_expires_idx" ON "cli_logins" ("expires_at");