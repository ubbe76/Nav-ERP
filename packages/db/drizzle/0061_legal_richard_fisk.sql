INSERT INTO "number_series" ("key","prefix","next_number","digits") VALUES ('supplier','',5001,0);--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "supplier_number" varchar(50);--> statement-breakpoint
UPDATE "suppliers" s SET "supplier_number" = q.n::text
FROM (SELECT id, 5000 + row_number() OVER (ORDER BY created_at, id) AS n FROM "suppliers") q
WHERE s.id = q.id;--> statement-breakpoint
UPDATE "number_series" SET "next_number" = 5001 + (SELECT count(*) FROM "suppliers") WHERE "key" = 'supplier';--> statement-breakpoint
ALTER TABLE "suppliers" ALTER COLUMN "supplier_number" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_supplier_number_unique" UNIQUE("supplier_number");
