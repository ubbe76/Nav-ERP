-- Alternativa resurser, etapp 1: beredningen och tillverkningsordern (#15,
-- spec private/superpowers/specs/2026-11-06-alternativa-resurser-design.md).
-- routing_operation_alternatives: an own operation's other resources in the
-- beredning, rank 1..5 (CHECK), times null = som ordinarie (read at every
-- use). The service refuses them on lego and Kalkyl operations and refuses a
-- legoresurs or the ordinarie as an alternative. mo_operation_resources: the
-- TO operation's possible resources snapshotted at release, rank 0 = the
-- ordinarie, times resolved; rows only for operations with alternatives.
-- mo_operations.resource_locked = "Vald för hand". No backfill: no
-- alternatives exist yet, and an operation without rows behaves as before.
CREATE TABLE "mo_operation_resources" (
	"mo_operation_id" uuid NOT NULL,
	"work_center_id" uuid NOT NULL,
	"rank" smallint NOT NULL,
	"setup_time" numeric(10, 2) NOT NULL,
	"run_time_per_unit" numeric(10, 4) NOT NULL,
	CONSTRAINT "mo_operation_resources_mo_operation_id_work_center_id_pk" PRIMARY KEY("mo_operation_id","work_center_id"),
	CONSTRAINT "mo_operation_resources_operation_rank" UNIQUE("mo_operation_id","rank"),
	CONSTRAINT "mo_operation_resources_rank_range" CHECK ("mo_operation_resources"."rank" BETWEEN 0 AND 5),
	CONSTRAINT "mo_operation_resources_times" CHECK ("mo_operation_resources"."setup_time" >= 0 and "mo_operation_resources"."run_time_per_unit" >= 0)
);
--> statement-breakpoint
CREATE TABLE "routing_operation_alternatives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"routing_operation_id" uuid NOT NULL,
	"work_center_id" uuid NOT NULL,
	"rank" smallint NOT NULL,
	"setup_time" numeric(10, 2),
	"run_time_per_unit" numeric(10, 4),
	CONSTRAINT "routing_operation_alternatives_operation_work_center" UNIQUE("routing_operation_id","work_center_id"),
	CONSTRAINT "routing_operation_alternatives_operation_rank" UNIQUE("routing_operation_id","rank"),
	CONSTRAINT "routing_operation_alternatives_rank_range" CHECK ("routing_operation_alternatives"."rank" BETWEEN 1 AND 5),
	CONSTRAINT "routing_operation_alternatives_times" CHECK (("routing_operation_alternatives"."setup_time" is null or "routing_operation_alternatives"."setup_time" >= 0) and ("routing_operation_alternatives"."run_time_per_unit" is null or "routing_operation_alternatives"."run_time_per_unit" >= 0))
);
--> statement-breakpoint
ALTER TABLE "mo_operations" ADD COLUMN "resource_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mo_operation_resources" ADD CONSTRAINT "mo_operation_resources_mo_operation_id_mo_operations_id_fk" FOREIGN KEY ("mo_operation_id") REFERENCES "public"."mo_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mo_operation_resources" ADD CONSTRAINT "mo_operation_resources_work_center_id_work_centers_id_fk" FOREIGN KEY ("work_center_id") REFERENCES "public"."work_centers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_operation_alternatives" ADD CONSTRAINT "routing_operation_alternatives_routing_operation_id_routing_operations_id_fk" FOREIGN KEY ("routing_operation_id") REFERENCES "public"."routing_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_operation_alternatives" ADD CONSTRAINT "routing_operation_alternatives_work_center_id_work_centers_id_fk" FOREIGN KEY ("work_center_id") REFERENCES "public"."work_centers"("id") ON DELETE restrict ON UPDATE no action;