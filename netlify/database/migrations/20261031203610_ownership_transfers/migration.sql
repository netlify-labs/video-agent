CREATE TABLE "ownership_transfers" (
	"id" text PRIMARY KEY,
	"job_id" text NOT NULL,
	"from_user_id" text NOT NULL,
	"to_user_id" text NOT NULL,
	"by_user_id" text NOT NULL,
	"at" text NOT NULL
);
