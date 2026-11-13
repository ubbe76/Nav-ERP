import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { ZodError } from "zod";
import { eq, sql } from "drizzle-orm";
import {
  articles,
  auditLog,
  companyInfo,
  db,
  purchaseOrderDispatches,
  units,
} from "@navet/db";
import {
  createPurchaseDispatchSchema,
  dispatchPalletCardQuerySchema,
  createArticleSchema,
  createCustomerSchema,
  createPurchaseOrderSchema,
  createSupplierSchema,
  createWorkCenterSchema,
} from "@navet/shared";
import {
  pdfPageCount,
  pdfRectCount,
  pdfRects,
  pdfText,
} from "./helpers/pdf.js";
import {
  testArticleService,
  testDocumentPdfService,
  testSystemService,
} from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { purchaseRoutes } from "../src/modules/purchase/routes/purchase.routes.js";
import {
  createPurchaseService,
  InvalidStatusTransitionError,
  PurchaseDispatchAlreadyUndoneError,
  PurchaseDispatchNotFoundError,
  PurchaseDispatchRowNotInDispatchError,
  PurchaseDispatchRowNotLegoError,
  PurchaseDispatchUndoneError,
  PurchaseOrderNotFoundError,
  PurchaseOrderRowHasDispatchesError,
  PurchaseOrderRowNotFoundError,
  splitOverParcels,
} from "../src/modules/purchase/service/purchase.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { parsed } from "./helpers/parsed.js";

// Avsändning till legoleverantör: Rapportera avsändning logs what was sent
// (no stock effect), Skickat is derived on the IO row and the TO card, Ångra
// stamps the log, and the pallet card TILL LEGOLEVERANTÖR prints from it.
// Real purchase ↔ manufacturing ↔ sales wiring, as app.ts.

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const registerService = createRegisterService(createRegisterRepository(db));
const mailService = createMailService(
  createMailRepository(db),
  testSystemService,
);
const salesRepository = createSalesRepository(db);
const salesService = createSalesService(
  salesRepository,
  registerService,
  mailService,
  testDocumentPdfService,
  stockService,
  testArticleService,
  testSystemService,
  (query) => resolvePrice(db, query),
);
const mfgService = createManufacturingService(
  createManufacturingRepository(db),
  testDocumentPdfService,
  testArticleService,
  {
    findRowForManufacturing: salesRepository.findRowForManufacturing,
    lockRowForManufacturing: salesRepository.lockRowForManufacturing,
    markInProduction: markSalesOrderInProduction,
  },
);
const purchaseRepo = createPurchaseRepository(db);
const purchaseService = createPurchaseService(
  purchaseRepo,
  registerService,
  mailService,
  testDocumentPdfService,
  testArticleService,
  testSystemService,
  mfgService,
  createAuditRepository(db),
);

const TABLES = sql`TRUNCATE audit_log, purchase_order_dispatch_rows, purchase_order_dispatches, purchase_receipts, mo_reports, purchase_order_rows, purchase_orders, supplier_delivery_addresses, mo_material_consumptions, mo_operation_scrap, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, suppliers, sales_order_rows, sales_orders, customer_delivery_addresses, customers, stock_transactions, stock_locations, warehouses, bom_components, article_units, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TABLES);
  await testSystemService.updateSettings({ palletCardCode: "none" });
  await db.update(companyInfo).set({
    name: "Testbolaget AB",
    address: "Fabriksgatan 1",
    postalCode: "111 11",
    city: "Fabriksstaden",
    deliveryAddress: null,
    deliveryPostalCode: null,
    deliveryCity: null,
  });
});

afterAll(async () => {
  await db.execute(TABLES);
  await testSystemService.updateSettings({ palletCardCode: "none" });
});

// Work center codes are unique and three digits — one pair per fixture.
let workCenterSeq = 0;

async function makeUser(name = "Inköparen") {
  return authRepo.create({
    email: `lego-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name,
    role: "admin",
  });
}

// A manufactured article (Förzinkad / RAL 9010) whose second operation is a
// lego operation, a released TO on it (optionally created for a KO row with
// a chosen delivery address) and a confirmed IO with the lego row plus one
// ordinary row.
async function makeFixture(
  opts: {
    language?: "sv" | "en";
    supplierDeliveryAddress?: boolean;
    linkToSalesOrder?: boolean;
    quantity?: number;
  } = {},
) {
  const quantity = opts.quantity ?? 10;
  const user = await makeUser();
  const supplier = await purchaseService.createSupplier(parsed(createSupplierSchema, {
    name: "Ytbehandling AB",
    active: true,
    language: opts.language ?? "sv",
    address: "Lackvägen 3",
    postalCode: "222 22",
    city: "Lackstaden",
    country: "SE",
  }));
  if (opts.supplierDeliveryAddress) {
    await purchaseService.createSupplierDeliveryAddress(supplier.id, {
      label: "Godsmottagning",
      address: "Godsgatan 9",
      postalCode: "333 33",
      city: "Godsstaden",
      country: "SE",
      isDefault: true,
    });
  }
  workCenterSeq += 1;
  const machine = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, {
    code: String(100 + workCenterSeq),
    name: "Svets",
    type: "machine",
    active: true,
  }));
  const lego = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, {
    code: String(900 + workCenterSeq),
    name: "Ytbehandling",
    type: "subcontract",
    supplierId: supplier.id,
    active: true,
  }));
  const parent = await articleService.createArticle(parsed(createArticleSchema, {
    articleNumber: `LEGO-${crypto.randomUUID().slice(0, 8)}`,
    name: "Legodetalj",
    nameEn: "Subcontract part",
    type: "manufactured",
    surfaceTreatment: "Förzinkad",
    colour: "RAL 9010",
    active: true,
  }));
  const plain = await articleService.createArticle(parsed(createArticleSchema, {
    articleNumber: `PLAIN-${crypto.randomUUID().slice(0, 8)}`,
    name: "Skruv",
    type: "purchased",
    active: true,
  }));
  await mfgService.createRoutingOperation(parent.id, {
    sequenceNo: 10,
    workCenterId: machine.id,
    setupTime: 0,
    runTimePerUnit: 1,
  });
  await mfgService.createRoutingOperation(parent.id, {
    sequenceNo: 20,
    workCenterId: lego.id,
    setupTime: 0,
    runTimePerUnit: 0,
    unitPrice: 100,
    description: "Lackering",
  });

  let salesOrder: { id: string; orderNumber: string } | null = null;
  let customer: { id: string; name: string } | null = null;
  let mo;
  if (opts.linkToSalesOrder) {
    customer = await salesService.createCustomer(parsed(createCustomerSchema, {
      name: "Kund AB",
      active: true,
    }));
    const address = await salesService.createDeliveryAddress(customer.id, {
      label: "Byggplatsen",
      address: "Byggvägen 5",
      postalCode: "444 44",
      city: "Byggstaden",
      country: "NO",
      isDefault: true,
    });
    const created = await salesService.createQuote(
      {
        customerId: customer.id,
        confirm: true,
        deliveryAddressId: address.id,
        rows: [{ articleId: parent.id, quantity, unitPrice: 500 }],
      },
      user.id,
    );
    salesOrder = {
      id: created.order.id,
      orderNumber: created.order.orderNumber,
    };
    mo = await mfgService.createManufacturingOrder(
      { quantity, salesOrderRowId: created.rows[0]!.id },
      user.id,
    );
  } else {
    mo = await mfgService.createManufacturingOrder(
      { articleId: parent.id, quantity },
      user.id,
    );
  }
  const legoOp = (await mfgService.listOperations(mo.id)).find(
    (op) => op.sequenceNo === 20,
  )!;
  const order = await purchaseService.createPurchaseOrder(
    parsed(createPurchaseOrderSchema, { supplierId: supplier.id }),
    user.id,
  );
  const legoRow = await purchaseService.addRow(order.id, {
    articleId: parent.id,
    quantity,
    unitPrice: 100,
    moOperationId: legoOp.id,
  });
  const plainRow = await purchaseService.addRow(order.id, {
    articleId: plain.id,
    quantity: 5,
    unitPrice: 1,
  });
  await purchaseService.confirm(order.id);
  return {
    user,
    supplier,
    parent,
    plain,
    mo,
    legoOp,
    order,
    legoRow,
    plainRow,
    salesOrder,
    customer,
  };
}

function rowOf(
  rows: Awaited<ReturnType<typeof purchaseService.listRows>>,
  id: string,
) {
  return rows.find((r) => r.id === id)!;
}

describe("Rapportera avsändning (createDispatch)", () => {
  it("logs the rows with parcels, derives Skickat on the IO row and the TO card, and never touches stock or status", async () => {
    const f = await makeFixture();
    const dispatch = await purchaseService.createDispatch(
      f.order.id,
      {
        rows: [{ rowId: f.legoRow.id, quantity: 4, parcels: 2 }],
        note: "Bil 1",
      },
      f.user.id,
    );
    expect(dispatch.rows).toHaveLength(1);
    expect(dispatch.rows[0]).toMatchObject({
      purchaseOrderRowId: f.legoRow.id,
      quantity: "4.0000",
      parcels: 2,
    });
    expect(dispatch.note).toBe("Bil 1");

    const again = await purchaseService.createDispatch(
      f.order.id,
      { rows: [{ rowId: f.legoRow.id, quantity: 3, parcels: 1 }] },
      f.user.id,
    );
    expect(again.id).not.toBe(dispatch.id);

    const rows = await purchaseService.listRows(f.order.id);
    expect(rowOf(rows, f.legoRow.id).quantityDispatched).toBe("7.0000");
    expect(rowOf(rows, f.plainRow.id).quantityDispatched).toBe("0");
    expect(rowOf(rows, f.legoRow.id).quantityReceived).toBe("0.0000");
    expect((await purchaseService.getPurchaseOrder(f.order.id))!.status).toBe(
      "confirmed",
    );

    const [legoPurchases] = (await mfgService.listLegoPurchases(f.mo.id))!;
    expect(legoPurchases!.purchaseOrders[0]).toMatchObject({
      orderNumber: f.order.orderNumber,
      quantityOrdered: 10,
      quantityReceived: 0,
      dispatchedQuantity: 7,
    });

    const log = await purchaseService.listDispatches(f.order.id);
    expect(
      log.map((d) => [
        d.rows[0]!.quantity,
        d.rows[0]!.parcels,
        d.undoneAt,
        d.dispatchedByName,
      ]),
    ).toEqual([
      [3, 1, null, "Inköparen"],
      [4, 2, null, "Inköparen"],
    ]);
    expect(log[0]!.rows[0]).toMatchObject({
      articleNumber: f.parent.articleNumber,
      unit: "st",
      legoReference: `Lego för ${f.mo.orderNumber} · Op 20 · Lackering`,
    });

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "goods_dispatched"))
      .limit(1);
    expect(audit?.entityId).toBe(f.order.orderNumber);
  });

  it("takes several rows in one dispatch and converts quantities with the row's unit factor", async () => {
    const f = await makeFixture();
    // A second lego row entered in kg (1 st = 5 kg): quantities arrive in
    // the base unit like a goods receipt, the log shows the row's unit.
    const [kg] = (await db.select().from(units).where(eq(units.code, "kg")))
      .length
      ? await db.select().from(units).where(eq(units.code, "kg"))
      : await db
          .insert(units)
          .values({ code: "kg", name: "Kilogram" })
          .returning();
    await articleService.addArticleUnit(f.parent.id, {
      unitId: kg!.id,
      quantityPerBase: 5,
    });
    const other = await mfgService.createManufacturingOrder(
      { articleId: f.parent.id, quantity: 4 },
      f.user.id,
    );
    const otherOp = (await mfgService.listOperations(other.id)).find(
      (op) => op.sequenceNo === 20,
    )!;
    const kgRow = await purchaseService.addRow(f.order.id, {
      articleId: f.parent.id,
      quantity: 20,
      unitPrice: 20,
      unitId: kg!.id,
      moOperationId: otherOp.id,
    });
    expect(kgRow.quantityOrdered).toBe("4.0000");

    await purchaseService.createDispatch(
      f.order.id,
      {
        rows: [
          { rowId: f.legoRow.id, quantity: 10, parcels: 1 },
          { rowId: kgRow.id, quantity: 2, parcels: 3 },
        ],
      },
      f.user.id,
    );
    const rows = await purchaseService.listRows(f.order.id);
    expect(rowOf(rows, kgRow.id).quantityDispatched).toBe("2.0000");
    const [log] = await purchaseService.listDispatches(f.order.id);
    expect(
      log!.rows.map((r) => [
        r.purchaseOrderRowId,
        r.quantity,
        r.unit,
        r.parcels,
      ]),
    ).toEqual([
      [f.legoRow.id, 10, "st", 1],
      [kgRow.id, 10, "kg", 3],
    ]);
    // More than ordered is allowed — the web warns, the server does not stop it.
    await purchaseService.createDispatch(
      f.order.id,
      { rows: [{ rowId: f.legoRow.id, quantity: 100, parcels: 1 }] },
      f.user.id,
    );
    expect(
      rowOf(await purchaseService.listRows(f.order.id), f.legoRow.id)
        .quantityDispatched,
    ).toBe("110.0000");
  });

  it("refuses a row that is not a lego row, a row of another order and an order that is received, closed or cancelled", async () => {
    const f = await makeFixture();
    await expect(
      purchaseService.createDispatch(
        f.order.id,
        { rows: [{ rowId: f.plainRow.id, quantity: 1, parcels: 1 }] },
        f.user.id,
      ),
    ).rejects.toThrow(PurchaseDispatchRowNotLegoError);
    const other = await makeFixture();
    await expect(
      purchaseService.createDispatch(
        f.order.id,
        { rows: [{ rowId: other.legoRow.id, quantity: 1, parcels: 1 }] },
        f.user.id,
      ),
    ).rejects.toThrow(PurchaseOrderRowNotFoundError);
    // Nothing was logged by the refused calls.
    expect(await db.select().from(purchaseOrderDispatches)).toHaveLength(0);

    // Draft and partially received are open; received/closed/cancelled are not.
    const draft = await purchaseService.createPurchaseOrder(
      parsed(createPurchaseOrderSchema, { supplierId: f.supplier.id }),
      f.user.id,
    );
    const draftMo = await mfgService.createManufacturingOrder(
      { articleId: f.parent.id, quantity: 2 },
      f.user.id,
    );
    const draftOp = (await mfgService.listOperations(draftMo.id)).find(
      (op) => op.sequenceNo === 20,
    )!;
    const draftRow = await purchaseService.addRow(draft.id, {
      articleId: f.parent.id,
      quantity: 2,
      unitPrice: 100,
      moOperationId: draftOp.id,
    });
    await purchaseService.createDispatch(
      draft.id,
      { rows: [{ rowId: draftRow.id, quantity: 2, parcels: 1 }] },
      f.user.id,
    );

    await purchaseService.receiveGoods(
      f.order.id,
      f.plainRow.id,
      { quantity: 5 },
      f.user.id,
    );
    expect((await purchaseService.getPurchaseOrder(f.order.id))!.status).toBe(
      "partially_received",
    );
    await purchaseService.createDispatch(
      f.order.id,
      { rows: [{ rowId: f.legoRow.id, quantity: 1, parcels: 1 }] },
      f.user.id,
    );

    await purchaseService.receiveGoods(
      f.order.id,
      f.legoRow.id,
      { quantity: 10 },
      f.user.id,
    );
    expect((await purchaseService.getPurchaseOrder(f.order.id))!.status).toBe(
      "received",
    );
    await expect(
      purchaseService.createDispatch(
        f.order.id,
        { rows: [{ rowId: f.legoRow.id, quantity: 1, parcels: 1 }] },
        f.user.id,
      ),
    ).rejects.toThrow(InvalidStatusTransitionError);
    await purchaseService.cancel(draft.id);
    await expect(
      purchaseService.createDispatch(
        draft.id,
        { rows: [{ rowId: draftRow.id, quantity: 1, parcels: 1 }] },
        f.user.id,
      ),
    ).rejects.toThrow(InvalidStatusTransitionError);
  });

  it("answers purchase-order-not-found for an unknown order (not row-not-found)", async () => {
    const f = await makeFixture();
    await expect(
      purchaseService.createDispatch(
        crypto.randomUUID(),
        { rows: [{ rowId: f.legoRow.id, quantity: 1, parcels: 1 }] },
        f.user.id,
      ),
    ).rejects.toThrow(PurchaseOrderNotFoundError);
  });

  it("blocks deleting a row with a live dispatch (409) and takes the undone log along when the row goes", async () => {
    const f = await makeFixture();
    const dispatch = await purchaseService.createDispatch(
      f.order.id,
      { rows: [{ rowId: f.legoRow.id, quantity: 4, parcels: 1 }] },
      f.user.id,
    );
    await expect(
      purchaseService.deleteRow(f.order.id, f.legoRow.id, false),
    ).rejects.toThrow(PurchaseOrderRowHasDispatchesError);
    expect(await purchaseService.listRows(f.order.id)).toHaveLength(2);

    await purchaseService.undoDispatch(f.order.id, dispatch.id, f.user.id);
    await purchaseService.deleteRow(f.order.id, f.legoRow.id, false);
    expect(
      (await purchaseService.listRows(f.order.id)).map((r) => r.id),
    ).toEqual([f.plainRow.id]);
    // The undone dispatch had no other rows, so it is gone from the log too.
    expect(await purchaseService.listDispatches(f.order.id)).toEqual([]);
    expect(await db.select().from(purchaseOrderDispatches)).toHaveLength(0);
  });

  it("the schema refuses an empty list, duplicate rows, zero quantity and zero parcels", () => {
    const rowId = crypto.randomUUID();
    expect(createPurchaseDispatchSchema.safeParse({ rows: [] }).success).toBe(
      false,
    );
    expect(
      createPurchaseDispatchSchema.safeParse({
        rows: [
          { rowId, quantity: 1 },
          { rowId, quantity: 2 },
        ],
      }).success,
    ).toBe(false);
    expect(
      createPurchaseDispatchSchema.safeParse({ rows: [{ rowId, quantity: 0 }] })
        .success,
    ).toBe(false);
    // A positive quantity below the column's 4 decimals would round to 0.
    expect(
      createPurchaseDispatchSchema.safeParse({
        rows: [{ rowId, quantity: 0.00004 }],
      }).success,
    ).toBe(false);
    expect(
      createPurchaseDispatchSchema.safeParse({
        rows: [{ rowId, quantity: 0.0001 }],
      }).success,
    ).toBe(true);
    expect(
      createPurchaseDispatchSchema.safeParse({
        rows: [{ rowId, quantity: 1, parcels: 0 }],
      }).success,
    ).toBe(false);
    const ok = createPurchaseDispatchSchema.parse({
      rows: [{ rowId, quantity: "2.5" }],
    });
    expect(ok.rows[0]).toEqual({ rowId, quantity: 2.5, parcels: 1 });
  });
});

describe("Ångra avsändning (undoDispatch)", () => {
  it("stamps the dispatch, lowers Skickat and refuses a second undo and a foreign dispatch", async () => {
    const f = await makeFixture();
    const first = await purchaseService.createDispatch(
      f.order.id,
      { rows: [{ rowId: f.legoRow.id, quantity: 4, parcels: 1 }] },
      f.user.id,
    );
    await purchaseService.createDispatch(
      f.order.id,
      { rows: [{ rowId: f.legoRow.id, quantity: 6, parcels: 1 }] },
      f.user.id,
    );
    expect(
      rowOf(await purchaseService.listRows(f.order.id), f.legoRow.id)
        .quantityDispatched,
    ).toBe("10.0000");

    const undone = await purchaseService.undoDispatch(
      f.order.id,
      first.id,
      f.user.id,
    );
    expect(undone.undoneAt).not.toBeNull();
    expect(
      rowOf(await purchaseService.listRows(f.order.id), f.legoRow.id)
        .quantityDispatched,
    ).toBe("6.0000");
    const [legoPurchases] = (await mfgService.listLegoPurchases(f.mo.id))!;
    expect(legoPurchases!.purchaseOrders[0]!.dispatchedQuantity).toBe(6);
    const log = await purchaseService.listDispatches(f.order.id);
    expect(
      log.map((d) => [
        d.rows[0]!.quantity,
        d.undoneAt !== null,
        d.undoneByName,
      ]),
    ).toEqual([
      [6, false, null],
      [4, true, "Inköparen"],
    ]);

    await expect(
      purchaseService.undoDispatch(f.order.id, first.id, f.user.id),
    ).rejects.toThrow(PurchaseDispatchAlreadyUndoneError);
    const other = await makeFixture();
    await expect(
      purchaseService.undoDispatch(other.order.id, first.id, f.user.id),
    ).rejects.toThrow(PurchaseDispatchNotFoundError);

    // No status guard: the log can be corrected on a received order.
    await purchaseService.receiveGoods(
      f.order.id,
      f.plainRow.id,
      { quantity: 5 },
      f.user.id,
    );
    await purchaseService.receiveGoods(
      f.order.id,
      f.legoRow.id,
      { quantity: 10 },
      f.user.id,
    );
    const [live] = log;
    await purchaseService.undoDispatch(f.order.id, live!.id, f.user.id);
    expect(
      rowOf(await purchaseService.listRows(f.order.id), f.legoRow.id)
        .quantityDispatched,
    ).toBe("0");
  });
});

describe("Pallkort till legoleverantör", () => {
  it("prints supplier, surface treatment, colour, IO number, TO reference and the deliver-to address, one card per parcel", async () => {
    const f = await makeFixture({ supplierDeliveryAddress: true });
    await testSystemService.updateSettings({ palletCardCode: "barcode" });
    const dispatch = await purchaseService.createDispatch(
      f.order.id,
      { rows: [{ rowId: f.legoRow.id, quantity: 10, parcels: 2 }] },
      f.user.id,
    );

    const { filename, pdf } = await purchaseService.dispatchPalletCardPdf(
      f.order.id,
      dispatch.id,
    );
    expect(filename).toBe(`pallkort-${f.order.orderNumber}.pdf`);
    expect(pdfPageCount(pdf)).toBe(2);
    const text = pdfText(pdf);
    for (const part of [
      "PALLKORT",
      "TILL LEGOLEVERANTÖR",
      f.parent.articleNumber,
      "Legodetalj",
      "5 st",
      "Kolli 1 av 2",
      "Kolli 2 av 2",
      "LEGOLEVERANTÖR",
      "Ytbehandling AB",
      // The supplier's default delivery address, not its own.
      "Godsgatan 9",
      "333 33 Godsstaden",
      "FÄRDIGT GODS LEVERERAS TILL",
      // No address on the order and no godsadress: the company's address.
      "Testbolaget AB",
      "Fabriksgatan 1",
      "111 11 Fabriksstaden",
      "YTBEHANDLING",
      "Förzinkad",
      "FÄRG",
      "RAL 9010",
      "INKÖPSORDER",
      f.order.orderNumber,
      "TILLVERKNINGSORDER",
      `${f.mo.orderNumber} · Op 20 · Lackering`,
      "SKICKAT AV",
      "Inköparen",
      "REFERENS",
    ]) {
      expect(text, part).toContain(part);
    }
    expect(text).not.toContain("Lackvägen 3");
    expect(text).not.toContain("RAPPORTERAD AV");
    // Code 128 bars for the article number and the IO number on each card.
    expect(pdfRectCount(pdf)).toBeGreaterThan(40);
    // The frame ends above the fold (half the A4 height) on every page.
    for (const frame of pdfRects(pdf).filter(
      (r) => r.width > 400 && r.height > 100,
    )) {
      expect(frame.y + frame.height).toBeLessThanOrEqual(841.89 / 2);
    }
  });

  it("uses the IO's own delivery address, then the company's godsadress, and shows a dash for missing article attributes", async () => {
    const f = await makeFixture();
    await db.update(companyInfo).set({
      deliveryAddress: "Godsmottagningen 2",
      deliveryPostalCode: "555 55",
      deliveryCity: "Godsorten",
    });
    await db.update(purchaseOrderDispatches).set({ note: null });
    const dispatch = await purchaseService.createDispatch(
      f.order.id,
      { rows: [{ rowId: f.legoRow.id, quantity: 10, parcels: 1 }] },
      f.user.id,
    );
    let text = pdfText(
      (await purchaseService.dispatchPalletCardPdf(f.order.id, dispatch.id))
        .pdf,
    );
    expect(text).toContain("Testbolaget AB");
    expect(text).toContain("Godsmottagningen 2");
    expect(text).toContain("555 55 Godsorten");
    // (The company's own address stays in the page header.)
    // The supplier has no delivery address: its own address is printed.
    expect(text).toContain("Lackvägen 3");

    await purchaseService.updatePurchaseOrderHeader(f.order.id, {
      deliveryAddress: {
        name: "Kund AB",
        address: "Byggvägen 5",
        postalCode: "444 44",
        city: "Byggstaden",
        country: "NO",
      },
    });
    text = pdfText(
      (await purchaseService.dispatchPalletCardPdf(f.order.id, dispatch.id))
        .pdf,
    );
    expect(text).toContain("Kund AB");
    expect(text).toContain("Byggvägen 5");
    expect(text).toContain("444 44 Byggstaden");
    expect(text).toContain("Norge");
    expect(text).not.toContain("Godsmottagningen 2");

    await articleService.updateArticle(f.parent.id, {
      surfaceTreatment: null,
      colour: null,
    });
    text = pdfText(
      (await purchaseService.dispatchPalletCardPdf(f.order.id, dispatch.id))
        .pdf,
    );
    expect(text).not.toContain("Förzinkad");
    expect(text).toContain("YTBEHANDLING");
    expect(text).toContain("—");
  });

  it("takes the dialog's selection (row=<dispatchRowId>:<antal>,…), skips an empty list and refuses a foreign row", async () => {
    const f = await makeFixture();
    const dispatch = await purchaseService.createDispatch(
      f.order.id,
      { rows: [{ rowId: f.legoRow.id, quantity: 10, parcels: 4 }] },
      f.user.id,
    );
    const [rowId] = dispatch.rows.map((r) => r.id);

    const rows = await purchaseService.dispatchRows(f.order.id, dispatch.id);
    expect(rows.orderNumber).toBe(f.order.orderNumber);
    expect(rows.rows).toEqual([
      {
        id: rowId,
        articleNumber: f.parent.articleNumber,
        articleName: "Legodetalj",
        quantity: 10,
        unit: "st",
        parcels: 4,
      },
    ]);

    // Omitted: the dispatched quantity split evenly over the parcels.
    expect(
      pdfPageCount(
        (await purchaseService.dispatchPalletCardPdf(f.order.id, dispatch.id))
          .pdf,
      ),
    ).toBe(4);
    const text = pdfText(
      (await purchaseService.dispatchPalletCardPdf(f.order.id, dispatch.id))
        .pdf,
    );
    expect(text).toMatch(/2,50? st/);
    expect(text).toContain("Kolli 4 av 4");

    const { row } = dispatchPalletCardQuerySchema.parse({
      row: `${rowId}:6,4`,
    });
    const picked = await purchaseService.dispatchPalletCardPdf(
      f.order.id,
      dispatch.id,
      row,
    );
    expect(pdfPageCount(picked.pdf)).toBe(2);
    expect(pdfText(picked.pdf)).toContain("6 st");
    expect(pdfText(picked.pdf)).toContain("4 st");

    expect(
      dispatchPalletCardQuerySchema.safeParse({ row: `${rowId}:` }).success,
    ).toBe(false);
    await expect(
      purchaseService.dispatchPalletCardPdf(f.order.id, dispatch.id, [
        { dispatchRowId: crypto.randomUUID(), quantities: [1] },
      ]),
    ).rejects.toThrow(PurchaseDispatchRowNotInDispatchError);

    await purchaseService.undoDispatch(f.order.id, dispatch.id, f.user.id);
    await expect(
      purchaseService.dispatchPalletCardPdf(f.order.id, dispatch.id),
    ).rejects.toThrow(PurchaseDispatchUndoneError);
    await expect(
      purchaseService.dispatchPalletCardPdf(f.order.id, crypto.randomUUID()),
    ).rejects.toThrow(PurchaseDispatchNotFoundError);
  });

  it("ends above the fold with a QR code and three-line foreign addresses on both sides", async () => {
    const f = await makeFixture();
    await testSystemService.updateSettings({ palletCardCode: "qr" });
    await purchaseService.updateSupplier(f.supplier.id, {
      country: "DE",
      address: "Lackstraße 3\nTor 4",
      city: "Lackstadt",
    });
    await purchaseService.updatePurchaseOrderHeader(f.order.id, {
      deliveryAddress: {
        name: "Kunden Med Ett Mycket Långt Företagsnamn AB",
        address: "Leveransgatan 99, Godsmottagningen hus B",
        postalCode: "987 65",
        city: "Kundstaden",
        country: "NO",
      },
    });
    const dispatch = await purchaseService.createDispatch(
      f.order.id,
      { rows: [{ rowId: f.legoRow.id, quantity: 10, parcels: 1 }] },
      f.user.id,
    );
    const { pdf } = await purchaseService.dispatchPalletCardPdf(
      f.order.id,
      dispatch.id,
    );
    const text = pdfText(pdf);
    expect(text).toContain("Tyskland");
    expect(text).toContain("Norge");
    const frames = pdfRects(pdf).filter((r) => r.width > 400 && r.height > 100);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.y + frames[0]!.height).toBeLessThanOrEqual(841.89 / 2);
  });

  it("prints the card in the supplier's language", async () => {
    const f = await makeFixture({ language: "en" });
    await db.update(units).set({ codeEn: "pcs" }).where(eq(units.code, "st"));
    const dispatch = await purchaseService.createDispatch(
      f.order.id,
      { rows: [{ rowId: f.legoRow.id, quantity: 10, parcels: 1 }] },
      f.user.id,
    );
    const { filename, pdf } = await purchaseService.dispatchPalletCardPdf(
      f.order.id,
      dispatch.id,
    );
    expect(filename).toBe(`Pallet-card-${f.order.orderNumber}.pdf`);
    const text = pdfText(pdf);
    for (const part of [
      "PALLET CARD",
      "TO SUBCONTRACTOR",
      "SUBCONTRACTOR",
      "SURFACE TREATMENT",
      "COLOUR",
      "PURCHASE ORDER",
      "MANUFACTURING ORDER",
      "DELIVER FINISHED GOODS TO",
      "DISPATCHED BY",
      "Parcel 1 of 1",
      "Subcontract part",
      "10 pcs",
    ]) {
      expect(text, part).toContain(part);
    }
    for (const swedish of [
      "PALLKORT",
      "LEGOLEVERANTÖR",
      "YTBEHANDLING",
      "FÄRG",
      "INKÖPSORDER",
      "Kolli",
      "Legodetalj",
      "SKICKAT AV",
    ]) {
      expect(text, swedish).not.toContain(swedish);
    }
  });

  it("splitOverParcels divides evenly with the remainder on the last parcel", () => {
    expect(splitOverParcels(10, 3)).toEqual([3.3333, 3.3333, 3.3334]);
    expect(splitOverParcels(10, 1)).toEqual([10]);
    expect(splitOverParcels(7, 2)).toEqual([3.5, 3.5]);
  });
});

describe("the dispatch routes (inject, real service)", () => {
  function app(userId: string) {
    const server = Fastify();
    server.setErrorHandler((err, _req, reply) => {
      if (err instanceof ZodError)
        return reply
          .code(400)
          .send({ error: "Validation failed", code: "validation-failed" });
      throw err;
    });
    server.addHook("preHandler", async (req) => {
      req.user = { id: userId, role: "admin" } as never;
    });
    server.register(purchaseRoutes, { service: purchaseService });
    return server;
  }

  it("201 with the dispatch, 400 for a non-lego row, 404 for a foreign row, 409 for a closed order; undo 409 twice; pallet card 409 when undone", async () => {
    const f = await makeFixture();
    const server = app(f.user.id);
    const created = await server.inject({
      method: "POST",
      url: `/purchase-orders/${f.order.id}/dispatches`,
      payload: { rows: [{ rowId: f.legoRow.id, quantity: 4, parcels: 2 }] },
    });
    expect(created.statusCode).toBe(201);
    const dispatchId = created.json().id as string;
    expect(created.json().rows[0]).toMatchObject({
      purchaseOrderRowId: f.legoRow.id,
      quantity: "4.0000",
      parcels: 2,
    });

    const notLego = await server.inject({
      method: "POST",
      url: `/purchase-orders/${f.order.id}/dispatches`,
      payload: { rows: [{ rowId: f.plainRow.id, quantity: 1 }] },
    });
    expect(notLego.statusCode).toBe(400);
    expect(notLego.json().code).toBe("purchase-dispatch-row-not-lego");
    const foreign = await server.inject({
      method: "POST",
      url: `/purchase-orders/${f.order.id}/dispatches`,
      payload: { rows: [{ rowId: crypto.randomUUID(), quantity: 1 }] },
    });
    expect(foreign.statusCode).toBe(404);
    const empty = await server.inject({
      method: "POST",
      url: `/purchase-orders/${f.order.id}/dispatches`,
      payload: { rows: [] },
    });
    expect(empty.statusCode).toBe(400);

    const order = await server.inject({
      method: "GET",
      url: `/purchase-orders/${f.order.id}/rows`,
    });
    expect(
      order.json().find((r: { id: string }) => r.id === f.legoRow.id)
        .quantityDispatched,
    ).toBe("4.0000");

    const log = await server.inject({
      method: "GET",
      url: `/purchase-orders/${f.order.id}/dispatches`,
    });
    expect(log.statusCode).toBe(200);
    expect(log.json()[0].rows[0]).toMatchObject({
      quantity: 4,
      unit: "st",
      parcels: 2,
    });

    const rows = await server.inject({
      method: "GET",
      url: `/purchase-orders/${f.order.id}/dispatches/${dispatchId}/rows`,
    });
    expect(rows.json().rows[0]).toMatchObject({ quantity: 4, parcels: 2 });
    const card = await server.inject({
      method: "GET",
      url: `/purchase-orders/${f.order.id}/dispatches/${dispatchId}/pallet-card?row=${rows.json().rows[0].id}:2,2`,
    });
    expect(card.statusCode).toBe(200);
    expect(card.headers["content-type"]).toBe("application/pdf");
    expect(card.headers["content-disposition"]).toContain(
      `pallkort-${f.order.orderNumber}.pdf`,
    );
    const badSelection = await server.inject({
      method: "GET",
      url: `/purchase-orders/${f.order.id}/dispatches/${dispatchId}/pallet-card?row=${crypto.randomUUID()}:1`,
    });
    expect(badSelection.statusCode).toBe(400);

    const undone = await server.inject({
      method: "POST",
      url: `/purchase-orders/${f.order.id}/dispatches/${dispatchId}/undo`,
    });
    expect(undone.statusCode).toBe(200);
    const twice = await server.inject({
      method: "POST",
      url: `/purchase-orders/${f.order.id}/dispatches/${dispatchId}/undo`,
    });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().code).toBe("purchase-dispatch-already-undone");
    const wrongOrder = await server.inject({
      method: "POST",
      url: `/purchase-orders/${crypto.randomUUID()}/dispatches/${dispatchId}/undo`,
    });
    expect(wrongOrder.statusCode).toBe(404);
    const undoneCard = await server.inject({
      method: "GET",
      url: `/purchase-orders/${f.order.id}/dispatches/${dispatchId}/pallet-card`,
    });
    expect(undoneCard.statusCode).toBe(409);
    expect(undoneCard.json().code).toBe("purchase-dispatch-undone");

    await purchaseService.receiveGoods(
      f.order.id,
      f.plainRow.id,
      { quantity: 5 },
      f.user.id,
    );
    await purchaseService.receiveGoods(
      f.order.id,
      f.legoRow.id,
      { quantity: 10 },
      f.user.id,
    );
    await purchaseService.close(f.order.id);
    const closed = await server.inject({
      method: "POST",
      url: `/purchase-orders/${f.order.id}/dispatches`,
      payload: { rows: [{ rowId: f.legoRow.id, quantity: 1 }] },
    });
    expect(closed.statusCode).toBe(409);
    expect(closed.json().code).toBe("invalid-status-transition");
  });
});

// Batch (#8, decision 17): the TO number is the batch the finished goods are
// received in — printed on the lego card when the TO's article is batchstyrd.
describe("Pallkort till legoleverantör — batch", () => {
  it("prints the TO number as BATCH only for a batchstyrd article, in the bottom row so the card still ends above the fold", async () => {
    const f = await makeFixture({ supplierDeliveryAddress: true });
    const dispatch = await purchaseService.createDispatch(
      f.order.id,
      { rows: [{ rowId: f.legoRow.id, quantity: 10, parcels: 1 }] },
      f.user.id,
    );
    const card = async () => (await purchaseService.dispatchPalletCardPdf(f.order.id, dispatch.id)).pdf;

    const before = await card();
    expect(pdfText(before)).not.toContain("BATCH");
    const frameOf = (pdf: Buffer) => pdfRects(pdf).filter((r) => r.width > 400 && r.height > 100)[0]!;

    // Straight on the row: the flag's own rules (the setting) are not this test's.
    await db.update(articles).set({ batchTracked: true }).where(eq(articles.id, f.parent.id));
    const after = await card();
    const text = pdfText(after);
    expect(text).toContain("BATCH");
    // The number itself: once in the TO reference, once as the batch.
    expect(text.split(f.mo.orderNumber).length - 1).toBe(2);
    expect(frameOf(after).height).toBe(frameOf(before).height);
    expect(frameOf(after).y + frameOf(after).height).toBeLessThanOrEqual(841.89 / 2);
  });
});
