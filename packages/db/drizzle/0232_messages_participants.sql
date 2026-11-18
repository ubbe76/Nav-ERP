CREATE TABLE "message_event_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"user_id" uuid,
	"employee_id" uuid,
	CONSTRAINT "message_event_targets_one_party" CHECK (num_nonnulls("message_event_targets"."user_id", "message_event_targets"."employee_id") <= 1)
);
--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "sender_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "body" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "last_entry_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sender_employee_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "kind" varchar(10) DEFAULT 'message' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "event_type" varchar(10);--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message_event_targets" ADD CONSTRAINT "message_event_targets_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_event_targets" ADD CONSTRAINT "message_event_targets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_event_targets" ADD CONSTRAINT "message_event_targets_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_message_event_targets_message" ON "message_event_targets" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_message_event_targets_employee" ON "message_event_targets" USING btree ("employee_id") WHERE "message_event_targets"."employee_id" is not null;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_employee_id_employees_id_fk" FOREIGN KEY ("sender_employee_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_messages_sender_employee" ON "messages" USING btree ("sender_employee_id") WHERE "messages"."sender_employee_id" is not null;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_kind" CHECK ("messages"."kind" in ('message', 'event'));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_one_sender" CHECK (num_nonnulls("messages"."sender_id", "messages"."sender_employee_id") <= 1);--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_message_shape" CHECK ("messages"."kind" <> 'message' or ("messages"."event_type" is null and ("messages"."body" is null) = ("messages"."deleted_at" is not null) and ("messages"."deleted_at" is not null or num_nonnulls("messages"."sender_id", "messages"."sender_employee_id") = 1)));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_event_shape" CHECK ("messages"."kind" <> 'event' or ("messages"."event_type" in ('added', 'removed', 'left') and "messages"."body" is null and "messages"."deleted_at" is null and "messages"."sender_id" is not null));--> statement-breakpoint
-- Existing conversations: the newest row is the newest message.
UPDATE "conversations" SET "last_entry_at" = "last_message_at";--> statement-breakpoint
-- An anonymized employee writes no more replies (0170's NV002, as the guard
-- on conversation_participants in 0231 — that function reads employee_id,
-- this column is sender_employee_id).
CREATE OR REPLACE FUNCTION nav_message_sender_anonymized_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sender_employee_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM employees WHERE id = NEW.sender_employee_id AND anonymized_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Employee % is anonymized and gets no new rows', NEW.sender_employee_id USING ERRCODE = 'NV002';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER messages_sender_anonymized_guard BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION nav_message_sender_anonymized_guard();
