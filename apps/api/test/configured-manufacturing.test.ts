import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { configuratorTemplates, db, manufacturingOrders, moMaterialConsumptions, moOperations, stockTransactions } from "@navet/db";
import type { ManufacturingOrderConfiguration } from "@navet/shared";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import {
  ConfigurationNotAllowedError,
  ConfigurationRequiredError,
  RowConfigurationChangedError,
} from "../src/modules/sales/service/sales.errors.js";
import {
  ConfiguratorInvalidConfigurationError,
  ConfiguratorModeChangedError,
  ConfiguratorNotToOrderModeError,
} from "../src/modules/configurator/service/configurator.errors.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import {
  buildToOrderWithStructure,
  CONFIGURED_MFG_TRUNCATE,
  confirmedRow,
  FULL,
  mfg,
  resetCostingSettings,
} from "./helpers/configured-manufacturing.js";
import { configurator, makeLocation, makeUser, resetConfiguredRows, salesRepository, salesService } from "./helpers/configured-rows.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { pdfText } from "./helpers/pdf.js";
import { failure, waitForLockWaiter } from "./helpers/year-end.js";

// Konfigurator 4c: a beställningsvara's TO carries its derived structure from
// creation — all three paths (the KO row's Skapa TO, Ny tillverkningsorder,
// planning's Skapa ordrar) land in createManufacturingOrder.

beforeEach(async () => {
  await resetConfiguredRows();
  await db.execute(CONFIGURED_MFG_TRUNCATE);
  await resetCostingSettings();
});
afterAll(resetConfiguredRows);

const opsOf = (moId: string) =>
  db.select().from(moOperations).where(eq(moOperations.manufacturingOrderId, moId)).orderBy(moOperations.sequenceNo);
const matOf = (moId: string) => db.select().from(moMaterialConsumptions).where(eq(moMaterialConsumptions.manufacturingOrderId, moId));
const receiptOf = async (moId: string) => {
  const [receipt] = await db
    .select()
    .from(stockTransactions)
    .where(and(eq(stockTransactions.referenceId, moId), eq(stockTransactions.transactionType, "mo_receipt")));
  return receipt!;
};

describe("configured TO — creation", () => {
  it("Skapa TO writes the derived structure at creation, with the row's choices and the TVK/st", async () => {
    const { s, row } = await confirmedRow(2);
    const mo = await mfg.createFromSalesOrderRow(row.id, {}, null);
    expect(mo.status).toBe("released");
    const cfg = mo.configuration as ManufacturingOrderConfiguration;
    expect(cfg.templateArticleId).toBe(s.article.id);
    expect(cfg.key).toBe((row.configuration as { key: string }).key);
    expect(cfg.selection).toEqual((row.configuration as { selection: unknown }).selection);
    expect(cfg.cost.manufacturingCostPerUnit).toBe(168);
    const ops = await opsOf(mo.id);
    expect(ops.map((o) => [o.sequenceNo, o.routingOperationId, o.description])).toEqual([
      [10, s.op10.id, "Kapa"],
      [20, null, "Montera lås B"],
    ]);
    const mats = await matOf(mo.id);
    const plat = mats.find((m) => m.componentArticleId === s.parts.plat.id)!;
    expect(Number(plat.quantityPlanned)).toBe(2.4);
    expect(plat.moOperationId).toBe(ops[0]!.id);
    expect(mats.some((m) => m.componentArticleId === s.parts.fant.id)).toBe(false);
  });

  it("Ny tillverkningsorder on the template takes the choices from the body", async () => {
    const s = await buildToOrderWithStructure();
    const mo = await mfg.createManufacturingOrder(
      { articleId: s.article.id, quantity: 1, configuration: { selection: { LOCK: "A", BREDD: 800 } } },
      null
    );
    const cfg = mo.configuration as ManufacturingOrderConfiguration;
    expect(cfg.selection.find((e) => e.groupCode === "LOCK")!.valueCode).toBe("A");
    expect((await opsOf(mo.id)).map((o) => o.sequenceNo)).toEqual([10]);
  });

  it("refuses: template without choices, choices with a row, choices on an ordinary article, invalid choices", async () => {
    const s = await buildToOrderWithStructure();
    await expect(mfg.createManufacturingOrder({ articleId: s.article.id, quantity: 1 }, null)).rejects.toBeInstanceOf(
      ConfigurationRequiredError
    );
    const { row } = await confirmedRow();
    await expect(
      mfg.createManufacturingOrder({ salesOrderRowId: row.id, quantity: 1, configuration: { selection: FULL } } as never, null)
    ).rejects.toBeInstanceOf(ConfigurationNotAllowedError);
    const plain = await testArticleService.createArticle({
      articleNumber: `P-${crypto.randomUUID().slice(0, 6)}`,
      name: "Vanlig",
      type: "manufactured",
      unit: "st",
    } as never);
    await expect(
      mfg.createManufacturingOrder({ articleId: plain.id, quantity: 1, configuration: { selection: {} } }, null)
    ).rejects.toBeInstanceOf(ConfigurationNotAllowedError);
    await expect(
      mfg.createManufacturingOrder({ articleId: s.article.id, quantity: 1, configuration: { selection: { LOCK: "B" } } }, null)
    ).rejects.toBeInstanceOf(ConfiguratorInvalidConfigurationError);
  });

  it("a row without configuration on a to_order template is refused", async () => {
    const { row } = await confirmedRow();
    await db.execute(sql`update sales_order_rows set configuration = null where id = ${row.id}`);
    await expect(mfg.createFromSalesOrderRow(row.id, {}, null)).rejects.toBeInstanceOf(ConfigurationRequiredError);
  });

  it("a configured row whose template left the to_order mode is refused — no plain TO on the template's own BOM", async () => {
    const { s, row } = await confirmedRow();
    // Lägesbyte/borttag av mallen spärras inte av rader — the row keeps its choices.
    await configurator.deleteTemplate(s.article.id);
    await expect(mfg.createFromSalesOrderRow(row.id, {}, null)).rejects.toBeInstanceOf(ConfiguratorNotToOrderModeError);
    await expect(mfg.createManufacturingOrder({ salesOrderRowId: row.id, quantity: 1 }, null)).rejects.toBeInstanceOf(
      ConfiguratorNotToOrderModeError
    );
    const written = await db.select().from(manufacturingOrders).where(eq(manufacturingOrders.salesOrderRowId, row.id));
    expect(written).toHaveLength(0);
  });

  it("a row reconfigured between derivation and insert ⇒ 409, nothing written", async () => {
    const { row } = await confirmedRow();
    const reader = (t: string, sel: never, q: number, o?: { withCost?: boolean }) =>
      configurator.deriveForManufacturing(t, sel, q, o).then(async (r) => {
        await db.execute(
          sql`update sales_order_rows set configuration = jsonb_set(configuration, '{key}', '"changed"') where id = ${row.id}`
        );
        return r;
      });
    const racing = createManufacturingService(
      createManufacturingRepository(db),
      testDocumentPdfService,
      testArticleService,
      {
        findRowForManufacturing: salesRepository.findRowForManufacturing,
        lockRowForManufacturing: salesRepository.lockRowForManufacturing,
        markInProduction: markSalesOrderInProduction,
      },
      undefined,
      reader as never
    );
    await expect(racing.createFromSalesOrderRow(row.id, {}, null)).rejects.toBeInstanceOf(RowConfigurationChangedError);
    expect(await db.select().from(manufacturingOrders)).toHaveLength(0);
  });

  // The mode is read (and the structure derived) before the transaction; the
  // transaction re-reads it FOR SHARE after the row lock and refuses a change.
  it("a template whose mode changes between derivation and insert ⇒ 409, nothing written", async () => {
    const s = await buildToOrderWithStructure();
    let create: Promise<unknown> | undefined;
    await db.transaction(async (holder) => {
      // The flip is uncommitted: the service still reads to_order and
      // derives, then queues on the template row in its own transaction.
      await holder.update(configuratorTemplates).set({ mode: "variants" }).where(eq(configuratorTemplates.articleId, s.article.id));
      create = failure(mfg.createManufacturingOrder({ articleId: s.article.id, quantity: 1, configuration: { selection: FULL } }, null));
      await waitForLockWaiter();
    });
    expect(await create!).toBeInstanceOf(ConfiguratorModeChangedError);
    expect(await db.select().from(manufacturingOrders)).toHaveLength(0);
  });

  it("two concurrent Skapa TO on one row both succeed with their own structure", async () => {
    const { row } = await confirmedRow(2);
    const [a, b] = await Promise.all([
      mfg.createFromSalesOrderRow(row.id, { quantity: 1 }, null),
      mfg.createFromSalesOrderRow(row.id, { quantity: 1 }, null),
    ]);
    expect((await opsOf(a.id)).length).toBe(2);
    expect((await opsOf(b.id)).length).toBe(2);
  });

  it("Ändra konfiguration is still refused once the row has a TO", async () => {
    const { order, row } = await confirmedRow();
    await mfg.createFromSalesOrderRow(row.id, {}, null);
    await expect(
      salesService.setRowConfiguration(order.id, row.id, { selection: { LOCK: "A", BREDD: 900 } } as never)
    ).rejects.toMatchObject({ name: "RowConfigurationLockedError" });
  });
});

describe("configured TO — release, reporting and stock value", () => {
  it("is released at creation with its derived rows; a later template change does not touch the TO", async () => {
    const { s, row } = await confirmedRow();
    const mo = await mfg.createFromSalesOrderRow(row.id, {}, null);
    expect(mo.status).toBe("released");
    const before = { ops: await opsOf(mo.id), mats: await matOf(mo.id) };
    await testArticleService.addBomComponent(s.article.id, { componentArticleId: s.parts.avl.id, quantity: 5 });
    expect((await opsOf(mo.id)).map((o) => o.id)).toEqual(before.ops.map((o) => o.id));
    expect((await matOf(mo.id)).map((m) => [m.componentArticleId, m.quantityPlanned])).toEqual(
      before.mats.map((m) => [m.componentArticleId, m.quantityPlanned])
    );
    // Nothing in stock ⇒ shortage warnings from the rows written at creation,
    // in the same text as a plain TO's release, ordered by component name.
    expect(mo.releaseWarnings).toEqual([
      "Avlopp: behöver 1, tillgängligt 0",
      "Del 1: behöver 2, tillgängligt 0",
      "Del 2: behöver 1, tillgängligt 0",
      "Plåt: behöver 1.2, tillgängligt 0",
      "Skruv: behöver 8, tillgängligt 0",
    ]);
  });

  it("final reporting stamps the förkalkyl TVK/st on the receipt; without cost it is null", async () => {
    const { s, row } = await confirmedRow();
    const loc = await makeLocation();
    const mo = await mfg.createFromSalesOrderRow(row.id, {}, null);
    await mfg.start(mo.id);
    const user = await makeUser();
    await mfg.complete(mo.id, { quantity: 1, locationId: loc.id }, user.id);
    const receipt = await receiptOf(mo.id);
    // TO of 1 st ⇒ the setup of op 10 is not shared: TVK/st 198 (see the fixture comment)
    expect(Number(receipt.unitCost)).toBe(198);
    expect(s.article.id).toBe(receipt.articleId);

    const free = await mfg.createManufacturingOrder({ articleId: s.article.id, quantity: 1, configuration: { selection: FULL } }, null);
    await db.execute(
      sql`update manufacturing_orders set configuration = jsonb_set(configuration, '{cost,manufacturingCostPerUnit}', 'null') where id = ${free.id}`
    );
    await mfg.start(free.id);
    await mfg.complete(free.id, { quantity: 1, locationId: loc.id }, user.id);
    const noCost = await receiptOf(free.id);
    expect(noCost.unitCost).toBeNull();
  });

  it("over-reporting stamps the per-unit cost and tops up material", async () => {
    const { s, row } = await confirmedRow();
    const loc = await makeLocation();
    const user = await makeUser();
    const mo = await mfg.createFromSalesOrderRow(row.id, {}, null);
    await mfg.start(mo.id);
    await mfg.complete(mo.id, { quantity: 2, locationId: loc.id }, user.id);
    const receipt = await receiptOf(mo.id);
    expect([Number(receipt.quantityDelta), Number(receipt.unitCost)]).toEqual([2, 198]); // cost at the TO quantity (1), not the reported 2
    const skruv = (await matOf(mo.id)).find((m) => m.componentArticleId === s.parts.skruv.id)!;
    expect(Number(skruv.quantityConsumed)).toBe(16);
  });

  it("the TO printout lists the choices under the article", async () => {
    const { row } = await confirmedRow();
    const mo = await mfg.createFromSalesOrderRow(row.id, {}, null);
    const text = pdfText((await mfg.getManufacturingOrderPdf(mo.id)).content);
    expect(text).toContain("Lås: Lås B");
    expect(text).toContain("Avlopp: Ja");
    expect(text).toContain("Bredd: 1 200 mm");
  });
});
