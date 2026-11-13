-- Spårbarhet etapp 2 (#8), steg 4: serienummer som skapas VID UTLEVERANS
-- (beslut 16–18). Lagret för en sådan artikel är ospårat, så numret står
-- inte på lagerraden: delivery_row_serials kopplar leveransraden till de
-- serienummer (stock_batches, kind serial, origin delivery) den gav sina
-- styck. Ett nummer ges en gång (primärnyckeln) och raderas aldrig: numren
-- på en ångrad leveransrad är brända — härlett ur delivery_rows.undone_at.
-- ADD VALUE: det nya värdet används inte i den här migrationen (varje
-- migration är sin egen transaktion — fresh-install.test.ts vaktar).
ALTER TYPE "public"."stock_batch_origin" ADD VALUE 'delivery';--> statement-breakpoint
CREATE TABLE "delivery_row_serials" (
	"batch_id" uuid PRIMARY KEY NOT NULL,
	"delivery_row_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_row_serials" ADD CONSTRAINT "delivery_row_serials_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."stock_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_row_serials" ADD CONSTRAINT "delivery_row_serials_delivery_row_id_delivery_rows_id_fk" FOREIGN KEY ("delivery_row_id") REFERENCES "public"."delivery_rows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_delivery_row_serials_row" ON "delivery_row_serials" USING btree ("delivery_row_id");