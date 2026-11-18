CREATE TABLE "conversation_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid,
	"employee_id" uuid,
	"kind" varchar(10) NOT NULL,
	"board_until" date,
	"last_read_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	CONSTRAINT "conversation_participants_one_party" CHECK (num_nonnulls("conversation_participants"."user_id", "conversation_participants"."employee_id") = 1),
	CONSTRAINT "conversation_participants_kind" CHECK ("conversation_participants"."kind" in ('user', 'terminal', 'employee')),
	CONSTRAINT "conversation_participants_kind_party" CHECK (("conversation_participants"."kind" = 'employee') = ("conversation_participants"."employee_id" is not null)),
	CONSTRAINT "conversation_participants_board_terminal" CHECK ("conversation_participants"."board_until" is null or "conversation_participants"."kind" = 'terminal')
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject" varchar(200) NOT NULL,
	"link_href" varchar(500),
	"link_title" varchar(200),
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_link_both_or_neither" CHECK (("conversations"."link_href" is null) = ("conversations"."link_title" is null))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_participants_user_unique" ON "conversation_participants" USING btree ("conversation_id","user_id") WHERE "conversation_participants"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_participants_employee_unique" ON "conversation_participants" USING btree ("conversation_id","employee_id") WHERE "conversation_participants"."employee_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_conversation_participants_user" ON "conversation_participants" USING btree ("user_id") WHERE "conversation_participants"."user_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_conversation_participants_employee" ON "conversation_participants" USING btree ("employee_id") WHERE "conversation_participants"."employee_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_conversations_last_message" ON "conversations" USING btree ("last_message_at");--> statement-breakpoint
CREATE INDEX "idx_messages_conversation_created" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
-- An anonymized employee gets no new rows (0170): a conversation can never
-- be addressed to one. Rows with a user (employee_id null) pass. The
-- employee's existing participant rows stay (UPDATEs pass the guard) and
-- show the anonymized name; deleting an employee cascades them away.
CREATE TRIGGER conversation_participants_anonymized_guard BEFORE INSERT ON conversation_participants
  FOR EACH ROW EXECUTE FUNCTION nav_employee_anonymized_guard();