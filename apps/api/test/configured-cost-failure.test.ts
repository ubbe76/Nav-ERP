import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, manufacturingOrders, moMaterialConsumptions, salesOrderRows, stockTransactions } from "@navet/db";
import type { ManufacturingOrderConfiguration } from "@navet/shared";
import { ConfigurationNotDerivableError } from "../src/modules/configurator/service/configurator.errors.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createSalesService, type RowConfigurationReader } from "../src/modules/sales/service/sales.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { makeVariantService } from "./helpers/configurator.js";
import { buildToOrderWithStructure, CONFIGURED_MFG_TRUNCATE, FULL, resetCostingSettings } from "./helpers/configured-manufacturing.js";
import {
  configurator,
  mailService,
  makeCustomer,
  makeLocation,
  makeUser,
  registerService,
  resetConfiguredRows,
  salesRepository,
  stockService,
} from "./helpers/configured-rows.js";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";

// Konfigurerad tillverkning: a förkalkyl failure never stops a sale or a
// TO. deriveForManufacturing tolerates a throw from the costing call only —
// the row/TO goes on with cost null (the order card says "Förkalkyl saknas
// för konfigurationen", the receipt gets no unit cost) and the failure is
// logged. The derivation's own errors are still refused.

beforeEach(async () => {
  await resetConfiguredRows();
  await db.execute(CONFIGURED_MFG_TRUNCATE);
  await resetCostingSettings();
  logged.length = 0;
});
afterAll(resetConfiguredRows);

const logged: { msg: string; extra?: Record<string, unknown> }[] = [];
// The configurator exactly as app.ts wires it, except that the costing
// module is down (e.g. its rate reader throws something other than
// ExchangeRateUnavailableError).
const failing = makeVariantService({
  prices: (q) => resolvePrice(db, q),
  costing: {
    previewStructure: async () => {
      throw new Error("rate reader down");
    },
  },
  log: (msg, extra) => {
    logged.push({ msg, extra });
  },
});
const rowConfiguration: RowConfigurationReader = {
  evaluate: (t, s, o) => failing.evaluateRowConfiguration(t, s, o),
  variantOf: (id) => failing.findVariantOf(id),
  resolveVariant: (t, s, u) => failing.resolveVariant(t, s, u),
};
const sales = createSalesService(
  salesRepository,
  registerService,
  mailService,
  testDocumentPdfService,
  stockService,
  testArticleService,
  testSystemService,
  (q) => resolvePrice(db, q, { variantPrice: (vq) => failing.variantPrice(vq) }),
  createAuditRepository(db),
  undefined,
  undefined,
  undefined,
  rowConfiguration
);
const mfg = createManufacturingService(
  createManufacturingRepository(db),
  testDocumentPdfService,
  testArticleService,
  {
    findRowForManufacturing: salesRepository.findRowForManufacturing,
    lockRowForManufacturing: salesRepository.lockRowForManufacturing,
    markInProduction: markSalesOrderInProduction,
  },
  undefined,
  (t, s, q, o) => failing.deriveForManufacturing(t, s, q, o)
);

const rawRow = async (rowId: string) => (await db.select().from(salesOrderRows).where(eq(salesOrderRows.id, rowId)))[0]!;
const receiptOf = async (moId: string) =>
  (
    await db
      .select()
      .from(stockTransactions)
      .where(and(eq(stockTransactions.referenceId, moId), eq(stockTransactions.transactionType, "mo_receipt")))
  )[0]!;

async function confirmedRowWithFailingCost(quantity = 1) {
  const s = await buildToOrderWithStructure();
  const c = await makeCustomer();
  const { order, rows } = await sales.createQuote(
    { customerId: c.id, confirm: true, rows: [{ articleId: s.article.id, quantity, configuration: { selection: FULL } }] } as never,
    null
  );
  return { s, order, row: rows[0]! };
}

describe("configured row and TO when the förkalkyl fails", () => {
  it("the sale goes through: the row is stored with its configuration and price but without cost, and the failure is logged", async () => {
    const { s, row } = await confirmedRowWithFailingCost(2);
    const stored = await rawRow(row.id);
    expect(stored.configuration).not.toBeNull();
    expect(stored.configurationCost).toBeNull();
    // Base 1000 + Lås B 50 + Avlopp 100: the price does not depend on the costing.
    expect(Number(stored.unitPrice)).toBe(1150);
    expect(logged).toHaveLength(1);
    expect(logged[0]!.extra).toMatchObject({ templateArticleId: s.article.id, quantity: 2 });
    expect(String(logged[0]!.extra?.error)).toContain("rate reader down");
    // listRows: the row has no self cost (null, never 0).
    const [listed] = await sales.listRows(row.salesOrderId);
    expect([listed!.selfCostPerUnit, listed!.selfCostCalculatedAt]).toEqual([null, null]);
  });

  it("the TO is created with its structure but without cost; the receipt is valued at nothing rather than refused", async () => {
    const { s, row } = await confirmedRowWithFailingCost(1);
    const loc = await makeLocation();
    const user = await makeUser();
    const mo = await mfg.createFromSalesOrderRow(row.id, {}, null);
    const [raw] = await db.select().from(manufacturingOrders).where(eq(manufacturingOrders.id, mo.id));
    const configuration = raw!.configuration as ManufacturingOrderConfiguration;
    expect(configuration.templateArticleId).toBe(s.article.id);
    expect(configuration.cost.manufacturingCostPerUnit).toBeNull();
    // The derived material is still the TO's (8 skruv, plåt, avlopp, the phantom's parts).
    const material = await db.select().from(moMaterialConsumptions).where(eq(moMaterialConsumptions.manufacturingOrderId, mo.id));
    expect(material.map((m) => m.componentArticleId)).toEqual(expect.arrayContaining([s.parts.skruv.id, s.parts.plat.id, s.parts.avl.id, s.parts.f1.id]));

    await mfg.start(mo.id);
    await mfg.complete(mo.id, { quantity: 1, locationId: loc.id }, user.id);
    const receipt = await receiptOf(mo.id);
    expect([Number(receipt.quantityDelta), receipt.unitCost]).toEqual([1, null]);
  });

  it("only the costing is tolerated: a structure the derivation cannot build is still refused", async () => {
    const s = await buildToOrderWithStructure();
    await configurator.createBomLine(
      s.article.id,
      { conditions: [], source: "group", componentGroupId: s.lock.id, quantity: 1, note: "Gångjärn" } as never
    );
    const c = await makeCustomer();
    await expect(
      sales.createQuote({ customerId: c.id, rows: [{ articleId: s.article.id, quantity: 1, configuration: { selection: FULL } }] } as never, null)
    ).rejects.toBeInstanceOf(ConfigurationNotDerivableError);
    expect(logged).toHaveLength(0);
  });
});
