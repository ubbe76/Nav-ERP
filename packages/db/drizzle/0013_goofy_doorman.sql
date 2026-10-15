CREATE TABLE "company_info" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) DEFAULT '' NOT NULL,
	"org_number" varchar(20),
	"address" varchar(255),
	"postal_code" varchar(20),
	"city" varchar(100),
	"phone" varchar(50),
	"email" varchar(255),
	"website" varchar(255),
	"logo" "bytea",
	"logo_content_type" varchar(100),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "number_series" (
	"key" varchar(50) PRIMARY KEY NOT NULL,
	"prefix" varchar(20) NOT NULL,
	"next_number" integer NOT NULL,
	"digits" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "manufacturing_orders" ALTER COLUMN "order_number" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "purchase_orders" ALTER COLUMN "order_number" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "sales_orders" ALTER COLUMN "order_number" DROP DEFAULT;--> statement-breakpoint
INSERT INTO "company_info" DEFAULT VALUES;--> statement-breakpoint
-- Seed number_series from each old sequence's actual current state, read
-- BEFORE the sequences are dropped below. `is_called` distinguishes
-- "last_value already issued" (next = last_value + 1) from "never issued"
-- (next = last_value itself) — the same semantics nextval() uses internally.
-- This preserves continuity: no already-issued order number is reused.
INSERT INTO "number_series" ("key", "prefix", "next_number", "digits")
SELECT 'purchase_order', 'IO-', last_value + CASE WHEN is_called THEN 1 ELSE 0 END, 0 FROM "purchase_order_number_seq"
UNION ALL
SELECT 'sales_order', 'KO-', last_value + CASE WHEN is_called THEN 1 ELSE 0 END, 0 FROM "sales_order_number_seq"
UNION ALL
SELECT 'manufacturing_order', 'PO-', last_value + CASE WHEN is_called THEN 1 ELSE 0 END, 0 FROM "manufacturing_order_number_seq";--> statement-breakpoint
DROP SEQUENCE "public"."manufacturing_order_number_seq";--> statement-breakpoint
DROP SEQUENCE "public"."purchase_order_number_seq";--> statement-breakpoint
DROP SEQUENCE "public"."sales_order_number_seq";