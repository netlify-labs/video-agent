CREATE TABLE "user_webhooks" (
	"user_id" text PRIMARY KEY,
	"url" text NOT NULL,
	"secret_enc" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY,
	"event_id" text NOT NULL,
	"dest_kind" text NOT NULL,
	"dest_ref" text NOT NULL,
	"url" text NOT NULL,
	"lease_until" text,
	"next_retry_at" text,
	"deliver_until" text NOT NULL,
	"attempts" integer NOT NULL,
	"last_result" text,
	"delivered_at" text,
	"dropped_at" text
);
--> statement-breakpoint
-- Move existing events' delivery state into one delivery row each (their per-video API-key webhook).
INSERT INTO "webhook_deliveries" ("id", "event_id", "dest_kind", "dest_ref", "url", "lease_until", "next_retry_at", "deliver_until", "attempts", "last_result", "delivered_at", "dropped_at")
SELECT "event_id", "event_id", 'version_key', "api_key_id", "url", "lease_until", "next_retry_at", "deliver_until", "attempts", "last_result", "delivered_at", NULL FROM "webhook_events";--> statement-breakpoint
DROP INDEX "webhook_events_due_idx";--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "team_webhook_url" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "team_webhook_secret_enc" text;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "created_at" text;--> statement-breakpoint
UPDATE "webhook_events" SET "created_at" = COALESCE("delivered_at", "next_retry_at", "deliver_until");--> statement-breakpoint
ALTER TABLE "webhook_events" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_events" DROP COLUMN "api_key_id";--> statement-breakpoint
ALTER TABLE "webhook_events" DROP COLUMN "url";--> statement-breakpoint
ALTER TABLE "webhook_events" DROP COLUMN "lease_until";--> statement-breakpoint
ALTER TABLE "webhook_events" DROP COLUMN "next_retry_at";--> statement-breakpoint
ALTER TABLE "webhook_events" DROP COLUMN "deliver_until";--> statement-breakpoint
ALTER TABLE "webhook_events" DROP COLUMN "attempts";--> statement-breakpoint
ALTER TABLE "webhook_events" DROP COLUMN "last_result";--> statement-breakpoint
ALTER TABLE "webhook_events" DROP COLUMN "delivered_at";--> statement-breakpoint
ALTER TABLE "webhook_events" ALTER COLUMN "version_n" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_events" ALTER COLUMN "attempt_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_dest_idx" ON "webhook_deliveries" ("event_id","dest_kind","dest_ref");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" ("next_retry_at") WHERE "delivered_at" is null and "dropped_at" is null;