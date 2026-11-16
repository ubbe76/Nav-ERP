-- Flera lager (stock/service/warehouse-mode.ts) is off by default, which
-- hides the warehouse everywhere. An installation that already has more than
-- one warehouse in use gets it switched on, so no warehouse disappears from
-- sight on the update. In use = active or holding an active location; the
-- reserve warehouse "***" is not counted. ON CONFLICT: a value set before
-- this migration ran stays.
INSERT INTO system_settings (key, value)
SELECT 'multiple_warehouses', 'true'
WHERE (
  SELECT count(*)
  FROM warehouses w
  WHERE w.name <> '***'
    AND (w.active OR EXISTS (SELECT 1 FROM stock_locations l WHERE l.warehouse_id = w.id AND l.active))
) > 1
ON CONFLICT (key) DO NOTHING;
