-- Kundens förfrågan: the customer's own inquiry/RFQ reference on a quote or
-- order, printed as "Er förfrågan:" on the quote and the order confirmation.
-- No backfill.
ALTER TABLE "sales_orders" ADD COLUMN "customer_inquiry_number" varchar(50);
