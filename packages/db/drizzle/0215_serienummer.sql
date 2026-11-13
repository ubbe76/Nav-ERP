-- Spårbarhet etapp 2 (#8), steg 3: serienummer. Ett serienummer är en rad i
-- stock_batches med kind = 'serial' — samma batch_id på lagerloggen som en
-- batch, saldo 0 eller 1 (vakten nedan). Serienummerserierna är
-- number_series-rader med for_serials (den gemensamma "serial" seedas här),
-- artikeln kan peka på en egen (serial_series_key, null = den gemensamma),
-- och mo_report_serials säger vilka nummer en TO-rapport lade in, så Ångra
-- tar tillbaka exakt dem. Bara NYA typer (ingen ALTER TYPE … ADD VALUE).
CREATE TYPE "public"."stock_batch_kind" AS ENUM('batch', 'serial');--> statement-breakpoint
CREATE TABLE "mo_report_serials" (
	"mo_report_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	CONSTRAINT "mo_report_serials_mo_report_id_batch_id_pk" PRIMARY KEY("mo_report_id","batch_id")
);
--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "serial_series_key" varchar(50);--> statement-breakpoint
ALTER TABLE "stock_batches" ADD COLUMN "kind" "stock_batch_kind" DEFAULT 'batch' NOT NULL;--> statement-breakpoint
ALTER TABLE "number_series" ADD COLUMN "for_serials" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mo_report_serials" ADD CONSTRAINT "mo_report_serials_mo_report_id_mo_reports_id_fk" FOREIGN KEY ("mo_report_id") REFERENCES "public"."mo_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mo_report_serials" ADD CONSTRAINT "mo_report_serials_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."stock_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_mo_report_serials_batch" ON "mo_report_serials" USING btree ("batch_id");--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_serial_series_key_number_series_key_fk" FOREIGN KEY ("serial_series_key") REFERENCES "public"."number_series"("key") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_one_register" CHECK (NOT ("number_series"."for_articles" AND "number_series"."for_serials"));--> statement-breakpoint
-- Written by hand from here. The common serial number series: SN-000001 …
INSERT INTO "number_series" ("key", "prefix", "next_number", "digits", "name", "for_serials")
VALUES ('serial', 'SN-', 1, 6, NULL, true)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
-- The guard: a serial number's balance is 0 or 1 — in total and on the place
-- of the row — and it only moves one at a time. The application's own rule
-- answers first with a readable error (serial-numbers.ts); this catches a
-- writer that forgot it, like the append-only trigger (0208). Only rows WITH
-- a batch fire it (WHEN), so untracked articles pay nothing; a batch row
-- pays one primary key read. For a serial number the row is locked FOR NO
-- KEY UPDATE (it does not clash with the FK's KEY SHARE; the writers have
-- usually taken it already, sorted on id — lockSerials) and the two sums ride
-- idx_stock_transactions_batch. AFTER ROW triggers run when the statement
-- is done, so both legs of a move written in one INSERT are seen together.
-- SQLSTATE NV003 → 409 serial-balance-violated. The fast truncate and
-- editStockLog run under session_replication_role = replica and skip it.
CREATE OR REPLACE FUNCTION nav_stock_transactions_serial_unit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  batch_kind stock_batch_kind;
  serial_number text;
  total numeric;
  on_place numeric;
BEGIN
  SELECT kind INTO batch_kind FROM stock_batches WHERE id = NEW.batch_id;
  IF batch_kind IS DISTINCT FROM 'serial' THEN
    RETURN NULL;
  END IF;
  SELECT batch_number INTO serial_number FROM stock_batches WHERE id = NEW.batch_id FOR NO KEY UPDATE;
  IF abs(NEW.quantity_delta) <> 1 THEN
    RAISE EXCEPTION 'Serienummer % kan bara bokas ett styck i taget (lagerrad %: %)', serial_number, NEW.id, NEW.quantity_delta
      USING ERRCODE = 'NV003';
  END IF;
  SELECT coalesce(sum(quantity_delta), 0),
         coalesce(sum(quantity_delta) FILTER (WHERE location_id = NEW.location_id), 0)
    INTO total, on_place
    FROM stock_transactions WHERE batch_id = NEW.batch_id;
  IF total NOT IN (0, 1) OR on_place NOT IN (0, 1) THEN
    RAISE EXCEPTION 'Serienummer % får ha saldo 0 eller 1 (totalt %, på lagerplatsen %)', serial_number, total, on_place
      USING ERRCODE = 'NV003';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stock_transactions_serial_unit AFTER INSERT ON "stock_transactions"
  FOR EACH ROW WHEN (NEW.batch_id IS NOT NULL) EXECUTE FUNCTION nav_stock_transactions_serial_unit();
