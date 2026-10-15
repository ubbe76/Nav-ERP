ALTER TABLE "customers" ADD COLUMN "our_supplier_number" varchar(50);--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "collective_invoicing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "private_person" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "website" varchar(255);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "private_person" boolean DEFAULT false NOT NULL;