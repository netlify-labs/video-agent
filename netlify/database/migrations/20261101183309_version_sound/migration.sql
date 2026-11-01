ALTER TABLE "plans" ADD COLUMN "sound" text;--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "sound" text DEFAULT 'silent' NOT NULL;