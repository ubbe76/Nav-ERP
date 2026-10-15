CREATE TABLE "shipment_tracking_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"status" varchar(50) DEFAULT '' NOT NULL,
	"description" text,
	"location" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "default_freight_product_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_rows" ADD COLUMN "shipment_id" uuid;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "tracking_status" varchar(50);--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "last_tracking_text" varchar(500);--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "tracking_exception" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "tracking_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipment_tracking_events" ADD CONSTRAINT "shipment_tracking_events_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_tracking_events_unique" ON "shipment_tracking_events" USING btree ("shipment_id","occurred_at","status");--> statement-breakpoint
CREATE INDEX "idx_shipment_tracking_events_shipment" ON "shipment_tracking_events" USING btree ("shipment_id");--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_default_freight_product_id_freight_products_id_fk" FOREIGN KEY ("default_freight_product_id") REFERENCES "public"."freight_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_rows" ADD CONSTRAINT "invoice_rows_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_rows_shipment_unique" ON "invoice_rows" USING btree ("shipment_id") WHERE "invoice_rows"."shipment_id" IS NOT NULL;