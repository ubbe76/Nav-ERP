import { sql } from "drizzle-orm";
import { companyInfo, customers, db, deliveries, deliveryRows, salesOrderRows, salesOrders } from "@navet/db";
import type { CreateArticleInput } from "@navet/shared";
import { testArticleService } from "./services.js";

// Shared fixtures for the shipping suites. number_series is never truncated
// (FR-/FS- counters survive across suites, same as the other series).
export const SHIPPING_TRUNCATE = sql`TRUNCATE shipment_tracking_events, shipment_files, shipment_parcels, shipment_deliveries, shipments, freight_products, pickup_times, holidays, delivery_rows, deliveries, sales_order_rows, sales_orders, customer_contacts, customer_delivery_addresses, customers, article_units, bom_components, stock_transactions, articles, package_types, audit_log CASCADE`;

export async function resetShipping() {
  await db.execute(SHIPPING_TRUNCATE);
  await db.execute(sql`DELETE FROM system_settings WHERE key LIKE 'freight_%'`);
}

export async function setCompany() {
  await db.update(companyInfo).set({
    name: "Vi AB",
    address: "Fabriksvägen 1",
    postalCode: "41107",
    city: "Göteborg",
    phone: "031-123456",
    email: "frakt@vi.example",
  });
}

// Frakten aktiverad med nyckel, vardagar 08–16 (lördag/söndag utan upphämtning).
export async function enableFreight(extra: Record<string, string> = {}) {
  const settings: Record<string, string> = {
    freight_enabled: "true",
    freight_environment: "sandbox",
    freight_api_key: "test-key",
    ...extra,
  };
  for (const [key, value] of Object.entries(settings)) {
    await db.execute(sql`INSERT INTO system_settings (key, value) VALUES (${key}, ${value}) ON CONFLICT (key) DO UPDATE SET value = ${value}`);
  }
  for (const weekday of [1, 2, 3, 4, 5]) {
    await db.execute(sql`INSERT INTO pickup_times (weekday, time_from, time_to) VALUES (${weekday}, '08:00', '16:00') ON CONFLICT (weekday) DO NOTHING`);
  }
  await setCompany();
}

let seq = 0;
export async function makeCustomer(over: Partial<typeof customers.$inferInsert> = {}) {
  seq++;
  const [row] = await db
    .insert(customers)
    .values({
      customerNumber: `FRK-${Date.now()}-${seq}`,
      name: `Kund ${seq} AB`,
      address: "Kundgatan 1",
      postalCode: "11151",
      city: "Stockholm",
      phone: "08-111111",
      email: `kund${seq}@example.com`,
      ...over,
    })
    .returning();
  return row!;
}

export async function makeArticle(over: Partial<CreateArticleInput> = {}) {
  seq++;
  const article = await testArticleService.createArticle({
    articleNumber: `FRK-ART-${Date.now()}-${seq}`,
    name: `Artikel ${seq}`,
    type: "manufactured",
    active: true,
    weight: 10,
    length: 400,
    width: 300,
    height: 200,
    ...over,
  });
  return article!;
}

// A sales order + one delivery (följesedel) with the given base-unit rows.
export async function makeDelivery(
  customerId: string,
  rows: { articleId: string; quantity: number }[],
  orderOver: Partial<typeof salesOrders.$inferInsert> = {}
) {
  seq++;
  // order_number/delivery_number are varchar(20): a 6-digit time part + seq
  // stays under that (seq alone keeps them unique within a test).
  const stamp = `${Date.now() % 1_000_000}-${seq}`;
  const [order] = await db
    .insert(salesOrders)
    .values({ orderNumber: `KO-FRK-${stamp}`, customerId, status: "in_production", ...orderOver })
    .returning();
  const [delivery] = await db
    .insert(deliveries)
    .values({ salesOrderId: order!.id, deliveryNumber: `FS-FRK-${stamp}` })
    .returning();
  for (const row of rows) {
    const [orderRow] = await db
      .insert(salesOrderRows)
      .values({ salesOrderId: order!.id, articleId: row.articleId, quantityOrdered: String(row.quantity), quantityDelivered: String(row.quantity), unitPrice: "100" })
      .returning();
    await db.insert(deliveryRows).values({ deliveryId: delivery!.id, salesOrderRowId: orderRow!.id, quantity: String(row.quantity) });
  }
  return { deliveryId: delivery!.id, deliveryNumber: delivery!.deliveryNumber, orderId: order!.id };
}
