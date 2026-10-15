CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sales_order_id" uuid NOT NULL,
	"delivery_number" varchar(20) NOT NULL,
	"delivered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "deliveries_delivery_number_unique" UNIQUE("delivery_number")
);
--> statement-breakpoint
CREATE TABLE "delivery_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"sales_order_row_id" uuid NOT NULL,
	"quantity" numeric(14, 4) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_rows" ADD CONSTRAINT "delivery_rows_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_rows" ADD CONSTRAINT "delivery_rows_sales_order_row_id_sales_order_rows_id_fk" FOREIGN KEY ("sales_order_row_id") REFERENCES "public"."sales_order_rows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_deliveries_order" ON "deliveries" USING btree ("sales_order_id");--> statement-breakpoint
CREATE INDEX "idx_delivery_rows_delivery" ON "delivery_rows" USING btree ("delivery_id");--> statement-breakpoint
INSERT INTO "number_series" ("key","prefix","next_number","digits") VALUES ('delivery','FS-',1001,0) ON CONFLICT ("key") DO NOTHING;
