import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { updateSystemSettingsSchema } from "@navet/shared";
import { db, systemSettings } from "@navet/db";
import { buildApp } from "../src/app.js";
import { BATCH_TRACKING_ENABLED_KEY } from "../src/modules/stock/service/batch-tracking.js";
import { pdfRectCount, pdfText } from "./helpers/pdf.js";
import { parsed } from "./helpers/parsed.js";
import { testSystemService } from "./helpers/services.js";
// The web rule has no imports, so vitest loads it directly.
import { resolveCountScan } from "../../web/lib/countScan.js";

// Skanning, etapp 4 (#4) — what Inventering needs from the API: a place's
// counts (locationId), the place's label code on the count, and that code as
// a barcode on the räknelista.

const TRUNCATE = sql`TRUNCATE stock_count_sessions, stock_transactions, stock_locations, warehouses, articles, audit_log, users CASCADE`;
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

async function makeLocations() {
  const warehouse = (await call("POST", "/stock/warehouses", { name: "Huvudlager", active: true })).json() as { id: string };
  const a = (await call("POST", "/stock/locations", { warehouseId: warehouse.id, name: "A-01", active: true })).json() as { id: string };
  const b = (await call("POST", "/stock/locations", { warehouseId: warehouse.id, name: "B-02", active: true })).json() as { id: string };
  const listed = (await call("GET", "/stock/locations")).json() as { id: string; labelCode: string }[];
  return { a: { ...a, labelCode: listed.find((l) => l.id === a.id)!.labelCode }, b };
}

describe("Inventering: a scanned lagerplats", () => {
  it("finds the place's own counts, with its label code on the count", async () => {
    const { a, b } = await makeLocations();
    const countA = (await call("POST", "/stock-counts", { locationId: a.id, blocksTransactions: false })).json() as { id: string };
    await call("POST", "/stock-counts", { locationId: b.id, blocksTransactions: false });

    const forA = (await call("GET", `/stock-counts?locationId=${a.id}&status=open`)).json();
    expect(forA.rows.map((r: { id: string }) => r.id)).toEqual([countA.id]);
    expect(forA.total).toBe(1);
    await call("POST", `/stock-counts/${countA.id}/cancel`);
    expect((await call("GET", `/stock-counts?locationId=${a.id}&status=open`)).json().total).toBe(0);

    const detail = (await call("GET", `/stock-counts/${countA.id}`)).json();
    expect(detail.locationLabelCode).toBe(a.labelCode);
    expect(detail).not.toHaveProperty("locationLabelNumber");
  });

  it("prints the place's label code as a barcode on the räknelista", async () => {
    const { a } = await makeLocations();
    const count = (await call("POST", "/stock-counts", { locationId: a.id, blocksTransactions: false })).json() as { id: string; countNumber: string };
    const res = await call("GET", `/stock-counts/${count.id}/pdf`);
    expect(res.statusCode).toBe(200);
    expect(pdfText(res.rawPayload)).toContain(`Räknelista ${count.countNumber}`);
    // A Code 128 symbol draws three bars per character plus start, check and
    // stop (LP0001: 28); the sheet itself draws no rectangles.
    expect(pdfRectCount(res.rawPayload)).toBeGreaterThanOrEqual(20);
  });
});

// GS1 (#8 etapp 2 steg 6): the count sheet's rows and GET /scan's answer are
// what the web rule (resolveCountScan) joins — run here against the real
// answers, with the calls the page then makes.
describe("Inventering: a scanned batch or serienummer", () => {
  const scan = async (code: string) => (await call("GET", `/scan?code=${encodeURIComponent(code)}`)).json();
  type SheetRow = { id: string; articleId: string; batchId: string | null; batchNumber: string | null; batchKind: "batch" | "serial" | null; countedQuantity: string | null; snapshotQuantity: string };
  const sheet = async (id: string) => {
    const detail = (await call("GET", `/stock-counts/${id}`)).json() as { locationId: string; status: string; rows: SheetRow[] };
    return { locationId: detail.locationId, open: detail.status === "open", rows: detail.rows };
  };
  async function tracked(articleNumber: string, tracking: "batch" | "serial", barcode: string) {
    const res = await call("POST", "/articles", { articleNumber, name: `Artikel ${articleNumber}`, type: "purchased", unit: "st", active: true, tracking, barcode });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string };
  }

  beforeEach(async () => {
    await resetSetting();
    await testSystemService.updateSettings(parsed(updateSystemSettingsSchema, { batchTrackingEnabled: true }));
  });

  it("counts a scanned serienummer against its own row, and adds one the sheet lacks", async () => {
    const { a, b } = await makeLocations();
    const pump = await tracked("INV-P", "serial", "7350000000016");
    expect((await call("POST", "/stock/transactions", { articleId: pump.id, locationId: a.id, quantityDelta: 1, batchNumber: "SN-1" })).statusCode).toBe(201);
    const count = (await call("POST", "/stock-counts", { locationId: a.id, blocksTransactions: false })).json() as { id: string };

    // The number in a GS1 code (AI 01 + 21): the row of that number.
    const coded = await scan("(01)07350000000016(21)SN-1");
    const hit = resolveCountScan(coded.matches, await sheet(count.id), coded.gs1);
    const row = (await sheet(count.id)).rows.find((r) => r.batchNumber === "SN-1")!;
    expect(row).toMatchObject({ batchKind: "serial", snapshotQuantity: "1.0000", countedQuantity: null });
    expect(hit).toEqual({ kind: "serialRow", articleId: pump.id, rowId: row.id, serialNumber: "SN-1" });
    // …and as the bare number (the serienummeretikett).
    expect(resolveCountScan((await scan("sn-1")).matches, await sheet(count.id), null)).toMatchObject({ kind: "serialRow", rowId: row.id });
    // The page then saves Räknat = 1.
    expect((await call("PATCH", `/stock-counts/${count.id}/rows/${row.id}`, { countedQuantity: 1 })).statusCode).toBe(200);

    // A number nobody booked, found on the shelf: added with the number, then 1.
    const unknown = await scan("(01)07350000000016(21)SN-2");
    const add = resolveCountScan(unknown.matches, await sheet(count.id), unknown.gs1);
    expect(add).toEqual({ kind: "addSerial", articleId: pump.id, serialNumber: "SN-2" });
    const added = await call("POST", `/stock-counts/${count.id}/rows`, { articleId: pump.id, batchNumber: "SN-2" });
    expect(added.statusCode).toBe(201);
    expect((await call("PATCH", `/stock-counts/${count.id}/rows/${added.json().id}`, { countedQuantity: 1 })).statusCode).toBe(200);
    // Scanned again it is its row.
    const again = await scan("SN-2");
    expect(resolveCountScan(again.matches, await sheet(count.id), again.gs1)).toMatchObject({ kind: "serialRow", rowId: added.json().id });
    // Only the article: the number is asked for.
    expect(resolveCountScan((await scan("7350000000016")).matches, await sheet(count.id), null)).toMatchObject({ kind: "chooseRow", serial: true });

    // On another place's count the number is refused — it stands on A-01.
    const countB = (await call("POST", "/stock-counts", { locationId: b.id, blocksTransactions: false })).json() as { id: string };
    const elsewhere = await scan("SN-1");
    expect(resolveCountScan(elsewhere.matches, await sheet(countB.id), elsewhere.gs1)).toEqual({ kind: "addSerial", articleId: pump.id, serialNumber: "SN-1" });
    const refused = await call("POST", `/stock-counts/${countB.id}/rows`, { articleId: pump.id, batchNumber: "SN-1" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("serial-on-other-location");
  });

  it("marks the scanned batch's row among the article's rows, and adds a batch the sheet lacks", async () => {
    const { a } = await makeLocations();
    const glue = await tracked("INV-G", "batch", "7350000000016");
    for (const [batchNumber, quantityDelta] of [["LOT-A", 4], ["LOT-B", 6]] as const) {
      expect((await call("POST", "/stock/transactions", { articleId: glue.id, locationId: a.id, quantityDelta, batchNumber })).statusCode).toBe(201);
    }
    const count = (await call("POST", "/stock-counts", { locationId: a.id, blocksTransactions: false })).json() as { id: string };
    const rows = (await sheet(count.id)).rows;
    const rowB = rows.find((r) => r.batchNumber === "LOT-B")!;

    const coded = await scan("(01)07350000000016(10)lot-b(17)270301");
    expect(resolveCountScan(coded.matches, await sheet(count.id), coded.gs1)).toEqual({ kind: "batchRow", articleId: glue.id, rowId: rowB.id, batchNumber: "lot-b" });
    expect(resolveCountScan((await scan("LOT-B")).matches, await sheet(count.id), null)).toMatchObject({ kind: "batchRow", rowId: rowB.id });
    // Only the article: several rows, the user chooses.
    expect(resolveCountScan((await scan("7350000000016")).matches, await sheet(count.id), null)).toMatchObject({
      kind: "chooseRow",
      serial: false,
      rowIds: expect.arrayContaining(rows.filter((r) => r.articleId === glue.id).map((r) => r.id)),
    });

    const fresh = await scan("(01)07350000000016(10)LOT-C");
    expect(resolveCountScan(fresh.matches, await sheet(count.id), fresh.gs1)).toEqual({ kind: "addBatch", articleId: glue.id, batchNumber: "LOT-C" });
    const added = await call("POST", `/stock-counts/${count.id}/rows`, { articleId: glue.id, batchNumber: "LOT-C" });
    expect(added.statusCode).toBe(201);
    const after = await scan("(01)07350000000016(10)LOT-C");
    expect(resolveCountScan(after.matches, await sheet(count.id), after.gs1)).toMatchObject({ kind: "batchRow", rowId: added.json().id });
  });
});
