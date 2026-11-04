CREATE TABLE "favorites" (
	"user_id" text,
	"job_id" text,
	"created_at" text NOT NULL,
	CONSTRAINT "favorites_pkey" PRIMARY KEY("user_id","job_id")
);
