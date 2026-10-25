import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { customers, db, invoices, permissionGroups, referenceRates } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { DEFAULT_POSTING_SETTINGS, POSTING_BASELINE_YEAR, setupPostingBaseline, testSystemService } from "./helpers/services.js";

// Dröjsmålsränta through the real app: the routes, the permission rule
// (read office, write forsaljning — like the invoices), the error codes the
// web is built against, the settings on PATCH /settings/posting and the
// customer's three fields.

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const PASSWORD = "correcthorsebattery";
const TRUNCATE = sql`TRUNCATE late_interest_charges, reference_rates, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, customer_payment_rows, customer_payments, invoice_reminders, invoice_documents, invoice_rows, invoices, customers, user_settings, audit_log, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'LIR%'`;

let app: ReturnType<typeof buildApp>;
const Y = POSTING_BASELINE_YEAR;
const AS_OF = `${Y}-10-20`;

// The fixtures are fixed dates (due 1 September, T.o.m. 20 October); run
// before 20 October the real today would make AS_OF a future date, which the
// routine refuses — so the clock (Date only) is moved to AS_OF then.
const REAL_TODAY = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(new Date());

beforeAll(async () => {
  if (REAL_TODAY < AS_OF) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${AS_OF}T12:00:00+02:00`));
  }
  app = buildApp();
  await app.ready();
});
beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
  await setupPostingBaseline();
  await testSystemService.updateSettings({
    ...DEFAULT_POSTING_SETTINGS,
    lateInterestEnabled: true,
    lateFeeEnabled: true,
    lateInterestMinAmount: 100,
    lateInterestMargin: 8,
    postingLateInterest: "8313",
    postingLateFee: "3990",
  });
  await db.insert(referenceRates).values([
    { validFrom: `${Y}-01-01`, rate: "2", source: "riksbank" },
    { validFrom: `${Y}-07-01`, rate: "4", source: "riksbank" },
  ]);
});
afterAll(async () => {
  vi.useRealTimers();
  await app.close();
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
  await testSystemService.updateSettings({ ...DEFAULT_POSTING_SETTINGS, lateInterestEnabled: false, lateFeeEnabled: false });
});

async function login(email: string) {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
}

async function cookieWith(permissions: string[], name: string) {
  const [group] = await db
    .insert(permissionGroups)
    .values({ code: `LIR${crypto.randomUUID().slice(0, 6)}`, name, permissions })
    .returning();
  const email = `${name.toLowerCase()}-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name, role: "user", permissionGroupId: group!.id });
  return login(email);
}

function api(cookie: string) {
  return {
    get: (url: string) => app.inject({ method: "GET", url: `/api/v1${url}`, headers: { cookie } }),
    post: (url: string, payload?: unknown) => app.inject({ method: "POST", url: `/api/v1${url}`, headers: { cookie }, payload }),
    patch: (url: string, payload?: unknown) => app.inject({ method: "PATCH", url: `/api/v1${url}`, headers: { cookie }, payload }),
    delete: (url: string) => app.inject({ method: "DELETE", url: `/api/v1${url}`, headers: { cookie } }),
  };
}

// An issued SEK invoice of 36 500 due 1 September, through the API.
async function makeOverdueInvoice(sales: ReturnType<typeof api>, customerId: string) {
  const draft = await sales.post("/invoices", { customerId, rows: [{ description: "Leverans", quantity: 1, unitPrice: 29200, vatRate: 25 }] });
  expect(draft.statusCode).toBe(201);
  const issued = await sales.post(`/invoices/${draft.json().id}/issue`);
  expect(issued.statusCode).toBe(200);
  await db.update(invoices).set({ dueDate: `${Y}-09-01` }).where(eq(invoices.id, draft.json().id));
  return draft.json().id as string;
}

describe("dröjsmålsränta routes", () => {
  it("Försäljning reads and writes, another office menu reads only, a verkstad user nothing", async () => {
    const sales = api(await cookieWith(["forsaljning"], "Saljare"));
    const office = api(await cookieWith(["inkop"], "Inkopare"));
    const workshop = api(await cookieWith(["terminal"], "Verkstad"));
    const [customer] = await db.insert(customers).values({ name: "Kund AB", customerNumber: "K1" }).returning();
    const invoiceId = await makeOverdueInvoice(sales, customer!.id);

    expect((await office.get(`/late-interest/candidates?asOf=${AS_OF}`)).statusCode).toBe(200);
    expect((await office.get("/reference-rates")).statusCode).toBe(200);
    expect((await workshop.get(`/late-interest/candidates?asOf=${AS_OF}`)).statusCode).toBe(403);
    expect((await office.post("/reference-rates", { validFrom: `${Y}-01-01`, rate: 3 })).statusCode).toBe(403);
    expect((await office.post("/late-interest/invoices", { asOf: AS_OF, items: [] })).statusCode).toBe(403);

    const list = await sales.get(`/late-interest/candidates?asOf=${AS_OF}&includeUnpaid=true`);
    expect(list.statusCode).toBe(200);
    expect(list.json().rateMissing).toEqual([]);
    expect(list.json().rows).toHaveLength(1);
    const row = list.json().rows[0];
    expect(row).toMatchObject({ invoiceId, fromDate: `${Y}-09-02`, toDate: AS_OF, days: 49, rate: 12, interest: 588, fee: 450, belowMinimum: false, rateMissing: false });
    expect(typeof row.principal).toBe("number");
    expect(typeof row.openAmount).toBe("number");
    expect(row.segments[0]).toEqual({ from: `${Y}-09-02`, to: AS_OF, days: 49, rate: 12, amount: 588 });
    // A T.o.m. datum after today: 400 late-interest-future-date.
    const future = await sales.get(`/late-interest/candidates?asOf=${Y + 1}-12-31`);
    expect(future.statusCode).toBe(400);
    expect(future.json().code).toBe("late-interest-future-date");
    // includeUnpaid=false as a STRING must be false (no z.coerce.boolean()).
    expect((await sales.get(`/late-interest/candidates?asOf=${AS_OF}&includeUnpaid=false`)).json().rows).toEqual([]);

    const run = await sales.post("/late-interest/invoices", {
      asOf: AS_OF,
      issue: true,
      items: [{ invoiceId, fromDate: row.fromDate, includeInterest: true, includeFee: true, fee: row.fee }],
    });
    expect(run.statusCode).toBe(201);
    expect(run.json().skipped).toEqual([]);
    expect(run.json().issueFailed).toEqual([]);
    expect(run.json().created).toHaveLength(1);
    expect(run.json().created[0]).toMatchObject({ customerName: "Kund AB", status: "issued", total: 1038 });
    expect(run.json().created[0].invoiceNumber).toMatch(/^FA-/);

    // The cards: the räntefaktura and the source invoice's charges.
    const charge = await sales.get(`/invoices/${run.json().created[0].invoiceId}`);
    expect(charge.json().isLateInterestInvoice).toBe(true);
    expect(charge.json().rows.map((r: { revenueAccount: string | null }) => r.revenueAccount)).toEqual(["8313", "3990"]);
    const source = await sales.get(`/invoices/${invoiceId}`);
    expect(source.json().isLateInterestInvoice).toBe(false);
    expect(source.json().lateInterestCharges).toHaveLength(2);
    expect(source.json().lateInterestCharges[0]).toMatchObject({ fromDate: `${Y}-09-02`, toDate: AS_OF, days: 49, amount: 588, fee: 0, active: true });
    expect(source.json().lateInterestCharges[0].chargeInvoiceNumber).toBe(run.json().created[0].invoiceNumber);

    // The stale selection: 409 late-interest-already-charged with the ids.
    const again = await sales.post("/late-interest/invoices", {
      asOf: AS_OF,
      items: [{ invoiceId, fromDate: row.fromDate, includeInterest: true, includeFee: false, fee: 0 }],
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("late-interest-already-charged");
    expect(again.json().invoiceIds).toEqual([invoiceId]);
    // The same invoice twice in one call: 400 before anything is read.
    const item = { invoiceId, fromDate: row.fromDate, includeInterest: true, includeFee: false, fee: 0 };
    expect((await sales.post("/late-interest/invoices", { asOf: AS_OF, items: [item, item] })).statusCode).toBe(400);

    // The påminnelseavgift after the förseningsersättning.
    await testSystemService.updateSettings({ smtpHost: "smtp.test.local", smtpFromEmail: "erp@test.local" });
    const reminder = await sales.post(`/invoices/${invoiceId}/reminders`, { to: "k@example.com", subject: "P", withFee: true });
    expect(reminder.statusCode).toBe(409);
    expect(reminder.json().code).toBe("reminder-fee-after-late-fee");
  });

  it("answers 409 late-interest-disabled when the routine is off", async () => {
    await testSystemService.updateSettings({ lateInterestEnabled: false });
    const sales = api(await cookieWith(["forsaljning"], "Saljare"));
    const res = await sales.get(`/late-interest/candidates?asOf=${AS_OF}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("late-interest-disabled");
  });

  it("reference rates: list, manual add wins, delete only manual (409 reference-rate-riksbank), 404 unknown", async () => {
    const sales = api(await cookieWith(["forsaljning"], "Saljare"));
    const list = await sales.get("/reference-rates");
    expect(list.json().total).toBe(2);
    expect(list.json().rows.map((r: { validFrom: string; rate: number; source: string }) => [r.validFrom, r.rate, r.source])).toEqual([
      [`${Y}-07-01`, 4, "riksbank"],
      [`${Y}-01-01`, 2, "riksbank"],
    ]);

    expect((await sales.post("/reference-rates", { validFrom: `${Y}-03-01`, rate: 3 })).statusCode).toBe(400);
    const manual = await sales.post("/reference-rates", { validFrom: `${Y}-07-01`, rate: 3.5 });
    expect(manual.statusCode).toBe(201);
    expect(manual.json()).toMatchObject({ validFrom: `${Y}-07-01`, rate: 3.5, source: "manual" });
    const after = await sales.get("/reference-rates");
    expect(after.json().rows.find((r: { validFrom: string }) => r.validFrom === `${Y}-07-01`)).toMatchObject({ rate: 3.5, source: "manual" });

    const riksbank = after.json().rows.find((r: { validFrom: string }) => r.validFrom === `${Y}-01-01`);
    const refused = await sales.delete(`/reference-rates/${riksbank.id}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("reference-rate-riksbank");
    expect((await sales.delete(`/reference-rates/${manual.json().id}`)).statusCode).toBe(204);
    expect((await sales.delete(`/reference-rates/${crypto.randomUUID()}`)).statusCode).toBe(404);
    expect((await sales.get("/reference-rates")).json().total).toBe(1);
  });

  it("settings and the customer's fields round-trip", async () => {
    const ekonomi = api(await cookieWith(["ekonomi"], "Ekonom"));
    const sales = api(await cookieWith(["forsaljning"], "Saljare"));

    const patched = await ekonomi.patch("/settings/posting", {
      lateInterestEnabled: false,
      lateInterestMargin: 7.5,
      lateInterestMinAmount: 50,
      lateFeeEnabled: false,
      postingLateInterest: "8310",
      postingLateFee: "",
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      lateInterestEnabled: false,
      lateInterestMargin: 7.5,
      lateInterestMinAmount: 50,
      lateFeeEnabled: false,
      postingLateInterest: "8310",
      postingLateFee: "3990",
    });
    expect((await ekonomi.patch("/settings/posting", { postingLateInterest: "83100" })).statusCode).toBe(400);

    const created = await sales.post("/customers", { name: "Kund AB", lateInterestRate: 12.5, lateFee: false });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ lateInterest: true, lateInterestRate: "12.50", lateFee: false });
    const cleared = await sales.patch(`/customers/${created.json().id}`, { lateInterestRate: null, lateInterest: false });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ lateInterest: false, lateInterestRate: null, lateFee: false });
    expect((await sales.get(`/customers/${created.json().id}`)).json()).toMatchObject({ lateInterest: false, lateInterestRate: null });
    expect((await sales.patch(`/customers/${created.json().id}`, { lateInterestRate: 101 })).statusCode).toBe(400);
  });
});
