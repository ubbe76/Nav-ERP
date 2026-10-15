CREATE TABLE "supplier_delivery_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_id" uuid NOT NULL,
	"label" varchar(100) NOT NULL,
	"address" text NOT NULL,
	"postal_code" varchar(20),
	"city" varchar(100),
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "supplier_delivery_addresses" ADD CONSTRAINT "supplier_delivery_addresses_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_delivery_addresses_one_default" ON "supplier_delivery_addresses" USING btree ("supplier_id") WHERE "supplier_delivery_addresses"."is_default";