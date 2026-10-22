CREATE TABLE "attendance_deviation_reasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(10) NOT NULL,
	"name" varchar(100) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_deviation_reasons_code_unique" UNIQUE("code"),
	CONSTRAINT "attendance_deviation_reasons_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD COLUMN "start_reason_id" uuid;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD COLUMN "start_note" text;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD COLUMN "stop_reason_id" uuid;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD COLUMN "stop_note" text;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_start_reason_id_attendance_deviation_reasons_id_fk" FOREIGN KEY ("start_reason_id") REFERENCES "public"."attendance_deviation_reasons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_stop_reason_id_attendance_deviation_reasons_id_fk" FOREIGN KEY ("stop_reason_id") REFERENCES "public"."attendance_deviation_reasons"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "attendance_deviation_reasons" ("code", "name") VALUES
	('TRAFIK', 'Trafik/resa'),
	('LAKARE', 'Läkar-/tandläkarbesök'),
	('SJUK', 'Sjuk'),
	('PRIVAT', 'Privat ärende'),
	('VAB', 'Vård av barn'),
	('OVR', 'Övrigt')
ON CONFLICT DO NOTHING;
