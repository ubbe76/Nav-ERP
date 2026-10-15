INSERT INTO "number_series" ("key","prefix","next_number","digits") VALUES ('customer','',1001,0);--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "customer_number" varchar(50);--> statement-breakpoint
UPDATE "customers" c SET "customer_number" = s.n::text
FROM (SELECT id, 1000 + row_number() OVER (ORDER BY created_at, id) AS n FROM "customers") s
WHERE c.id = s.id;--> statement-breakpoint
UPDATE "number_series" SET "next_number" = 1001 + (SELECT count(*) FROM "customers") WHERE "key" = 'customer';--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "customer_number" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_customer_number_unique" UNIQUE("customer_number");--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "customer_number" varchar(50);
