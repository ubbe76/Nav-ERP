CREATE TABLE "work_center_rate_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_center_id" uuid NOT NULL,
	"hourly_rate" numeric(10, 2) NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_center_rate_history" ADD CONSTRAINT "work_center_rate_history_work_center_id_work_centers_id_fk" FOREIGN KEY ("work_center_id") REFERENCES "public"."work_centers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_work_center_rate_history_from" ON "work_center_rate_history" USING btree ("work_center_id","valid_from");--> statement-breakpoint
-- Timkostnad per datum (#14 etapp 4, spec
-- private/superpowers/specs/2026-11-06-avvikelseanalys-efterkalkyl-design.md,
-- fråga 2). The efterkalkyl and Produkter i arbete price each work day's
-- hours at that day's hourly rate, and the avvikelseanalys's base at the
-- rate as of T₀. The history is written by this trigger, never by the
-- application: work_centers.hourly_rate has several writers (the card, the
-- list's inline edit, the resource import, the demo data), and a trigger
-- cannot be forgotten by the next one — the pattern of 0169's
-- försäljningspris. TRUNCATE (the test suite's cleanup) fires no row
-- triggers.
--
-- One row per transaction that changes the value: a second change in the
-- same transaction replaces the first (valid_from = now() is the
-- transaction's start), and a value equal to the latest recorded one writes
-- nothing. hourly_rate is NOT NULL, so every resource has a row from its
-- INSERT on. The TO percentage gets no history: it is outside TVK and the
-- analysis, and today's applies on both sides, like MO/LO.
CREATE OR REPLACE FUNCTION nav_work_center_rate_history() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_last numeric;
BEGIN
  DELETE FROM work_center_rate_history WHERE work_center_id = NEW.id AND valid_from = now();
  SELECT hourly_rate INTO v_last FROM work_center_rate_history
    WHERE work_center_id = NEW.id ORDER BY valid_from DESC LIMIT 1;
  IF FOUND AND v_last = NEW.hourly_rate THEN
    RETURN NULL;
  END IF;
  INSERT INTO work_center_rate_history (work_center_id, hourly_rate) VALUES (NEW.id, NEW.hourly_rate);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER work_centers_rate_history
  AFTER INSERT OR UPDATE OF hourly_rate ON work_centers
  FOR EACH ROW EXECUTE FUNCTION nav_work_center_rate_history();
--> statement-breakpoint
-- Backfill: history starts honestly at this migration, like 0169. Before a
-- resource's first row its first row applies (price-at.ts), so every hour
-- reported before today keeps the rate it was priced at until now.
INSERT INTO work_center_rate_history (work_center_id, hourly_rate)
SELECT id, hourly_rate FROM work_centers;
