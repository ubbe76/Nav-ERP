import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { companyInfo, db, permissionGroups, supplierInvoices, suppliers } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { paymentBatchRoutes } from "../src/modules/banking/routes/payment-batch.routes.js";
import {
  buildPaymentBatchService,
  buildRouteApp,
  configureSwedbank,
  makeApprovedSupplierInvoice,
  makeSupplier,
  resetBanking,
  resetBankSettings,
  setupBanking,
  snapshotCompany,
  swedbankSupplier,
} from "./helpers/banking.js";

const service = buildPaymentBatchService();
let restoreCompany: () => Promise<void>;
let userId: string;
beforeAll(async () => {
  restoreCompany = await snapshotCompany();
});
beforeEach(async () => {
  await resetBanking();
  await resetBankSettings();
  userId = (await setupBanking()).user.id;
  await configureSwedbank();
});
afterAll(async () => {
  await resetBankSettings();
  await restoreCompany();
  await resetBanking();
});

describe("/payment-batches", () => {
  it("creates, exports and serves the archived file as an attachment", async () => {
    const supplier = await swedbankSupplier();
    const invoice = await makeApprovedSupplierInvoice(supplier.id, { registrationNumber: "LF-70", gross: 500 });
    const app = buildRouteApp(paymentBatchRoutes, { service }, { id: userId });
    const created = await app.inject({ method: "POST", url: "/payment-batches", payload: { invoiceIds: [invoice.id] } });
    expect(created.statusCode).toBe(201);
    const { id, batchNumber } = created.json();
    expect((await app.inject({ method: "POST", url: `/payment-batches/${id}/export` })).statusCode).toBe(200);
    const file = await app.inject({ method: "GET", url: `/payment-batches/${id}/file` });
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toBe("application/xml");
    expect(file.headers["content-disposition"]).toContain(`${batchNumber}.xml`);
    expect(file.body).toContain("urn:iso:std:iso:20022:tech:xsd:pain.001.001.03");
    expect((await app.inject({ method: "POST", url: `/payment-batches/${id}/export` })).json().code).toBe("invalid-status-transition");
  });

  it("answers 409 with details for unpayable invoices, 400 for a malformed id, 404 for an unknown batch", async () => {
    const supplier = await makeSupplier({ name: "Utan Konto AB" });
    const invoice = await makeApprovedSupplierInvoice(supplier.id, { registrationNumber: "LF-71", gross: 100 });
    const app = buildRouteApp(paymentBatchRoutes, { service }, { id: userId });
    const res = await app.inject({ method: "POST", url: "/payment-batches", payload: { invoiceIds: [invoice.id] } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "supplier-invoices-not-payable", details: [{ reason: "no_payment_details" }] });
    expect((await app.inject({ method: "GET", url: "/payment-batches/inte-ett-id" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/payment-batches/00000000-0000-4000-8000-000000000000" })).statusCode).toBe(404);
  });

  it("export answers 409 payment-file-invalid with the violations; edits 400/204; confirm 200 with results; reject and cancel 200", async () => {
    const noTown = await swedbankSupplier({ city: null });
    const bad = await makeApprovedSupplierInvoice(noTown.id, { registrationNumber: "LF-72", gross: 100 });
    const app = buildRouteApp(paymentBatchRoutes, { service }, { id: userId });
    const badBatch = (await app.inject({ method: "POST", url: "/payment-batches", payload: { invoiceIds: [bad.id] } })).json();
    const invalid = await app.inject({ method: "POST", url: `/payment-batches/${badBatch.id}/export` });
    expect(invalid.statusCode).toBe(409);
    expect(invalid.json()).toMatchObject({ code: "payment-file-invalid", details: [{ field: "creditorCity" }] });
    expect((await app.inject({ method: "POST", url: `/payment-batches/${badBatch.id}/cancel` })).json().status).toBe("cancelled");

    const supplier = await swedbankSupplier();
    const one = await makeApprovedSupplierInvoice(supplier.id, { registrationNumber: "LF-73", gross: 500, dueDate: "2024-10-09" });
    const two = await makeApprovedSupplierInvoice(supplier.id, { registrationNumber: "LF-74", gross: 700, dueDate: "2024-10-09" });
    const three = await makeApprovedSupplierInvoice(supplier.id, { registrationNumber: "LF-75", gross: 900, dueDate: "2024-10-09" });
    const batch = (await app.inject({ method: "POST", url: "/payment-batches", payload: { invoiceIds: [one.id, two.id, three.id] } })).json();
    const [first, second, third] = batch.items as { id: string }[];
    const tooMuch = await app.inject({ method: "PATCH", url: `/payment-batches/${batch.id}/items/${first!.id}`, payload: { amount: 501 } });
    expect(tooMuch.statusCode).toBe(400);
    expect(tooMuch.json().code).toBe("invalid-payment-batch-item");
    expect((await app.inject({ method: "PATCH", url: `/payment-batches/${batch.id}/items/${first!.id}`, payload: { amount: "" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: `/payment-batches/${batch.id}/items/${third!.id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: "POST", url: `/payment-batches/${batch.id}/export` })).statusCode).toBe(200);

    const future = await app.inject({ method: "POST", url: `/payment-batches/${batch.id}/confirm`, payload: { paymentDate: "2024-10-10" } });
    expect(future.statusCode).toBe(400);
    expect(future.json().code).toBe("invalid-payment-date");
    const confirmed = await app.inject({ method: "POST", url: `/payment-batches/${batch.id}/confirm`, payload: { paymentDate: "2024-10-09", itemIds: [first!.id] } });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().results).toEqual([{ itemId: first!.id, ok: true, paymentNumber: expect.stringMatching(/^UTB-/) }]);
    const rejected = await app.inject({ method: "POST", url: `/payment-batches/${batch.id}/items/${second!.id}/reject`, payload: { reason: "Fel konto" } });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().status).toBe("confirmed");
    const again = await app.inject({ method: "POST", url: `/payment-batches/${batch.id}/items/${second!.id}/reject`, payload: { reason: "Fel konto" } });
    expect(again.statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/payment-batches/${batch.id}/cancel` })).json().code).toBe("invalid-status-transition");
  });

  // Valuta steg 2: Bekräfta utförd takes the SEK amount per row in another
  // currency; malformed amounts are a 400 before anything is booked.
  it("confirm takes amounts per row (amountSek, bankFeeSek) and validates them", async () => {
    await db.update(companyInfo).set({ iban: "SE4550000000058398257466" });
    const de = await makeSupplier({ name: "Muller GmbH", country: "DE", address: "Hauptstrasse 5", city: "Berlin", paymentMethod: "iban", iban: "DE89370400440532013000" });
    const eur = await makeApprovedSupplierInvoice(de.id, { registrationNumber: "LF-76", gross: 1000, currency: "EUR", exchangeRate: 11.131, dueDate: "2024-10-09" });
    const app = buildRouteApp(paymentBatchRoutes, { service }, { id: userId });
    const batch = (await app.inject({ method: "POST", url: "/payment-batches", payload: { invoiceIds: [eur.id] } })).json();
    // This service has no rate reader: a payment in EUR is reported for safety.
    expect(batch.items[0]).toMatchObject({ currency: "EUR", paymentKind: "sepa", regulatoryReporting: { code: "101", amountSek: null, rateMissing: true }, problems: [] });
    expect((await app.inject({ method: "POST", url: `/payment-batches/${batch.id}/export` })).statusCode).toBe(200);
    const itemId = batch.items[0].id as string;
    const url = `/payment-batches/${batch.id}/confirm`;
    const duplicate = await app.inject({ method: "POST", url, payload: { paymentDate: "2024-10-09", amounts: [{ itemId, amountSek: 11131 }, { itemId, amountSek: 11131 }] } });
    expect(duplicate.statusCode).toBe(400);
    const outside = await app.inject({
      method: "POST",
      url,
      payload: { paymentDate: "2024-10-09", itemIds: [itemId], amounts: [{ itemId: "00000000-0000-4000-8000-000000000000", amountSek: 1 }] },
    });
    expect(outside.statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, payload: { paymentDate: "2024-10-09", amounts: [{ itemId, amountSek: -5 }] } })).statusCode).toBe(400);
    // A blank fee is a 400 (blankSafe), never a silent 0.
    expect((await app.inject({ method: "POST", url, payload: { paymentDate: "2024-10-09", amounts: [{ itemId, amountSek: 11200, bankFeeSek: "" }] } })).statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url, payload: { paymentDate: "2024-10-09", amounts: [{ itemId, amountSek: "11200" }] } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().results).toEqual([{ itemId, ok: true, paymentNumber: expect.stringMatching(/^UTB-/) }]);
  });

  // The two remaining 409s of the batch routes: an export without complete
  // bank settings, and a reject of a row that is no longer exported (here
  // already confirmed) while the batch still is.
  it("export answers 409 bank-settings-incomplete; reject of a confirmed row answers 409 payment-batch-item-not-confirmable", async () => {
    const supplier = await swedbankSupplier();
    const one = await makeApprovedSupplierInvoice(supplier.id, { registrationNumber: "LF-77", gross: 500, dueDate: "2024-10-09" });
    const two = await makeApprovedSupplierInvoice(supplier.id, { registrationNumber: "LF-78", gross: 700, dueDate: "2024-10-09" });
    const app = buildRouteApp(paymentBatchRoutes, { service }, { id: userId });
    const batch = (await app.inject({ method: "POST", url: "/payment-batches", payload: { invoiceIds: [one.id, two.id] } })).json();

    await resetBankSettings();
    const incomplete = await app.inject({ method: "POST", url: `/payment-batches/${batch.id}/export` });
    expect(incomplete.statusCode).toBe(409);
    expect(incomplete.json().code).toBe("bank-settings-incomplete");
    expect((await app.inject({ method: "GET", url: `/payment-batches/${batch.id}` })).json().status).toBe("draft");

    await configureSwedbank();
    expect((await app.inject({ method: "POST", url: `/payment-batches/${batch.id}/export` })).statusCode).toBe(200);
    const [first] = batch.items as { id: string }[];
    const confirmed = await app.inject({ method: "POST", url: `/payment-batches/${batch.id}/confirm`, payload: { paymentDate: "2024-10-09", itemIds: [first!.id] } });
    expect(confirmed.json().results).toEqual([{ itemId: first!.id, ok: true, paymentNumber: expect.stringMatching(/^UTB-/) }]);
    const reject = await app.inject({ method: "POST", url: `/payment-batches/${batch.id}/items/${first!.id}/reject`, payload: { reason: "Fel konto" } });
    expect(reject.statusCode).toBe(409);
    expect(reject.json().code).toBe("payment-batch-item-not-confirmable");
    expect((await app.inject({ method: "GET", url: `/payment-batches/${batch.id}` })).json()).toMatchObject({
      status: "exported",
      items: expect.arrayContaining([expect.objectContaining({ id: first!.id, status: "confirmed" })]),
    });
  });

  it("lets ekonomi read but only inkop write", async () => {
    const asEkonomi = buildRouteApp(paymentBatchRoutes, { service }, { id: userId, role: "user", permissions: ["ekonomi"] });
    expect((await asEkonomi.inject({ method: "GET", url: "/payment-batches" })).statusCode).toBe(200);
    expect((await asEkonomi.inject({ method: "POST", url: "/payment-batches", payload: { invoiceIds: [] } })).statusCode).toBe(403);
    const asSales = buildRouteApp(paymentBatchRoutes, { service }, { id: userId, role: "user", permissions: ["forsaljning"] });
    expect((await asSales.inject({ method: "GET", url: "/payment-batches" })).statusCode).toBe(403);
  });
});

// The purchase module's routes that meet the bank files, in the real app
// (registerModule's Inköp rule, the global handler): the supplier's payment
// details are a 400 with the problems per field, and an invoice reserved in a
// live batch refuses a new payment reference and makulering with 409.
describe("leverantörsroutarna och betalningsomgången i den riktiga appen", () => {
  const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
  afterEach(async () => {
    // The users first (they reference their group); never TRUNCATE
    // permission_groups — the seed rows must survive.
    await resetBanking();
    await db.execute(sql`DELETE FROM permission_groups WHERE code NOT IN ('ALLA', 'VERKSTAD')`);
  });

  async function inkopSession(app: ReturnType<typeof buildApp>) {
    const [group] = await db
      .insert(permissionGroups)
      .values({ code: `T-${crypto.randomUUID().slice(0, 8)}`, name: "T", permissions: ["inkop"] })
      .returning();
    const email = `p-${crypto.randomUUID()}@example.com`;
    await authService.createUser({ email, password: "correcthorse", name: "P", role: "user", permissionGroupId: group!.id });
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "correcthorse" } });
    return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
  }

  it("400s bad payment details on POST and PATCH /suppliers with the problems per field", async () => {
    const app = buildApp();
    await app.ready();
    try {
      const cookie = await inkopSession(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/suppliers",
        headers: { cookie },
        payload: { name: "Fel Kontroll AB", currency: "SEK", active: true, paymentMethod: "bankgiro", bankgiro: "5050-1056" },
      });
      expect(created.statusCode).toBe(400);
      expect(created.json().code).toBe("invalid-supplier-payment-details");
      expect(created.json().problems.bankgiro).toMatch(/kontrollsiffra/);
      expect(await db.select().from(suppliers)).toHaveLength(0);

      const supplier = await makeSupplier({ plusgiro: "4892162" });
      const switched = await app.inject({ method: "PATCH", url: `/api/v1/suppliers/${supplier.id}`, headers: { cookie }, payload: { paymentMethod: "bankgiro" } });
      expect(switched.statusCode).toBe(400);
      expect(switched.json()).toMatchObject({ code: "invalid-supplier-payment-details", problems: { bankgiro: "Bankgiro saknas" } });
      const [row] = await db.select().from(suppliers).where(eq(suppliers.id, supplier.id));
      expect(row!.paymentMethod).not.toBe("bankgiro");
    } finally {
      await app.close();
    }
  });

  it("409s supplier-invoice-in-payment-batch on a new payment reference and on makulering of a reserved invoice", async () => {
    const supplier = await swedbankSupplier();
    const invoice = await makeApprovedSupplierInvoice(supplier.id, { registrationNumber: "LF-79", gross: 500, dueDate: "2024-10-09" });
    const batch = await service.create({ invoiceIds: [invoice.id] }, userId);
    const app = buildApp();
    await app.ready();
    try {
      const cookie = await inkopSession(app);
      const reference = await app.inject({
        method: "PATCH",
        url: `/api/v1/supplier-invoices/${invoice.id}/payment-reference`,
        headers: { cookie },
        payload: { paymentReference: { kind: "ocr", value: "4605127" } },
      });
      expect(reference.statusCode).toBe(409);
      expect(reference.json().code).toBe("supplier-invoice-in-payment-batch");
      expect(reference.json().error).toContain(batch.batchNumber);
      const cancel = await app.inject({ method: "POST", url: `/api/v1/supplier-invoices/${invoice.id}/cancel`, headers: { cookie } });
      expect(cancel.statusCode).toBe(409);
      expect(cancel.json().code).toBe("supplier-invoice-in-payment-batch");
      const [row] = await db.select().from(supplierInvoices).where(eq(supplierInvoices.id, invoice.id));
      expect(row).toMatchObject({ status: "approved", paymentReference: null });
    } finally {
      await app.close();
    }
  });
});
