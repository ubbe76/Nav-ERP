CREATE TABLE "vat_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"verification_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vat_settlements_verification_id_unique" UNIQUE("verification_id"),
	CONSTRAINT "vat_settlement_range_valid" CHECK ("vat_settlements"."to_date" >= "vat_settlements"."from_date")
);
--> statement-breakpoint
ALTER TABLE "vat_settlements" ADD CONSTRAINT "vat_settlements_verification_id_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vat_settlements" ADD CONSTRAINT "vat_settlements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_vat_settlements_range" ON "vat_settlements" USING btree ("from_date","to_date");