-- When an inköpsorder was confirmed (Bekräfta). With Skickad (0235) an order
-- can be received without being confirmed, so Ångra inleverans must know
-- which status to go back to once nothing is received any more: Bekräftad
-- when the order was confirmed, otherwise Skickad.
ALTER TABLE "purchase_orders" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
-- Every order past Utkast was confirmed before 0235 (Bekräfta, or a mail,
-- which then made it Bekräftad): the audit row's time when there is one,
-- otherwise the order's last change. Avbruten stays null (it is never
-- received again).
UPDATE "purchase_orders" po
SET "confirmed_at" = coalesce(
  (SELECT min(a."created_at") FROM "audit_log" a
   WHERE a."entity_type" = 'purchase_order' AND a."entity_id" = po."order_number" AND a."action" = 'confirmed'),
  po."updated_at",
  po."created_at"
)
WHERE po."status" IN ('confirmed', 'partially_received', 'received', 'closed');
