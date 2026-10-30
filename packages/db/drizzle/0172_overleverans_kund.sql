CREATE TYPE "public"."customer_over_delivery" AS ENUM('allow', 'deny');--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "over_delivery" "customer_over_delivery";--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "over_delivery_percent" numeric(7, 2);--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_over_delivery_percent" CHECK ("customers"."over_delivery_percent" IS NULL OR ("customers"."over_delivery" = 'allow' AND "customers"."over_delivery_percent" >= 0));