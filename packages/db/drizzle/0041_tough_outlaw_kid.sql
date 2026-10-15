CREATE TABLE "company_carriers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"carrier_id" uuid NOT NULL,
	"customer_number" varchar(50) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_carriers_carrier_unique" UNIQUE("carrier_id")
);
--> statement-breakpoint
ALTER TABLE "inquiries" ADD COLUMN "freight_paid_by_us" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "freight_paid_by_us" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "company_carriers" ADD CONSTRAINT "company_carriers_carrier_id_carriers_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carriers"("id") ON DELETE restrict ON UPDATE no action;