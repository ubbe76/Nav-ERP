ALTER TYPE "public"."sales_order_status" ADD VALUE 'lost';--> statement-breakpoint
CREATE TABLE "quote_loss_reasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(10) NOT NULL,
	"name" varchar(100) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quote_loss_reasons_code_unique" UNIQUE("code"),
	CONSTRAINT "quote_loss_reasons_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "quoted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "quote_valid_until" date;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "lost_reason_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "lost_note" text;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "lost_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "lost_by" uuid;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_lost_reason_id_quote_loss_reasons_id_fk" FOREIGN KEY ("lost_reason_id") REFERENCES "public"."quote_loss_reasons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_lost_by_users_id_fk" FOREIGN KEY ("lost_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Uppföljning av offerter: the five pre-filled loss reasons (editable and
-- deletable like any register entry — existing codes/names are never
-- overwritten) and the backfill: only the quotes that are OPEN at the
-- upgrade can be told apart from direct orders (Ny kundorder also logs
-- `confirmed`), so only they get quoted = true. Older orders never count
-- in the hit rate.
INSERT INTO "quote_loss_reasons" ("code", "name") VALUES
	('PRIS', 'Pris'),
	('LEVTID', 'Leveranstid'),
	('ANNAN', 'Valde annan leverantör'),
	('PROJEKT', 'Projektet lades ned'),
	('SVAR', 'Inget svar från kunden')
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "sales_orders" SET "quoted" = true WHERE "status" = 'quote';
