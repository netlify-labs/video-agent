CREATE TABLE "oauth_clients" (
	"id" text PRIMARY KEY,
	"name" text,
	"redirect_uris" jsonb NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_grants" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"client_name" text,
	"resource" text NOT NULL,
	"created_at" text NOT NULL,
	"last_used_at" text,
	"expires_at" text NOT NULL,
	"revoked_at" text
);
--> statement-breakpoint
CREATE TABLE "oauth_requests" (
	"id" text PRIMARY KEY,
	"client_id" text NOT NULL,
	"client_name" text,
	"redirect_uri" text NOT NULL,
	"resource" text NOT NULL,
	"state" text NOT NULL,
	"code_challenge" text NOT NULL,
	"user_id" text,
	"consent_hash" text,
	"code_hash" text,
	"grant_id" text,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"used_at" text
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"hash" text PRIMARY KEY,
	"kind" text NOT NULL,
	"grant_id" text NOT NULL,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"used_at" text
);
--> statement-breakpoint
CREATE INDEX "oauth_grants_user_idx" ON "oauth_grants" ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_grants_client_idx" ON "oauth_grants" ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_requests_consent_idx" ON "oauth_requests" ("consent_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_requests_code_idx" ON "oauth_requests" ("code_hash");--> statement-breakpoint
CREATE INDEX "oauth_requests_expires_idx" ON "oauth_requests" ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_tokens_grant_idx" ON "oauth_tokens" ("grant_id");--> statement-breakpoint
CREATE INDEX "oauth_tokens_expires_idx" ON "oauth_tokens" ("expires_at");