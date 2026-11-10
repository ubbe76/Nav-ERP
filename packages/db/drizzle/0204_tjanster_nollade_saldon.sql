-- Tjänster lagerförs inte (stocked-article.ts, 2026-11-10): no writer books
-- a stock movement for a service any more, but a service could have a
-- balance from before — a receipt into stock, or a TO draw that went
-- negative. The user's decision: zero them. Append-only, like every stock
-- change: one inventory_adjustment per (service, place) with a non-zero
-- balance, of minus that balance, dated now and without a unit_cost (it is
-- no valuation event — a service has no value in stock). Nothing earlier
-- is touched, so the log and every valuation per an earlier date stay as
-- they were.
--
-- The trigger stock_transactions_revive_location (0202) revives an inactive
-- place an inflow lands on; a place that was inactive before and is empty
-- after (every article netting to zero) is put back to inactive.
CREATE TEMP TABLE service_balances ON COMMIT DROP AS
SELECT st.article_id, st.location_id, sum(st.quantity_delta) AS quantity
FROM stock_transactions st
JOIN articles a ON a.id = st.article_id
WHERE a.type = 'service'
GROUP BY st.article_id, st.location_id
HAVING sum(st.quantity_delta) <> 0;
--> statement-breakpoint
CREATE TEMP TABLE service_places_inactive ON COMMIT DROP AS
SELECT DISTINCT b.location_id
FROM service_balances b
JOIN stock_locations l ON l.id = b.location_id
WHERE NOT l.active;
--> statement-breakpoint
INSERT INTO stock_transactions (article_id, location_id, quantity_delta, transaction_type, note)
SELECT article_id, location_id, -quantity, 'inventory_adjustment', 'Tjänster lagerförs inte — saldot nollat vid uppdateringen (0204)'
FROM service_balances;
--> statement-breakpoint
UPDATE stock_locations l
SET active = false
WHERE l.id IN (SELECT location_id FROM service_places_inactive)
  AND NOT EXISTS (
    SELECT 1
    FROM stock_transactions st
    WHERE st.location_id = l.id
    GROUP BY st.article_id
    HAVING sum(st.quantity_delta) <> 0
  );
