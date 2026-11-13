-- Inköp: leverantörens förval. suppliers.freight_paid_by_us_default fyller
-- "Frakt på vårt konto" på nya förfrågningar och inköpsordrar,
-- suppliers.purchase_order_email är mottagaren när en inköpsorder skickas
-- (null = leverantörens E-post), och email_log.cc bär utskickets kopia så
-- att Skicka om skickar samma.
ALTER TABLE "email_log" ADD COLUMN "cc" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "purchase_order_email" varchar(255);--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "freight_paid_by_us_default" boolean DEFAULT false NOT NULL;