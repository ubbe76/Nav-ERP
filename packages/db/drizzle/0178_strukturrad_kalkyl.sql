-- Kalkyl on a structure row (Monitor's "End. kal." — endast kalkyl): the row
-- is priced in the förkalkyl like any other but is never snapshotted into a
-- manufacturing order (no withdrawal, no shortage, no efterkalkyl) and creates
-- no dependent demand in the behovsberäkning — the material twin of
-- routing_operations.costing_only (migration 0073).
ALTER TABLE "bom_components" ADD COLUMN "costing_only" boolean DEFAULT false NOT NULL;
