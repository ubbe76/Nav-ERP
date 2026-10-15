CREATE TYPE "public"."parcel_kind" AS ENUM('package', 'pallet', 'other');--> statement-breakpoint
CREATE TYPE "public"."shipment_status" AS ENUM('draft', 'booked', 'delivered', 'cancelled');--> statement-breakpoint
CREATE TABLE "freight_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(20) NOT NULL,
	"carrier_code" varchar(50) NOT NULL,
	"carrier_name" varchar(100) NOT NULL,
	"product_name" varchar(150) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "freight_products_provider_carrier_product_unique" UNIQUE("provider","carrier_code","product_name")
);
--> statement-breakpoint
CREATE TABLE "pickup_times" (
	"weekday" smallint PRIMARY KEY NOT NULL,
	"time_from" time NOT NULL,
	"time_to" time NOT NULL,
	CONSTRAINT "pickup_times_weekday_range" CHECK ("pickup_times"."weekday" BETWEEN 1 AND 7),
	CONSTRAINT "pickup_times_order" CHECK ("pickup_times"."time_from" < "pickup_times"."time_to")
);
--> statement-breakpoint
CREATE TABLE "shipment_deliveries" (
	"shipment_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "shipment_deliveries_shipment_id_delivery_id_pk" PRIMARY KEY("shipment_id","delivery_id")
);
--> statement-breakpoint
CREATE TABLE "shipment_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"filename" varchar(255) NOT NULL,
	"content_type" varchar(100) NOT NULL,
	"size_bytes" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipment_files_shipment_kind_unique" UNIQUE("shipment_id","kind")
);
--> statement-breakpoint
CREATE TABLE "shipment_parcels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"parcel_kind" "parcel_kind" NOT NULL,
	"length_cm" numeric(8, 1) DEFAULT '0' NOT NULL,
	"width_cm" numeric(8, 1) DEFAULT '0' NOT NULL,
	"height_cm" numeric(8, 1) DEFAULT '0' NOT NULL,
	"weight_kg" numeric(10, 2) NOT NULL,
	"quantity" integer NOT NULL,
	"stackable" boolean DEFAULT false NOT NULL,
	"loading_meters" numeric(8, 2),
	"description" varchar(100),
	CONSTRAINT "shipment_parcels_quantity_positive" CHECK ("shipment_parcels"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_number" varchar(20) NOT NULL,
	"status" "shipment_status" DEFAULT 'draft' NOT NULL,
	"customer_id" uuid NOT NULL,
	"recipient_name" varchar(255) NOT NULL,
	"recipient_address_line1" varchar(255),
	"recipient_address_line2" varchar(255),
	"recipient_postal_code" varchar(20),
	"recipient_city" varchar(100),
	"recipient_country" varchar(2) DEFAULT 'SE' NOT NULL,
	"recipient_contact_name" varchar(255),
	"recipient_phone" varchar(50),
	"recipient_email" varchar(255),
	"recipient_private_person" boolean DEFAULT false NOT NULL,
	"sender_name" varchar(255),
	"sender_address_line1" varchar(255),
	"sender_postal_code" varchar(20),
	"sender_city" varchar(100),
	"sender_country" varchar(2) DEFAULT 'SE' NOT NULL,
	"sender_contact_name" varchar(255),
	"sender_phone" varchar(50),
	"sender_email" varchar(255),
	"sender_reference" varchar(100),
	"sender_reference_manual" boolean DEFAULT false NOT NULL,
	"receiver_reference" varchar(100),
	"pickup_date" date NOT NULL,
	"pickup_from" time NOT NULL,
	"pickup_to" time NOT NULL,
	"provider_shipment_id" varchar(100),
	"last_rates" jsonb,
	"rates_fetched_at" timestamp with time zone,
	"freight_product_id" uuid,
	"carrier_price" numeric(14, 2),
	"carrier_currency" varchar(3),
	"customer_price" numeric(14, 2),
	"customer_price_manual" boolean DEFAULT false NOT NULL,
	"tracking_number" varchar(100),
	"tracking_url" text,
	"document_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"booking_started_at" timestamp with time zone,
	"booked_at" timestamp with time zone,
	"booked_by" uuid,
	"cancelled_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipments_shipment_number_unique" UNIQUE("shipment_number")
);
--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "parcel_kind" "parcel_kind";--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "stackable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "pallet_spaces" numeric(8, 2);--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "loading_meters" numeric(8, 2);--> statement-breakpoint
ALTER TABLE "package_types" ADD COLUMN "parcel_kind" "parcel_kind" DEFAULT 'package' NOT NULL;--> statement-breakpoint
ALTER TABLE "package_types" ADD COLUMN "length_mm" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "package_types" ADD COLUMN "width_mm" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "package_types" ADD COLUMN "height_mm" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "package_types" ADD COLUMN "tare_weight" numeric(12, 3);--> statement-breakpoint
ALTER TABLE "package_types" ADD COLUMN "stackable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "package_types" ADD COLUMN "loading_meters" numeric(8, 2);--> statement-breakpoint
ALTER TABLE "shipment_deliveries" ADD CONSTRAINT "shipment_deliveries_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_deliveries" ADD CONSTRAINT "shipment_deliveries_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_files" ADD CONSTRAINT "shipment_files_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_parcels" ADD CONSTRAINT "shipment_parcels_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_freight_product_id_freight_products_id_fk" FOREIGN KEY ("freight_product_id") REFERENCES "public"."freight_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_booked_by_users_id_fk" FOREIGN KEY ("booked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_deliveries_active_delivery_unique" ON "shipment_deliveries" USING btree ("delivery_id") WHERE "shipment_deliveries"."active";--> statement-breakpoint
CREATE INDEX "idx_shipment_parcels_shipment" ON "shipment_parcels" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "idx_shipments_customer" ON "shipments" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_shipments_status" ON "shipments" USING btree ("status");
--> statement-breakpoint
-- Försändelsenummer FR-1001, … (same seeding pattern as the FS- series in 0065).
INSERT INTO "number_series" ("key","prefix","next_number","digits") VALUES ('shipment','FR-',1001,0) ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
-- The standard pallet kollityper get their footprint and tare weight; height
-- varies with the load and is left to the user. Only untouched rows.
UPDATE "package_types" SET "parcel_kind" = 'pallet', "length_mm" = 1200, "width_mm" = 800, "tare_weight" = 25 WHERE "code" = 'EUR' AND "length_mm" IS NULL;
--> statement-breakpoint
UPDATE "package_types" SET "parcel_kind" = 'pallet', "length_mm" = 800, "width_mm" = 600, "tare_weight" = 10 WHERE "code" = 'HALV' AND "length_mm" IS NULL;
--> statement-breakpoint
UPDATE "package_types" SET "parcel_kind" = 'pallet', "length_mm" = 600, "width_mm" = 400, "tare_weight" = 5 WHERE "code" = 'KVART' AND "length_mm" IS NULL;
