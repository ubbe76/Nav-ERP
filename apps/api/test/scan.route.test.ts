import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createImportRepository } from "../src/modules/import/repository/import.repository.js";
import { createImportService } from "../src/modules/import/service/import.service.js";
import { pdfPageCount, pdfText } from "./helpers/pdf.js";

// Skanning, etapp 1 (#4) through the real app: Streckkod (EAN) on the
// article, the lagerplats label code, GET /scan and the label PDFs.

const TRUNCATE = sql`TRUNCATE purchase_orders, suppliers, stock_transactions, stock_locations, warehouses, articles, audit_log, users CASCADE`;
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

async function makeArticle(articleNumber: string, barcode?: string) {
  const res = await call("POST", "/articles", { articleNumber, name: `Artikel ${articleNumber}`, type: "purchased", unit: "st", active: true, barcode });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; barcode: string | null };
}

async function makeLocation(name: string) {
  const warehouse = (await call("POST", "/stock/warehouses", { name: "Huvudlager", active: true })).json();
  const location = (await call("POST", "/stock/locations", { warehouseId: warehouse.id, name, active: true })).json();
  const listed = (await call("GET", "/stock/locations")).json() as { id: string; labelCode: string }[];
  return { id: location.id as string, labelCode: listed.find((l) => l.id === location.id)!.labelCode };
}

describe("Streckkod (EAN) on the article", () => {
  it("is stored, validated and unique", async () => {
    const article = await makeArticle("PL-1", " 7350000000016 ");
    expect(article.barcode).toBe("7350000000016");

    const invalid = await call("POST", "/articles", { articleNumber: "PL-2", name: "x", type: "purchased", unit: "st", active: true, barcode: "7350000000017" });
    expect(invalid.statusCode).toBe(400);

    const taken = await call("POST", "/articles", { articleNumber: "PL-3", name: "x", type: "purchased", unit: "st", active: true, barcode: "7350000000016" });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().code).toBe("duplicate-article-barcode");

    const other = await makeArticle("PL-4");
    const patch = await call("PATCH", `/articles/${other.id}`, { barcode: "7350000000016" });
    expect(patch.statusCode).toBe(409);
    expect(patch.json().code).toBe("duplicate-article-barcode");

    expect((await call("PATCH", `/articles/${article.id}`, { barcode: "" })).json().barcode).toBeNull();
  });

  it("is read and checked by the article import", async () => {
    await makeArticle("PL-5", "7350000000016");
    const imports = createImportService(createImportRepository(db));
    const preview = await imports.preview("articles", {
      mapping: { Artikelnummer: "articleNumber", Benämning: "name", EAN: "barcode" },
      rows: [
        ["NY-1", "Ny", "96385074"],
        ["NY-2", "Ny", "96385074"],
        ["NY-3", "Ny", "7350000000016"],
        ["NY-4", "Ny", "12345"],
      ],
    });
    expect(preview.rows.map((r) => r.errors)).toEqual([
      [],
      ["Streckkoden 96385074 står också på artikel NY-1 i filen"],
      ["Streckkoden 7350000000016 finns redan på artikel PL-5"],
      ['Ogiltig streckkod "12345" — 8, 12, 13 eller 14 siffror med rätt kontrollsiffra'],
    ]);
  });
});

describe("GET /scan", () => {
  it("finds an article by EAN and by number, a location by its label code and an order by its number", async () => {
    const article = await makeArticle("PL-10", "7350000000016");
    const location = await makeLocation("A1");
    expect(location.labelCode).toMatch(/^LP\d{4,}$/);
    const supplier = (await call("POST", "/suppliers", { name: "Lev AB", active: true })).json();
    const order = (await call("POST", "/purchase-orders", { supplierId: supplier.id })).json();

    const byEan = (await call("GET", "/scan?code=7350000000016")).json();
    expect(byEan.matches).toEqual([expect.objectContaining({ kind: "article", id: article.id, matchedBy: "barcode", articleNumber: "PL-10" })]);
    expect((await call("GET", "/scan?code=PL-10")).json().matches[0]).toMatchObject({ kind: "article", matchedBy: "articleNumber" });

    const byLabel = (await call("GET", `/scan?code=${location.labelCode.toLowerCase()}`)).json();
    expect(byLabel.matches).toEqual([
      expect.objectContaining({ kind: "location", id: location.id, labelCode: location.labelCode, name: "A1", warehouseName: "Huvudlager" }),
    ]);

    const byOrder = (await call("GET", `/scan?code=${encodeURIComponent(order.orderNumber)}`)).json();
    expect(byOrder.matches).toEqual([expect.objectContaining({ kind: "purchaseOrder", id: order.id, partyName: "Lev AB" })]);

    expect((await call("GET", "/scan?code=finns-inte")).json()).toEqual({ code: "finns-inte", matches: [] });
  });
});

describe("Etiketter", () => {
  it("prints article labels on an A4 sheet from a start position", async () => {
    const a = await makeArticle("PL-20", "7350000000016");
    const b = await makeArticle("PL-21");
    const res = await call("POST", "/articles/labels", { articleIds: [a.id, b.id], copies: 2, format: "a4", start: 24 });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    const pdf = res.rawPayload;
    // Starting at the sheet's last label: one label on page 1, three on page 2.
    expect(pdfPageCount(pdf)).toBe(2);
    const text = pdfText(pdf);
    expect(text).toContain("PL-20");
    expect(text).toContain("EAN 7350000000016");
  });

  it("prints lagerplats labels, one per page for a label printer", async () => {
    const location = await makeLocation("B7");
    const res = await call("POST", "/stock/locations/labels", { locationIds: [location.id], format: "single" });
    expect(res.statusCode).toBe(200);
    expect(pdfPageCount(res.rawPayload)).toBe(1);
    const text = pdfText(res.rawPayload);
    expect(text).toContain("B7");
    expect(text).toContain(location.labelCode);
  });
});
