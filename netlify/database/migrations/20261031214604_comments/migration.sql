CREATE TABLE "comment_reads" (
	"user_id" text,
	"job_id" text,
	"read_at" text NOT NULL,
	CONSTRAINT "comment_reads_pkey" PRIMARY KEY("user_id","job_id")
);
