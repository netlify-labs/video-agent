ALTER TABLE "settings" ADD COLUMN "default_look" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "disabled_looks" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "look" jsonb;