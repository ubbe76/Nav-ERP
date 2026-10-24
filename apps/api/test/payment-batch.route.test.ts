import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { companyInfo, db } from "@navet/db";
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

  it("lets ekonomi read but only inkop write", async () => {
    const asEkonomi = buildRouteApp(paymentBatchRoutes, { service }, { id: userId, role: "user", permissions: ["ekonomi"] });
    expect((await asEkonomi.inject({ method: "GET", url: "/payment-batches" })).statusCode).toBe(200);
    expect((await asEkonomi.inject({ method: "POST", url: "/payment-batches", payload: { invoiceIds: [] } })).statusCode).toBe(403);
    const asSales = buildRouteApp(paymentBatchRoutes, { service }, { id: userId, role: "user", permissions: ["forsaljning"] });
    expect((await asSales.inject({ method: "GET", url: "/payment-batches" })).statusCode).toBe(403);
  });
});
