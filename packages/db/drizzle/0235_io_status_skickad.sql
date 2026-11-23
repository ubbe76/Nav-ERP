-- Skickad på inköpsordern (2026-11-23, the user: "Ändra status till Skickad
-- när e-posten är skickad. Annars vet man ju inte om man skickat
-- inköpsordern."): a mailed Utkast becomes Skickad; only Bekräfta sets
-- Bekräftad. Its own migration — the value is not used here (55P04, see 0120).
ALTER TYPE "public"."purchase_order_status" ADD VALUE 'sent' BEFORE 'confirmed';
