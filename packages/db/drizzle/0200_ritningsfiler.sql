-- Ritningar, revisioner och filer i beredningen (spec
-- private/superpowers/specs/2026-11-09-ritningar-revisioner-filer-design.md).
-- article_files.drawing_revision_id: a drawing revision's file (at most one);
-- null = a loose file as before. manufacturing_orders.article_revision /
-- revisions_snapshot_at + mo_drawing_revisions: the revisions a TO is built
-- from, snapshotted at release. routing_operation_drawings: the drawings an
-- operation is worked from.
CREATE TABLE "mo_drawing_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"manufacturing_order_id" uuid NOT NULL,
	"drawing_id" uuid,
	"drawing_number" varchar(50) NOT NULL,
	"drawing_revision_id" uuid,
	"revision" varchar(20),
	CONSTRAINT "mo_drawing_revisions_order_drawing" UNIQUE("manufacturing_order_id","drawing_id")
);
--> statement-breakpoint
CREATE TABLE "routing_operation_drawings" (
	"routing_operation_id" uuid NOT NULL,
	"drawing_id" uuid NOT NULL,
	CONSTRAINT "routing_operation_drawings_routing_operation_id_drawing_id_pk" PRIMARY KEY("routing_operation_id","drawing_id")
);
--> statement-breakpoint
ALTER TABLE "article_files" ADD COLUMN "drawing_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "manufacturing_orders" ADD COLUMN "article_revision" varchar(20);--> statement-breakpoint
ALTER TABLE "manufacturing_orders" ADD COLUMN "revisions_snapshot_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mo_drawing_revisions" ADD CONSTRAINT "mo_drawing_revisions_manufacturing_order_id_manufacturing_orders_id_fk" FOREIGN KEY ("manufacturing_order_id") REFERENCES "public"."manufacturing_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mo_drawing_revisions" ADD CONSTRAINT "mo_drawing_revisions_drawing_id_article_drawings_id_fk" FOREIGN KEY ("drawing_id") REFERENCES "public"."article_drawings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mo_drawing_revisions" ADD CONSTRAINT "mo_drawing_revisions_drawing_revision_id_article_drawing_revisions_id_fk" FOREIGN KEY ("drawing_revision_id") REFERENCES "public"."article_drawing_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_operation_drawings" ADD CONSTRAINT "routing_operation_drawings_routing_operation_id_routing_operations_id_fk" FOREIGN KEY ("routing_operation_id") REFERENCES "public"."routing_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_operation_drawings" ADD CONSTRAINT "routing_operation_drawings_drawing_id_article_drawings_id_fk" FOREIGN KEY ("drawing_id") REFERENCES "public"."article_drawings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_mo_drawing_revisions_order" ON "mo_drawing_revisions" USING btree ("manufacturing_order_id");--> statement-breakpoint
CREATE INDEX "idx_routing_operation_drawings_drawing" ON "routing_operation_drawings" USING btree ("drawing_id");--> statement-breakpoint
ALTER TABLE "article_files" ADD CONSTRAINT "article_files_drawing_revision_id_article_drawing_revisions_id_fk" FOREIGN KEY ("drawing_revision_id") REFERENCES "public"."article_drawing_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "article_files_one_per_drawing_revision" ON "article_files" USING btree ("drawing_revision_id");
--> statement-breakpoint
-- The open orders are built from today's revisions: they get the snapshot
-- now. Done, closed and cancelled orders keep none (read as the current).
UPDATE "manufacturing_orders" mo SET
	"article_revision" = (
		SELECT ar."revision" FROM "article_revisions" ar WHERE ar."article_id" = mo."article_id" AND ar."is_active"
	),
	"revisions_snapshot_at" = now()
WHERE mo."status" IN ('released', 'in_progress');--> statement-breakpoint
INSERT INTO "mo_drawing_revisions" ("manufacturing_order_id", "drawing_id", "drawing_number", "drawing_revision_id", "revision")
SELECT mo."id", d."id", d."drawing_number", r."id", r."revision"
FROM "manufacturing_orders" mo
JOIN "article_drawings" d ON d."article_id" = mo."article_id"
LEFT JOIN "article_drawing_revisions" r ON r."drawing_id" = d."id" AND r."is_active"
WHERE mo."status" IN ('released', 'in_progress');
