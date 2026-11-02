-- Samma artikel/material flera gånger i en struktur. The unique
-- (parent_article_id, component_article_id) goes: a structure may carry the
-- same component on several rows (another Pos., another operation). The
-- article card and the BOM import warn about it instead of refusing it, and
-- explodeBom already sums such rows per (component, operation), so a released
-- MO still gets one material line each.
ALTER TABLE "bom_components" DROP CONSTRAINT "bom_components_parent_article_id_component_article_id_unique";
