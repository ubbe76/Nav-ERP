ALTER TABLE "customer_delivery_addresses" ADD COLUMN "country" varchar(2) DEFAULT 'SE' NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "country" varchar(2) DEFAULT 'SE' NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "discount_percent" numeric(5, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "invoice_name" varchar(255);--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "invoice_country" varchar(2);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "invoice_country" varchar(2);