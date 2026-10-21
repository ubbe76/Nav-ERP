ALTER TYPE "public"."email_document_type" ADD VALUE 'alert_digest';--> statement-breakpoint
CREATE TABLE "alert_digest_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"digest_date" date NOT NULL,
	"status" varchar(16) NOT NULL,
	"alert_count" integer DEFAULT 0 NOT NULL,
	"email_log_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_digest_runs_user_id_digest_date_unique" UNIQUE("user_id","digest_date")
);
--> statement-breakpoint
ALTER TABLE "alert_digest_runs" ADD CONSTRAINT "alert_digest_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_digest_runs" ADD CONSTRAINT "alert_digest_runs_email_log_id_email_log_id_fk" FOREIGN KEY ("email_log_id") REFERENCES "public"."email_log"("id") ON DELETE set null ON UPDATE no action;