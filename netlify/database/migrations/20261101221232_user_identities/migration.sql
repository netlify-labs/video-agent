CREATE TABLE "sessions" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"created_at" text NOT NULL,
	"last_seen_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"rotated_at" text NOT NULL,
	"upstream_token_enc" text,
	"membership_checked_at" text,
	"membership_failed_at" text,
	"revoked_at" text
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"provider" text,
	"subject" text,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"created_at" text NOT NULL,
	"last_seen_at" text NOT NULL,
	CONSTRAINT "user_identities_pkey" PRIMARY KEY("provider","subject")
);
--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD COLUMN "upstream_token_enc" text;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD COLUMN "membership_checked_at" text;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD COLUMN "membership_failed_at" text;--> statement-breakpoint
ALTER TABLE "oauth_requests" ADD COLUMN "upstream_token_enc" text;--> statement-breakpoint
ALTER TABLE "oauth_requests" ADD COLUMN "membership_checked_at" text;--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" ("expires_at");--> statement-breakpoint
CREATE INDEX "user_identities_user_idx" ON "user_identities" ("user_id");