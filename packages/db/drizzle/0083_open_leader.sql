CREATE TYPE "public"."operation_time_unit" AS ENUM('minutes_per_unit', 'units_per_hour');--> statement-breakpoint
ALTER TABLE "mo_operations" ADD COLUMN "time_unit" "operation_time_unit" DEFAULT 'minutes_per_unit' NOT NULL;--> statement-breakpoint
ALTER TABLE "routing_operations" ADD COLUMN "time_unit" "operation_time_unit" DEFAULT 'minutes_per_unit' NOT NULL;