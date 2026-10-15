CREATE TYPE "public"."mo_report_kind" AS ENUM('operation', 'completion', 'material');--> statement-breakpoint
CREATE TYPE "public"."mo_report_source" AS ENUM('terminal', 'card', 'purchase_receipt', 'migration');--> statement-breakpoint
CREATE TABLE "mo_report_materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mo_report_id" uuid NOT NULL,
	"material_consumption_id" uuid NOT NULL,
	"quantity" numeric(14, 4) NOT NULL,
	"location_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mo_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"manufacturing_order_id" uuid NOT NULL,
	"mo_operation_id" uuid,
	"kind" "mo_report_kind" NOT NULL,
	"source" "mo_report_source" NOT NULL,
	"quantity_ok" numeric(14, 4) DEFAULT '0' NOT NULL,
	"quantity_scrapped" numeric(14, 4) DEFAULT '0' NOT NULL,
	"marked_done" boolean DEFAULT false NOT NULL,
	"quantity_received" numeric(14, 4) DEFAULT '0' NOT NULL,
	"receipt_location_id" uuid,
	"completed_order" boolean DEFAULT false NOT NULL,
	"time_report_id" uuid,
	"employee_id" uuid,
	"purchase_order_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone,
	"undone_by" uuid
);
--> statement-breakpoint
ALTER TABLE "mo_operation_scrap" ADD COLUMN "mo_report_id" uuid;--> statement-breakpoint
ALTER TABLE "mo_report_materials" ADD CONSTRAINT "mo_report_materials_mo_report_id_mo_reports_id_fk" FOREIGN KEY ("mo_report_id") REFERENCES "public"."mo_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mo_report_materials" ADD CONSTRAINT "mo_report_materials_material_consumption_id_mo_material_consumptions_id_fk" FOREIGN KEY ("material_consumption_id") REFERENCES "public"."mo_material_consumptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mo_report_materials" ADD CONSTRAINT "mo_report_materials_location_id_stock_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."stock_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mo_reports" ADD CONSTRAINT "mo_reports_manufacturing_order_id_manufacturing_orders_id_fk" FOREIGN KEY ("manufacturing_order_id") REFERENCES "public"."manufacturing_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mo_reports" ADD CONSTRAINT "mo_reports_mo_operation_id_mo_operations_id_fk" FOREIGN KEY ("mo_operation_id") REFERENCES "public"."mo_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mo_reports" ADD CONSTRAINT "mo_reports_receipt_location_id_stock_locations_id_fk" FOREIGN KEY ("receipt_location_id") REFERENCES "public"."stock_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mo_reports" ADD CONSTRAINT "mo_reports_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mo_reports" ADD CONSTRAINT "mo_reports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mo_reports" ADD CONSTRAINT "mo_reports_undone_by_users_id_fk" FOREIGN KEY ("undone_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mo_reports_by_order" ON "mo_reports" USING btree ("manufacturing_order_id","created_at");--> statement-breakpoint
ALTER TABLE "mo_operation_scrap" ADD CONSTRAINT "mo_operation_scrap_mo_report_id_mo_reports_id_fk" FOREIGN KEY ("mo_report_id") REFERENCES "public"."mo_reports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mo_reports" ADD CONSTRAINT "mo_reports_time_report_id_time_reports_id_fk" FOREIGN KEY ("time_report_id") REFERENCES "public"."time_reports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mo_reports" ADD CONSTRAINT "mo_reports_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Backfill: what open and done orders have reported so far becomes migrated
-- report rows, so it can be undone too. Quantities were only kept as totals
-- per operation, so each operation gets ONE row with its totals; the last
-- operation's row carries the receipt it made (delinleverans), a done order
-- gets a Slutför order row for the rest (or for closing short), and the
-- material consumed is attached to the row that drew it. Locations are the
-- latest of the order's own stock movements for the article.
INSERT INTO "mo_reports" ("manufacturing_order_id", "mo_operation_id", "kind", "source", "quantity_ok", "quantity_scrapped",
  "marked_done", "quantity_received", "receipt_location_id", "created_at")
SELECT o."manufacturing_order_id", o."id", 'operation', 'migration', coalesce(o."quantity_completed", 0), o."quantity_scrapped",
  o."status" = 'done', r.received, CASE WHEN r.received > 0 THEN rl."location_id" END,
  coalesce((SELECT max(tr."created_at") FROM "time_reports" tr WHERE tr."mo_operation_id" = o."id"), mo."updated_at")
FROM "mo_operations" o
JOIN "manufacturing_orders" mo ON mo."id" = o."manufacturing_order_id"
JOIN LATERAL (
  SELECT CASE WHEN o."sequence_no" = (SELECT max(x."sequence_no") FROM "mo_operations" x WHERE x."manufacturing_order_id" = mo."id")
    THEN least(coalesce(o."quantity_completed", 0), mo."quantity_received") ELSE 0 END AS received
) r ON true
LEFT JOIN LATERAL (
  SELECT st."location_id" FROM "stock_transactions" st
  WHERE st."reference_id" = mo."id" AND st."transaction_type" = 'mo_receipt' AND st."quantity_delta" > 0
  ORDER BY st."created_at" DESC LIMIT 1
) rl ON true
WHERE mo."status" IN ('released', 'in_progress', 'done')
  AND (coalesce(o."quantity_completed", 0) > 0 OR o."quantity_scrapped" > 0);--> statement-breakpoint
INSERT INTO "mo_reports" ("manufacturing_order_id", "kind", "source", "quantity_received", "receipt_location_id", "completed_order", "created_at")
SELECT mo."id", 'completion', 'migration', mo."quantity_received" - coalesce(op.received, 0),
  CASE WHEN mo."quantity_received" - coalesce(op.received, 0) > 0 THEN rl."location_id" END, true, mo."updated_at"
FROM "manufacturing_orders" mo
LEFT JOIN LATERAL (
  SELECT sum(r."quantity_received") AS received FROM "mo_reports" r WHERE r."manufacturing_order_id" = mo."id"
) op ON true
LEFT JOIN LATERAL (
  SELECT st."location_id" FROM "stock_transactions" st
  WHERE st."reference_id" = mo."id" AND st."transaction_type" = 'mo_receipt' AND st."quantity_delta" > 0
  ORDER BY st."created_at" DESC LIMIT 1
) rl ON true
WHERE mo."status" = 'done'
  AND (mo."quantity_received" - coalesce(op.received, 0) > 0 OR mo."quantity_received" < mo."quantity");--> statement-breakpoint
CREATE TEMP TABLE "_mo_report_backfill" AS
SELECT m."id" AS consumption_id, m."manufacturing_order_id" AS order_id, m."quantity_consumed" AS quantity,
  coalesce(
    (SELECT st."location_id" FROM "stock_transactions" st
     WHERE st."reference_id" = m."manufacturing_order_id" AND st."article_id" = m."component_article_id"
       AND st."transaction_type" = 'mo_consumption'
     ORDER BY st."created_at" DESC LIMIT 1),
    a."default_location_id"
  ) AS location_id,
  coalesce(
    -- linked material: the operation's row
    (SELECT r."id" FROM "mo_reports" r WHERE r."mo_operation_id" = m."mo_operation_id" AND r."source" = 'migration'),
    -- unlinked material follows the finished goods: Slutför order, else the
    -- last operation's receipt
    CASE WHEN m."mo_operation_id" IS NULL THEN coalesce(
      (SELECT r."id" FROM "mo_reports" r WHERE r."manufacturing_order_id" = m."manufacturing_order_id"
         AND r."kind" = 'completion' AND r."source" = 'migration'),
      (SELECT r."id" FROM "mo_reports" r WHERE r."manufacturing_order_id" = m."manufacturing_order_id"
         AND r."kind" = 'operation' AND r."source" = 'migration' AND r."quantity_received" > 0 LIMIT 1)
    ) END
  ) AS report_id
FROM "mo_material_consumptions" m
JOIN "manufacturing_orders" mo ON mo."id" = m."manufacturing_order_id"
JOIN "articles" a ON a."id" = m."component_article_id"
WHERE mo."status" IN ('released', 'in_progress', 'done') AND m."quantity_consumed" > 0;--> statement-breakpoint
-- Material drawn without any report (by hand): one material row per order.
INSERT INTO "mo_reports" ("manufacturing_order_id", "kind", "source", "created_at")
SELECT DISTINCT b.order_id, 'material'::"mo_report_kind", 'migration'::"mo_report_source", mo."updated_at"
FROM "_mo_report_backfill" b JOIN "manufacturing_orders" mo ON mo."id" = b.order_id
WHERE b.report_id IS NULL;--> statement-breakpoint
UPDATE "_mo_report_backfill" b SET report_id = r."id"
FROM "mo_reports" r
WHERE b.report_id IS NULL AND r."manufacturing_order_id" = b.order_id AND r."kind" = 'material' AND r."source" = 'migration';--> statement-breakpoint
INSERT INTO "mo_report_materials" ("mo_report_id", "material_consumption_id", "quantity", "location_id")
SELECT report_id, consumption_id, quantity, location_id FROM "_mo_report_backfill" WHERE location_id IS NOT NULL;--> statement-breakpoint
DROP TABLE "_mo_report_backfill";--> statement-breakpoint
UPDATE "mo_operation_scrap" s SET "mo_report_id" = r."id"
FROM "mo_reports" r
WHERE r."mo_operation_id" = s."mo_operation_id" AND r."source" = 'migration';
