CREATE TYPE "public"."delivery_day_mode" AS ENUM('arrival', 'dispatch');--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "delivery_weekdays" smallint[] DEFAULT '{}'::smallint[] NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "delivery_day_mode" "delivery_day_mode";--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "transit_days" smallint;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "delivery_weekdays" smallint[] DEFAULT '{}'::smallint[] NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "delivery_day_mode" "delivery_day_mode";--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "transit_days" smallint;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_delivery_weekdays" CHECK ("suppliers"."delivery_weekdays" <@ '{1,2,3,4,5,6,7}'::smallint[]);--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_transit_days" CHECK ("suppliers"."transit_days" between 0 and 60);--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_delivery_weekdays" CHECK ("customers"."delivery_weekdays" <@ '{1,2,3,4,5,6,7}'::smallint[]);--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_transit_days" CHECK ("customers"."transit_days" between 0 and 60);