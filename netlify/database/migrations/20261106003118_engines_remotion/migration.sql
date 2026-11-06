ALTER TABLE "attempts" ADD COLUMN "engine_renders" jsonb;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "remotion_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "remotion_license_ack" jsonb;