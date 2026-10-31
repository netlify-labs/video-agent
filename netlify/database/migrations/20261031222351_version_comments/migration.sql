CREATE TABLE "version_comments" (
	"job_id" text,
	"version_n" integer,
	"comment_id" text,
	"position" integer NOT NULL,
	"author_id" text NOT NULL,
	"author_name" text,
	"body" text NOT NULL,
	"time_sec" double precision,
	"x" double precision,
	"y" double precision,
	CONSTRAINT "version_comments_pkey" PRIMARY KEY("job_id","version_n","comment_id")
);
