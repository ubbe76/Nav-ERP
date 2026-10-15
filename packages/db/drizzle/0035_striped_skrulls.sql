ALTER TYPE "public"."email_document_type" ADD VALUE 'invoice' BEFORE 'test';--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "invoice_number" varchar(20);--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "invoiced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_invoice_number_unique" UNIQUE("invoice_number");--> statement-breakpoint
INSERT INTO "number_series" ("key", "prefix", "next_number", "digits") VALUES ('invoice', 'FA-', 5001, 0);
