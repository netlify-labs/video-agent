CREATE TABLE "media_upload_parts" (
	"upload_id" text,
	"idx" integer,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	CONSTRAINT "media_upload_parts_pkey" PRIMARY KEY("upload_id","idx")
);
--> statement-breakpoint
CREATE TABLE "media_uploads" (
	"id" text PRIMARY KEY,
	"uploader_id" text NOT NULL,
	"filename" text NOT NULL,
	"caption" text,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"part_size" integer NOT NULL,
	"part_count" integer NOT NULL,
	"status" text NOT NULL,
	"media_id" text,
	"error" text,
	"lease_until" text,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "media_uploads_uploader_idx" ON "media_uploads" ("uploader_id","status");--> statement-breakpoint
CREATE INDEX "media_uploads_expires_idx" ON "media_uploads" ("expires_at");