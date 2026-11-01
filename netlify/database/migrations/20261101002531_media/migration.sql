CREATE TABLE "media" (
	"id" text PRIMARY KEY,
	"uploader_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"reject_reason" text,
	"filename" text NOT NULL,
	"caption" text,
	"mime" text NOT NULL,
	"ext" text NOT NULL,
	"bytes" bigint NOT NULL,
	"original_key" text NOT NULL,
	"original_sha256" text NOT NULL,
	"clean_key" text NOT NULL,
	"clean_sha256" text NOT NULL,
	"width" integer,
	"height" integer,
	"duration_sec" double precision,
	"poster_key" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text
);
--> statement-breakpoint
CREATE TABLE "version_media" (
	"job_id" text,
	"version_n" integer,
	"media_id" text,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"sha256" text NOT NULL,
	"filename" text NOT NULL,
	"caption" text,
	CONSTRAINT "version_media_pkey" PRIMARY KEY("job_id","version_n","media_id")
);
--> statement-breakpoint
CREATE INDEX "media_created_idx" ON "media" ("created_at");--> statement-breakpoint
CREATE INDEX "media_uploader_idx" ON "media" ("uploader_id");--> statement-breakpoint
CREATE INDEX "version_media_media_idx" ON "version_media" ("media_id");