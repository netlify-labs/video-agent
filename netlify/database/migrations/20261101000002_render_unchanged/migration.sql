ALTER TABLE "versions" ADD COLUMN "mode" text DEFAULT 'author' NOT NULL;--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "edited_from_n" integer;--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "frozen" jsonb;--> statement-breakpoint
ALTER TABLE "versions" ALTER COLUMN "target_duration_sec" SET DATA TYPE double precision USING "target_duration_sec"::double precision;