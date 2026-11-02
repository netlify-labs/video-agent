CREATE TABLE "openverse_search_uses" (
	"key" text,
	"day" text,
	"count" integer NOT NULL,
	CONSTRAINT "openverse_search_uses_pkey" PRIMARY KEY("key","day")
);
--> statement-breakpoint
CREATE TABLE "openverse_searches" (
	"key" text PRIMARY KEY,
	"result" jsonb NOT NULL,
	"fetched_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "openverse_search_uses_day_idx" ON "openverse_search_uses" ("day");--> statement-breakpoint
CREATE INDEX "openverse_searches_fetched_idx" ON "openverse_searches" ("fetched_at");