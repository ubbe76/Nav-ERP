-- Avsändning till legoleverantör: the dispatch log (purchase_order_dispatches +
-- rows, no stock effect — Skickat is derived as Σ quantity over dispatches not
-- undone), the delivery address snapshot on purchase_orders (all null = the
-- company address) and the company godsadress on company_info.
CREATE TABLE "purchase_order_dispatch_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dispatch_id" uuid NOT NULL,
	"purchase_order_row_id" uuid NOT NULL,
	"quantity" numeric(14, 4) NOT NULL,
	"parcels" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "purchase_order_dispatch_rows_quantity_positive" CHECK ("purchase_order_dispatch_rows"."quantity" > 0),
	CONSTRAINT "purchase_order_dispatch_rows_parcels_min" CHECK ("purchase_order_dispatch_rows"."parcels" >= 1)
);
--> statement-breakpoint
CREATE TABLE "purchase_order_dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"dispatched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_by" uuid,
	"note" text,
	"undone_at" timestamp with time zone,
	"undone_by" uuid
);
--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "delivery_name" varchar(255);--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "delivery_address" text;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "delivery_postal_code" varchar(20);--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "delivery_city" varchar(100);--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "delivery_country" varchar(2);--> statement-breakpoint
ALTER TABLE "company_info" ADD COLUMN "delivery_address" varchar(255);--> statement-breakpoint
ALTER TABLE "company_info" ADD COLUMN "delivery_postal_code" varchar(20);--> statement-breakpoint
ALTER TABLE "company_info" ADD COLUMN "delivery_city" varchar(100);--> statement-breakpoint
ALTER TABLE "purchase_order_dispatch_rows" ADD CONSTRAINT "purchase_order_dispatch_rows_dispatch_id_purchase_order_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "public"."purchase_order_dispatches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_dispatch_rows" ADD CONSTRAINT "purchase_order_dispatch_rows_purchase_order_row_id_purchase_order_rows_id_fk" FOREIGN KEY ("purchase_order_row_id") REFERENCES "public"."purchase_order_rows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_dispatches" ADD CONSTRAINT "purchase_order_dispatches_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_dispatches" ADD CONSTRAINT "purchase_order_dispatches_dispatched_by_users_id_fk" FOREIGN KEY ("dispatched_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_dispatches" ADD CONSTRAINT "purchase_order_dispatches_undone_by_users_id_fk" FOREIGN KEY ("undone_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchase_order_dispatch_rows_by_row" ON "purchase_order_dispatch_rows" USING btree ("purchase_order_row_id");--> statement-breakpoint
CREATE INDEX "purchase_order_dispatches_by_order" ON "purchase_order_dispatches" USING btree ("purchase_order_id","dispatched_at");