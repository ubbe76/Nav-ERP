import { and, asc, eq, ne, or } from "drizzle-orm";
import {
  articleGroups,
  articles,
  articleSuppliers,
  auditLog,
  customerContacts,
  customerDeliveryAddresses,
  customers,
  deviationReasons,
  paymentTerms,
  productionGroups,
  stockLocations,
  stockTransactions,
  suppliers,
  units,
  warehouses,
  workCenters,
  type Db,
  type Tx,
} from "@navet/db";
import { createArticleSchema } from "@navet/shared";
import { insertArticle } from "../../article/repository/article.repository.js";
import { insertBomRows } from "../../article/repository/bom-write.js";
import { insertRoutingOperations } from "../../manufacturing/repository/routing-write.js";
import { replacePriceBreaks } from "../../purchase/repository/price-breaks.js";
import { FALLBACK_LOCATION_NAME, resolveStockLocation } from "../../stock/service/location-resolver.js";
import { getNextOrderNumber } from "../../system/service/number-series.js";
import { assertLocationNotUnderCount } from "../../stock/service/count-guard.js";
import { DEMO_LOCATIONS, type DemoData, type DemoLocation } from "../service/demo-data.js";

// The four registers that decide whether the demo company may be created —
// base data (groups, terms, locations, units) is reused instead.
export type DemoBlocker = "articles" | "customers" | "suppliers" | "workCenters";

export interface DemoDataCounts {
  articles: number;
  workCenters: number;
  customers: number;
  suppliers: number;
  stockTransactions: number;
}

export async function findDemoBlockers(executor: Db | Tx): Promise<DemoBlocker[]> {
  const blockers: DemoBlocker[] = [];
  if ((await executor.select({ id: articles.id }).from(articles).limit(1)).length) blockers.push("articles");
  if ((await executor.select({ id: customers.id }).from(customers).limit(1)).length) blockers.push("customers");
  if ((await executor.select({ id: suppliers.id }).from(suppliers).limit(1)).length) blockers.push("suppliers");
  if ((await executor.select({ id: workCenters.id }).from(workCenters).limit(1)).length) blockers.push("workCenters");
  return blockers;
}

// Find-or-create: a register entry someone already made is reused. Article
// groups are unique on the name as well as the code, so either one matching
// means "already there" (inserting would hit the name constraint); production
// groups are unique on the code only.
async function codeIds(
  tx: Tx,
  table: typeof articleGroups | typeof productionGroups,
  entries: { code: string; name: string }[],
  matchName: boolean
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const entry of entries) {
    const match = matchName ? or(eq(table.code, entry.code), eq(table.name, entry.name)) : eq(table.code, entry.code);
    const [existing] = await tx.select({ id: table.id }).from(table).where(match).limit(1);
    const id = existing?.id ?? (await tx.insert(table).values(entry).returning({ id: table.id }))[0]!.id;
    ids.set(entry.code, id);
  }
  return ids;
}

async function unitIds(tx: Tx): Promise<Map<string, string>> {
  const wanted = [
    { code: "st", name: "Styck" },
    { code: "m", name: "Meter" },
  ];
  const ids = new Map<string, string>();
  for (const unit of wanted) {
    // Unique on both code and name — either one matching is the unit.
    const [existing] = await tx
      .select({ id: units.id })
      .from(units)
      .where(or(eq(units.code, unit.code), eq(units.name, unit.name)))
      .limit(1);
    ids.set(unit.code, existing?.id ?? (await tx.insert(units).values(unit).returning({ id: units.id }))[0]!.id);
  }
  return ids;
}

async function locationIds(tx: Tx): Promise<Record<DemoLocation, string>> {
  // Never the "***" fallback warehouse — on a fresh installation it is the
  // only one, and the demo locations would read "*** — Råvarulager".
  const [warehouse] = await tx
    .select({ id: warehouses.id })
    .from(warehouses)
    .where(and(eq(warehouses.active, true), ne(warehouses.name, FALLBACK_LOCATION_NAME)))
    .orderBy(asc(warehouses.name), asc(warehouses.id))
    .limit(1);
  const warehouseId = warehouse?.id ?? (await tx.insert(warehouses).values({ name: "Huvudlager" }).returning({ id: warehouses.id }))[0]!.id;
  const result = {} as Record<DemoLocation, string>;
  for (const [key, name] of Object.entries(DEMO_LOCATIONS) as [DemoLocation, string][]) {
    const [existing] = await tx
      .select({ id: stockLocations.id })
      .from(stockLocations)
      .where(and(eq(stockLocations.warehouseId, warehouseId), eq(stockLocations.name, name)));
    result[key] =
      existing?.id ?? (await tx.insert(stockLocations).values({ warehouseId, name }).returning({ id: stockLocations.id }))[0]!.id;
  }
  return result;
}

// Writes the whole company inside the caller's transaction, in dependency
// order. The caller has locked and checked that the four registers are empty.
export async function writeDemoData(tx: Tx, data: DemoData, userId: string | null): Promise<DemoDataCounts> {
  const groupIds = await codeIds(tx, articleGroups, data.articleGroups, true);
  const prodGroupIds = await codeIds(tx, productionGroups, data.productionGroups, false);
  const unitIdByCode = await unitIds(tx);
  const locations = await locationIds(tx);

  // Unique on both code and name, like the article groups.
  const [term] = await tx
    .select({ id: paymentTerms.id })
    .from(paymentTerms)
    .where(or(eq(paymentTerms.code, data.paymentTerm.code), eq(paymentTerms.name, data.paymentTerm.name)))
    .limit(1);
  const paymentTermId = term?.id ?? (await tx.insert(paymentTerms).values(data.paymentTerm).returning({ id: paymentTerms.id }))[0]!.id;

  // Avvikelseorsaker: unique on both code and name — an existing one (either
  // matching) is left as it is.
  for (const reason of data.deviationReasons) {
    await tx
      .insert(deviationReasons)
      .values({
        code: reason.code,
        name: reason.name,
        appliesCustomer: reason.customer,
        appliesSupplier: reason.supplier,
        appliesInternal: reason.internal,
        appliesScrap: reason.scrap,
      })
      .onConflictDoNothing();
  }

  const workCenterIds = new Map<string, string>();
  for (const wc of data.workCenters) {
    const [row] = await tx
      .insert(workCenters)
      .values({
        code: wc.code,
        name: wc.name,
        type: wc.type,
        productionGroupId: prodGroupIds.get(wc.productionGroup)!,
        hourlyRate: String(wc.hourlyRate),
        overheadPercent: "0",
        active: true,
      })
      .returning({ id: workCenters.id });
    workCenterIds.set(wc.code, row!.id);
  }

  // Register numbers from the series inside this transaction: a failure rolls
  // the counters back with everything else.
  const supplierIds = new Map<string, string>();
  for (const s of data.suppliers) {
    const [row] = await tx
      .insert(suppliers)
      .values({
        supplierNumber: await getNextOrderNumber(tx, "supplier"),
        name: s.name,
        address: s.address,
        postalCode: s.postalCode,
        city: s.city,
        email: s.email,
        phone: s.phone,
        paymentTermId,
      })
      .returning({ id: suppliers.id });
    supplierIds.set(s.key, row!.id);
  }

  for (const c of data.customers) {
    const [row] = await tx
      .insert(customers)
      .values({
        customerNumber: await getNextOrderNumber(tx, "customer"),
        name: c.name,
        address: c.address,
        postalCode: c.postalCode,
        city: c.city,
        email: c.email,
        phone: c.phone,
        paymentTermId,
      })
      .returning({ id: customers.id });
    if (c.deliveryAddress) {
      await tx.insert(customerDeliveryAddresses).values({ customerId: row!.id, ...c.deliveryAddress, isDefault: true });
    }
    if (c.contact) {
      await tx.insert(customerContacts).values({ customerId: row!.id, ...c.contact, isPrimary: true });
    }
  }

  const articleIds = new Map<string, string>();
  for (const a of data.articles) {
    const input = createArticleSchema.parse({
      articleNumber: a.articleNumber,
      name: a.name,
      type: a.type,
      isPhantom: a.isPhantom ?? false,
      standardCost: a.standardCost,
      salesPrice: a.salesPrice,
      groupId: groupIds.get(a.group),
      defaultLocationId: locations[a.location],
    });
    const row = await insertArticle(tx, { ...input, articleNumber: a.articleNumber, unitId: unitIdByCode.get(a.unit)! });
    articleIds.set(a.articleNumber, row!.id);
  }

  // All articles exist before any structure row points at one.
  for (const a of data.articles) {
    const articleId = articleIds.get(a.articleNumber)!;
    const operationIds = await insertRoutingOperations(
      tx,
      articleId,
      (a.routing ?? []).map((op) => ({
        sequenceNo: op.sequenceNo,
        description: data.workCenters.find((wc) => wc.code === op.workCenter)!.name,
        workCenterId: workCenterIds.get(op.workCenter)!,
        setupTime: String(op.setupTime),
        runTimePerUnit: String(op.runTimePerUnit),
      }))
    );
    await insertBomRows(
      tx,
      articleId,
      (a.bom ?? []).map((row) => ({
        componentArticleId: articleIds.get(row.component)!,
        quantity: row.quantity,
        unitId: null,
        unitFactor: null,
        routingOperationId: row.operation === null ? null : operationIds.get(row.operation)!,
      }))
    );
    if (a.supplier) {
      const [link] = await tx
        .insert(articleSuppliers)
        .values({ articleId, supplierId: supplierIds.get(a.supplier.supplier)!, price: String(a.supplier.price), isPrimary: true })
        .returning({ id: articleSuppliers.id });
      await replacePriceBreaks(tx, link!.id, a.supplier.breaks ?? []);
    }
  }

  // Opening balances: the same rule as a positive stock adjustment — the
  // row carries the standard cost as its unit cost (D0).
  let stockRows = 0;
  for (const a of data.articles) {
    if (!a.openingStock) continue;
    const articleId = articleIds.get(a.articleNumber)!;
    const locationId = await resolveStockLocation(tx, articleId, locations[a.location]);
    // A reused location may be under a blocking stock count — same guard as
    // every other stock write.
    await assertLocationNotUnderCount(tx, locationId);
    await tx.insert(stockTransactions).values({
      articleId,
      locationId,
      quantityDelta: String(a.openingStock),
      unitCost: String(a.standardCost),
      transactionType: "inventory_adjustment",
      note: "Exempeldata — ingående saldo",
      createdBy: userId,
    });
    stockRows++;
  }

  const counts: DemoDataCounts = {
    articles: data.articles.length,
    workCenters: data.workCenters.length,
    customers: data.customers.length,
    suppliers: data.suppliers.length,
    stockTransactions: stockRows,
  };
  await tx.insert(auditLog).values({ entityType: "system", entityId: null, action: "demo_data_created", detail: counts, userId });
  return counts;
}
