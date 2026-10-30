import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { pdfRectCount, pdfText } from "./helpers/pdf.js";

// Skanning, etapp 2 och 3 (#4) — what Inleverans and Utleverans need from
// the API: the receivable orders holding an open row of a scanned article
// (openArticleId), the article type on the IO rows (a tjänst is not counted),
// and the order number as a Code 128 on the purchase order and the
// plocklista.

const TRUNCATE = sql`TRUNCATE sales_orders, customers, purchase_orders, suppliers, stock_transactions, stock_locations, warehouses, articles, audit_log, users CASCADE`;
const PASSWORD = "ett-tillräckligt-långt-lösenord";

let app: ReturnType<typeof buildApp>;
let admin: string;

const cookieOf = (res: { cookies: { name: string; value: string }[] }) => res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
const call = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: { cookie: admin }, ...(payload === undefined ? {} : { payload: payload as never }) });

beforeEach(async () => {
  await db.execute(TRUNCATE);
  app = buildApp();
  await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: "admin@example.com", password: PASSWORD, name: "Admin", setupCode: app.setup.code.code },
  });
  admin = cookieOf(await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@example.com", password: PASSWORD } }));
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeArticle(articleNumber: string) {
  const res = await call("POST", "/articles", { articleNumber, name: `Artikel ${articleNumber}`, type: "purchased", unit: "st", active: true });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

async function makeOrder(supplierId: string, rows: { articleId: string; quantity: number }[], confirm = true) {
  const order = (await call("POST", "/purchase-orders", { supplierId })).json() as { id: string; orderNumber: string };
  const created = [];
  for (const row of rows) {
    const res = await call("POST", `/purchase-orders/${order.id}/rows`, { ...row, unitPrice: 10 });
    expect(res.statusCode).toBe(201);
    created.push(res.json() as { id: string });
  }
  if (confirm) expect((await call("POST", `/purchase-orders/${order.id}/confirm`)).statusCode).toBe(200);
  return { ...order, rows: created };
}

const RECEIVABLE = "status=confirmed,partially_received&withOpenRows=true";

describe("Inleverans: receivable orders for a scanned article", () => {
  it("lists only orders where the article's row is still short", async () => {
    const supplier = (await call("POST", "/suppliers", { name: "Skruvgrossen AB", active: true })).json() as { id: string };
    const screw = await makeArticle("SK-1");
    const nut = await makeArticle("SK-2");

    const open = await makeOrder(supplier.id, [{ articleId: screw.id, quantity: 10 }]);
    // The screw row is received in full; only the nut is still open here.
    const screwDone = await makeOrder(supplier.id, [
      { articleId: screw.id, quantity: 5 },
      { articleId: nut.id, quantity: 5 },
    ]);
    expect((await call("POST", `/purchase-orders/${screwDone.id}/rows/${screwDone.rows[0]!.id}/receive`, { quantity: 5 })).statusCode).toBe(201);
    // Not yet confirmed — not receivable.
    await makeOrder(supplier.id, [{ articleId: screw.id, quantity: 3 }], false);

    const forScrew = (await call("GET", `/purchase-orders?${RECEIVABLE}&openArticleId=${screw.id}`)).json();
    expect(forScrew.rows.map((o: { id: string }) => o.id)).toEqual([open.id]);
    expect(forScrew.total).toBe(1);

    const forNut = (await call("GET", `/purchase-orders?${RECEIVABLE}&openArticleId=${nut.id}`)).json();
    expect(forNut.rows.map((o: { id: string }) => o.id)).toEqual([screwDone.id]);
    expect(forNut.rows[0].openRowCount).toBe(1);

    expect((await call("GET", `/purchase-orders?openArticleId=inte-ett-id`)).statusCode).toBe(400);
  });

  it("tells a tjänst apart on the IO rows", async () => {
    const supplier = (await call("POST", "/suppliers", { name: "Skruvgrossen AB", active: true })).json() as { id: string };
    const screw = await makeArticle("SK-1");
    const freight = (
      await call("POST", "/articles", { articleNumber: "FRAKT", name: "Frakt", type: "service", unit: "st", active: true })
    ).json() as { id: string };
    const order = await makeOrder(supplier.id, [
      { articleId: screw.id, quantity: 10 },
      { articleId: freight.id, quantity: 1 },
    ]);
    const rows = (await call("GET", `/purchase-orders/${order.id}/rows`)).json() as { articleId: string; articleType: string }[];
    expect(Object.fromEntries(rows.map((r) => [r.articleId, r.articleType]))).toEqual({
      [screw.id]: "purchased",
      [freight.id]: "service",
    });
  });
});

describe("Streckkoden på inköpsordern och plocklistan", () => {
  it("carries the order number as a barcode beside the title", async () => {
    const supplier = (await call("POST", "/suppliers", { name: "Skruvgrossen AB", active: true })).json() as { id: string };
    const screw = await makeArticle("SK-1");
    const order = await makeOrder(supplier.id, [{ articleId: screw.id, quantity: 10 }]);

    const res = await call("GET", `/purchase-orders/${order.id}/pdf`);
    expect(res.statusCode).toBe(200);
    expect(pdfText(res.rawPayload)).toContain(order.orderNumber);
    // The bars of one Code 128 symbol: a layout without codes draws only a
    // handful of rectangles.
    expect(pdfRectCount(res.rawPayload)).toBeGreaterThan(30);
  });

  it("puts the order number as a barcode on the plocklista too", async () => {
    const customer = (await call("POST", "/customers", { name: "Kök & Bad AB", active: true })).json() as { id: string };
    const screw = await makeArticle("SK-1");
    const res = await call("POST", "/quotes", { customerId: customer.id, confirm: true, rows: [{ articleId: screw.id, quantity: 4, unitPrice: 10 }] });
    expect(res.statusCode).toBe(201);
    const { order } = res.json() as { order: { id: string; orderNumber: string } };

    const pickList = await call("GET", `/sales-orders/${order.id}/pick-list`);
    expect(pickList.statusCode).toBe(200);
    expect(pdfText(pickList.rawPayload)).toContain(`Plocklista ${order.orderNumber}`);
    expect(pdfRectCount(pickList.rawPayload)).toBeGreaterThan(30);
  });

  it("draws the bars only when asked, and nothing for a number Code 128 cannot hold", async () => {
    const pdf = createDocumentPdfService({ getCompanyInfo: async () => ({ name: "Navet Verkstad AB" }) as never, getLogo: async () => null });
    const document = {
      title: "Inköpsorder",
      documentNumber: "IO2600123",
      date: new Date("2026-10-29T12:00:00Z"),
      partnerLabel: "Leverantör",
      partner: { name: "Skruvgrossen AB", address: null, postalCode: null, city: null },
      currency: "SEK",
      rows: [{ articleNumber: "SK-1", articleName: "Skruv", quantity: "10", unit: "st", unitPrice: "1" }],
      showTotal: true,
    };
    const plain = pdfRectCount(await pdf.render(document));
    const coded = pdfRectCount(await pdf.render({ ...document, documentNumberBarcode: true }));
    expect(coded - plain).toBeGreaterThan(30);
    const unencodable = pdfRectCount(await pdf.render({ ...document, documentNumber: "IÖ-1", documentNumberBarcode: true }));
    expect(unencodable).toBe(plain);
  });
});
