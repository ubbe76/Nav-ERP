ALTER TABLE "articles" ADD COLUMN "barcode" varchar(14);--> statement-breakpoint
ALTER TABLE "stock_locations" ADD COLUMN "label_number" integer NOT NULL GENERATED ALWAYS AS IDENTITY (sequence name "stock_locations_label_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1);--> statement-breakpoint
CREATE UNIQUE INDEX "articles_barcode_unique" ON "articles" USING btree ("barcode") WHERE "articles"."barcode" is not null;--> statement-breakpoint
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_label_number_unique" UNIQUE("label_number");--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_barcode_format" CHECK ("articles"."barcode" ~ '^([0-9]{8}|[0-9]{12,14})$');