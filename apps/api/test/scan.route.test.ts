import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { updateSystemSettingsSchema } from "@navet/shared";
import { db, stockBatches, systemSettings } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createImportRepository } from "../src/modules/import/repository/import.repository.js";
import { createImportService } from "../src/modules/import/service/import.service.js";
import { BATCH_TRACKING_ENABLED_KEY } from "../src/modules/stock/service/batch-tracking.js";
import { pdfPageCount, pdfText } from "./helpers/pdf.js";
import { parsed } from "./helpers/parsed.js";
import { testSystemService } from "./helpers/services.js";

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

const resetSetting = () => db.delete(systemSettings).where(eq(systemSettings.key, BATCH_TRACKING_ENABLED_KEY));

afterAll(async () => {
  await db.execute(TRUNCATE);
  await resetSetting();
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

    expect((await call("GET", "/scan?code=finns-inte")).json()).toEqual({ code: "finns-inte", matches: [], gs1: null });
    // An untracked article says so; an ordinary code carries no GS1 fields.
    expect(byEan.gs1).toBeNull();
    expect(byEan.matches[0].stockTracking).toBeNull();
  });
});

// GS1 (#8 etapp 2 steg 6): the server reads the code — the article on the
// GTIN inside it, what else the code said, and the batch or serienummer
// that already exists under the number.
describe("GET /scan with a GS1 code", () => {
  const GS = "%1D";
  const scan = async (code: string) => (await call("GET", `/scan?code=${code}`)).json();
  const text = (code: string) => scan(encodeURIComponent(code));

  async function tracked(articleNumber: string, tracking: "batch" | "serial", barcode?: string) {
    const res = await call("POST", "/articles", { articleNumber, name: `Artikel ${articleNumber}`, type: "purchased", unit: "st", active: true, tracking, barcode });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string };
  }
  async function stock(articleId: string, locationId: string, quantityDelta: number, batchNumber: string, expiresOn?: string) {
    const res = await call("POST", "/stock/transactions", { articleId, locationId, quantityDelta, batchNumber, expiresOn });
    expect(res.statusCode).toBe(201);
    const [row] = await db.select().from(stockBatches).where(sql`${stockBatches.articleId} = ${articleId} and ${stockBatches.batchNumber} = ${batchNumber}`);
    return row!.id;
  }

  beforeEach(async () => {
    await resetSetting();
    await testSystemService.updateSettings(parsed(updateSystemSettingsSchema, { batchTrackingEnabled: true }));
  });

  it("finds the article on the GTIN and answers the batch, the date and the batch's balance per place", async () => {
    // Stored as EAN-13; the code carries it as GTIN-14.
    const article = await tracked("GS-1", "batch", "7350000000016");
    const location = await makeLocation("A1");
    const batchId = await stock(article.id, location.id, 5, "LOT-1", "2027-03-01");

    const expected = {
      gs1: { gtin: "07350000000016", batch: "lot-1", serial: null, expiresOn: "2027-03-01", quantity: null },
      matches: [
        expect.objectContaining({ kind: "article", id: article.id, matchedBy: "barcode", stockTracking: "batch" }),
        {
          kind: "batch",
          id: batchId,
          batchNumber: "LOT-1",
          batchKind: "batch",
          articleId: article.id,
          articleNumber: "GS-1",
          articleName: "Artikel GS-1",
          expiresOn: "2027-03-01",
          quantityOnHand: 5,
          locations: [{ locationId: location.id, locationName: "A1", warehouseName: "Huvudlager", blocked: false, quantity: 5 }],
        },
      ],
    };
    // With parentheses, as an element string with the separator, with a
    // scanner's prefix — the same answer.
    expect(await text("(01)07350000000016(10)lot-1(17)270301")).toMatchObject(expected);
    expect(await scan(`010735000000001610lot-1${GS}17270301`)).toMatchObject(expected);
    expect(await scan(`%5DC101073500000000161727030110lot-1`)).toMatchObject(expected);

    // A batch the article does not have yet: the fields, the article — and nothing created.
    const fresh = await text("(01)07350000000016(10)NY-1(17)261200");
    expect(fresh.gs1).toEqual({ gtin: "07350000000016", batch: "NY-1", serial: null, expiresOn: "2026-12-31", quantity: null });
    expect(fresh.matches.map((m: { kind: string }) => m.kind)).toEqual(["article"]);
    expect(await db.select().from(stockBatches)).toHaveLength(1);
  });

  it("answers the fields but no match for a GTIN no article has, and nothing for a code that does not hold", async () => {
    const article = await tracked("GS-2", "batch", "7350000000016");
    const location = await makeLocation("A1");
    await stock(article.id, location.id, 5, "LOT-1");
    // Another GTIN: the batch number alone must not find GS-2's batch.
    expect(await text("(01)17350000000013(10)LOT-1")).toEqual({
      code: "(01)17350000000013(10)LOT-1",
      matches: [],
      gs1: { gtin: "17350000000013", batch: "LOT-1", serial: null, expiresOn: null, quantity: null },
    });
    // A wrong check digit: no GS1 reading at all (and no ordinary match).
    expect(await text("(01)07350000000017(10)LOT-1")).toMatchObject({ matches: [], gs1: null });
  });

  it("finds a serienummer — in the code's AI 21 and as the number itself — in every form of the GTIN", async () => {
    // Stored as UPC-A (12 digits); GS1 pads it to 14.
    const article = await tracked("GS-3", "serial", "036000291452");
    const location = await makeLocation("A1");
    const serialId = await stock(article.id, location.id, 1, "SN-0042");

    const byCode = await scan(`010003600029145221SN-0042`);
    expect(byCode.gs1).toMatchObject({ gtin: "00036000291452", serial: "SN-0042", batch: null });
    expect(byCode.matches).toEqual([
      expect.objectContaining({ kind: "article", id: article.id, stockTracking: "serial" }),
      expect.objectContaining({ kind: "batch", id: serialId, batchKind: "serial", batchNumber: "SN-0042", quantityOnHand: 1 }),
    ]);
    // Both a batch and a serienummer in the code: the serienummer is the one that exists.
    const both = await scan(`010003600029145210LOT-9${GS}21sn-0042`);
    expect(both.matches.filter((m: { kind: string }) => m.kind === "batch").map((m: { id: string }) => m.id)).toEqual([serialId]);
    // The number alone, as an ordinary code (the label printed in step 5).
    const plain = await scan("sn-0042");
    expect(plain.gs1).toBeNull();
    expect(plain.matches).toEqual([expect.objectContaining({ kind: "batch", id: serialId, articleNumber: "GS-3" })]);
    // A GS1 code without a GTIN finds it too.
    expect((await text("(21)SN-0042")).matches).toEqual([expect.objectContaining({ kind: "batch", id: serialId })]);
  });

  it("answers every article that has the number, and where each stands — a spärrad plats flagged, an empty one left out", async () => {
    const a = await tracked("GS-4", "batch");
    const b = await tracked("GS-5", "batch");
    const location = await makeLocation("A1");
    const other = (await call("POST", "/stock/locations", { warehouseId: (await call("GET", "/stock/warehouses")).json()[0].id, name: "B2", active: true })).json();
    const idA = await stock(a.id, location.id, 3, "LOT-7");
    await stock(a.id, other.id, 2, "LOT-7");
    const idB = await stock(b.id, location.id, 4, "LOT-7");
    // Everything of GS-5's batch taken out again: the batch is still found, with no place.
    expect((await call("POST", "/stock/transactions", { articleId: b.id, locationId: location.id, quantityDelta: -4, batchId: idB })).statusCode).toBe(201);
    expect((await call("POST", `/stock/locations/${other.id}/block`, {})).statusCode).toBe(200);

    const found = (await scan("LOT-7")).matches as { id: string; quantityOnHand: number; locations: { locationName: string; blocked: boolean; quantity: number }[] }[];
    expect(found.map((m) => [m.id, m.quantityOnHand])).toEqual([
      [idA, 5],
      [idB, 0],
    ]);
    // (Spärra moved B2 to the spärrlagret, which sorts first.)
    expect(found[0]!.locations.map((l) => [l.locationName, l.blocked, l.quantity])).toEqual([
      ["B2", true, 2],
      ["A1", false, 3],
    ]);
    expect(found[1]!.locations).toEqual([]);
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
