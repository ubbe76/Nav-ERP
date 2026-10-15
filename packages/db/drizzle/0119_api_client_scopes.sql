ALTER TABLE "api_clients" ADD COLUMN "scopes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "api_clients" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Behörigheter per klient (4.9): existing clients keep every right — the
-- behaviour they had before scopes existed. New clients always get an explicit list.
UPDATE "api_clients" SET "scopes" = ARRAY['configurator:read','prices:read','quotes:create','orders:confirm','structure:read']::text[];