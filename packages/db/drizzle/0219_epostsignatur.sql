-- E-postsignatur: email_log.sender_id är användaren mejlet skickades som —
-- vars signatur det bar. Skicka om signerar med samma användares signatur.
-- Null = ingen användare bakom (testmejlet, sammanställningen) eller skickat
-- före 0219.
ALTER TABLE "email_log" ADD COLUMN "sender_id" uuid;--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;