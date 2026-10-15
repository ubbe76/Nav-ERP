CREATE TABLE "customer_delivery_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"label" varchar(100) NOT NULL,
	"address" text NOT NULL,
	"postal_code" varchar(20),
	"city" varchar(100),
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "invoice_address" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "invoice_postal_code" varchar(20);--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "invoice_city" varchar(100);--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "invoice_email" varchar(255);--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "customer_order_number" varchar(50);--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "customer_reference" varchar(100);--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "delivery_address_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_delivery_addresses" ADD CONSTRAINT "customer_delivery_addresses_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_delivery_addresses_one_default" ON "customer_delivery_addresses" USING btree ("customer_id") WHERE "customer_delivery_addresses"."is_default";--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_delivery_address_id_customer_delivery_addresses_id_fk" FOREIGN KEY ("delivery_address_id") REFERENCES "public"."customer_delivery_addresses"("id") ON DELETE set null ON UPDATE no action;