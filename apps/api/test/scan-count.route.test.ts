import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { buildApp } from "../src/app.js";
import { pdfRectCount, pdfText } from "./helpers/pdf.js";

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

afterAll(async () => {
  await db.execute(TRUNCATE);
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
