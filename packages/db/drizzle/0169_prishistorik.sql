CREATE TABLE "article_sales_price_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"price" numeric(14, 4),
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "article_supplier_price_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"supplier_id" uuid,
	"price" numeric(14, 4),
	"currency" varchar(3) NOT NULL,
	"price_breaks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_primary" boolean NOT NULL,
	"removed" boolean DEFAULT false NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cost_calculation_material_rows" ADD COLUMN "price_date" date;--> statement-breakpoint
ALTER TABLE "article_sales_price_history" ADD CONSTRAINT "article_sales_price_history_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_supplier_price_history" ADD CONSTRAINT "article_supplier_price_history_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_supplier_price_history" ADD CONSTRAINT "article_supplier_price_history_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_sales_price_history_article_from" ON "article_sales_price_history" USING btree ("article_id","valid_from");--> statement-breakpoint
CREATE INDEX "idx_article_supplier_price_history_article" ON "article_supplier_price_history" USING btree ("article_id","supplier_id","valid_from");--> statement-breakpoint
-- Prishistorik (spec 2026-10-29-prishistorik-och-efterkalkyl-design.md). The
-- histories are written by these triggers, never by the application: the
-- sales price and the supplier catalog have many writers (card, imports,
-- batch edit, copy, demo data, configurator variants …), and a trigger cannot
-- be forgotten by the next one. TRUNCATE (the test suite's cleanup) fires no
-- row triggers.
--
-- Försäljningspris: one row per transaction that changes the value. A second
-- change in the same transaction replaces the first (valid_from = now() is
-- the transaction's start, so ties would otherwise be ambiguous), and a value
-- equal to the latest recorded one writes nothing.
CREATE OR REPLACE FUNCTION nav_article_sales_price_history() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_last numeric;
BEGIN
  DELETE FROM article_sales_price_history WHERE article_id = NEW.id AND valid_from = now();
  SELECT price INTO v_last FROM article_sales_price_history
    WHERE article_id = NEW.id ORDER BY valid_from DESC LIMIT 1;
  IF FOUND THEN
    IF v_last IS NOT DISTINCT FROM NEW.sales_price THEN
      RETURN NULL;
    END IF;
  ELSIF NEW.sales_price IS NULL THEN
    RETURN NULL; -- no history and no price: nothing to record
  END IF;
  INSERT INTO article_sales_price_history (article_id, price) VALUES (NEW.id, NEW.sales_price);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER articles_sales_price_history
  AFTER INSERT OR UPDATE OF sales_price ON articles
  FOR EACH ROW EXECUTE FUNCTION nav_article_sales_price_history();
--> statement-breakpoint
-- Leverantörskatalogen: a snapshot of the catalog row (article, supplier) as
-- it stands at COMMIT — row and staffel together. Called from deferred
-- constraint triggers, because replacePriceBreaks rewrites the staffel AFTER
-- the row's own UPDATE in the same transaction (and a primary switch demotes
-- the other row too); a plain row trigger would record half a change. Every
-- event of the transaction calls this; the first writes the final state, the
-- rest find it identical and write nothing.
CREATE OR REPLACE FUNCTION nav_snapshot_article_supplier(p_article uuid, p_supplier uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_row article_suppliers%ROWTYPE;
  v_found boolean;
  v_breaks jsonb := '[]'::jsonb;
  v_last article_supplier_price_history%ROWTYPE;
  v_has_last boolean;
BEGIN
  -- The article was deleted in this transaction (the catalog cascades).
  IF NOT EXISTS (SELECT 1 FROM articles WHERE id = p_article) THEN
    RETURN;
  END IF;
  SELECT * INTO v_row FROM article_suppliers WHERE article_id = p_article AND supplier_id = p_supplier;
  v_found := FOUND;
  IF v_found THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('fromQuantity', from_quantity, 'price', price) ORDER BY from_quantity), '[]'::jsonb)
      INTO v_breaks FROM article_supplier_price_breaks WHERE article_supplier_id = v_row.id;
  END IF;
  SELECT * INTO v_last FROM article_supplier_price_history
    WHERE article_id = p_article AND supplier_id = p_supplier
    ORDER BY valid_from DESC LIMIT 1;
  v_has_last := FOUND;

  IF NOT v_found THEN
    -- Removed: record it once, and only for a row that has history.
    IF NOT v_has_last OR v_last.removed THEN
      RETURN;
    END IF;
    INSERT INTO article_supplier_price_history (article_id, supplier_id, price, currency, price_breaks, is_primary, removed)
    VALUES (p_article, CASE WHEN EXISTS (SELECT 1 FROM suppliers WHERE id = p_supplier) THEN p_supplier END,
            v_last.price, v_last.currency, v_last.price_breaks, false, true);
    RETURN;
  END IF;

  IF v_has_last AND NOT v_last.removed
     AND v_last.price IS NOT DISTINCT FROM v_row.price
     AND v_last.currency = v_row.currency
     AND v_last.price_breaks = v_breaks
     AND v_last.is_primary = v_row.is_primary THEN
    RETURN;
  END IF;
  INSERT INTO article_supplier_price_history (article_id, supplier_id, price, currency, price_breaks, is_primary)
  VALUES (p_article, p_supplier, v_row.price, v_row.currency, v_breaks, v_row.is_primary);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nav_article_suppliers_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM nav_snapshot_article_supplier(OLD.article_id, OLD.supplier_id);
  END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND (NEW.article_id <> OLD.article_id OR NEW.supplier_id <> OLD.supplier_id)) THEN
    PERFORM nav_snapshot_article_supplier(NEW.article_id, NEW.supplier_id);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER article_suppliers_history
  AFTER INSERT OR UPDATE OR DELETE ON article_suppliers
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION nav_article_suppliers_history();
--> statement-breakpoint
-- A staffel step changed: snapshot its catalog row. When the catalog row
-- itself was deleted (the steps cascade) the row's own trigger records it.
CREATE OR REPLACE FUNCTION nav_article_supplier_breaks_history() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_article uuid;
  v_supplier uuid;
BEGIN
  SELECT article_id, supplier_id INTO v_article, v_supplier FROM article_suppliers
    WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.article_supplier_id ELSE NEW.article_supplier_id END;
  IF FOUND THEN
    PERFORM nav_snapshot_article_supplier(v_article, v_supplier);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER article_supplier_price_breaks_history
  AFTER INSERT OR UPDATE OR DELETE ON article_supplier_price_breaks
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION nav_article_supplier_breaks_history();
--> statement-breakpoint
-- Backfill: history starts honestly at this migration, like D1.
INSERT INTO article_sales_price_history (article_id, price)
SELECT id, sales_price FROM articles WHERE sales_price IS NOT NULL;
--> statement-breakpoint
INSERT INTO article_supplier_price_history (article_id, supplier_id, price, currency, price_breaks, is_primary)
SELECT s.article_id, s.supplier_id, s.price, s.currency,
       coalesce((SELECT jsonb_agg(jsonb_build_object('fromQuantity', b.from_quantity, 'price', b.price) ORDER BY b.from_quantity)
                 FROM article_supplier_price_breaks b WHERE b.article_supplier_id = s.id), '[]'::jsonb),
       s.is_primary
FROM article_suppliers s;
--> statement-breakpoint
-- Efterkalkylens egen materialkälla: takes today's shared value; the
-- förkalkyl's Verklig kostnad becomes Standardpris, which is what it already
-- computed (with a warning).
INSERT INTO system_settings (key, value)
SELECT 'costing_post_material_source', value FROM system_settings WHERE key = 'costing_material_source'
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
UPDATE system_settings SET value = 'standard' WHERE key = 'costing_material_source' AND value = 'actual';
