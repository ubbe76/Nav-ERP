CREATE TABLE "carriers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(20) NOT NULL,
	"name" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "carriers_code_unique" UNIQUE("code"),
	CONSTRAINT "carriers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "delivery_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(20) NOT NULL,
	"name" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_terms_code_unique" UNIQUE("code"),
	CONSTRAINT "delivery_terms_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "payment_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(20) NOT NULL,
	"name" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_terms_code_unique" UNIQUE("code"),
	CONSTRAINT "payment_terms_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "postal_code" varchar(20);--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "city" varchar(100);--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "org_number" varchar(20);--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "vat_number" varchar(30);--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "delivery_term_id" uuid;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "payment_term_id" uuid;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "carrier_id" uuid;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "carrier_customer_number" varchar(50);--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "postal_code" varchar(20);--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "city" varchar(100);--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "org_number" varchar(20);--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "vat_number" varchar(30);--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "delivery_term_id" uuid;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "payment_term_id" uuid;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "carrier_id" uuid;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "carrier_customer_number" varchar(50);--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_delivery_term_id_delivery_terms_id_fk" FOREIGN KEY ("delivery_term_id") REFERENCES "public"."delivery_terms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_payment_term_id_payment_terms_id_fk" FOREIGN KEY ("payment_term_id") REFERENCES "public"."payment_terms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_carrier_id_carriers_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carriers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_delivery_term_id_delivery_terms_id_fk" FOREIGN KEY ("delivery_term_id") REFERENCES "public"."delivery_terms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_payment_term_id_payment_terms_id_fk" FOREIGN KEY ("payment_term_id") REFERENCES "public"."payment_terms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_carrier_id_carriers_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carriers"("id") ON DELETE restrict ON UPDATE no action;