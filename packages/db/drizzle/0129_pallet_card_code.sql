CREATE TYPE "public"."pallet_card_code" AS ENUM('none', 'barcode', 'qr');--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "pallet_card_code" "pallet_card_code";