import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { accounts, auditLog, bankFiles, companyInfo, db, paymentBatchItems, supplierPayments, verificationRows } from "@navet/db";
import { PaymentFileInvalidError } from "../src/modules/banking/service/banking.errors.js";
import { camtFile } from "./helpers/camt.js";
import { failure } from "./helpers/year-end.js";
import { validateAgainstXsd } from "./helpers/xsd.js";
import {
  TODAY,
  buildBankFileService,
  buildPaymentBatchService,
  configureSwedbank,
  fakeExchangeRates,
  makeApprovedSupplierInvoice,
  makeSupplier,
  resetBanking,
  resetBankSettings,
  setupBanking,
  snapshotCompany,
  testSupplierPaymentService,
} from "./helpers/banking.js";

// Valuta steg 2 — utlandsbetalningar through the batch: the preview's
// betalningstyp and KU81 marking, the export, Bekräfta utförd with the SEK
// amount and the fee, and camt.054 confirmations and returns of payments in
// another currency (Postgres).

const rates = fakeExchangeRates({ EUR: 11.131, USD: 10 });
const batches = buildPaymentBatchService(undefined, rates);
const files = buildBankFileService(undefined, rates);
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
  // Swedbank draws a payment abroad from the IBAN, never the bankgiro.
  await db.update(companyInfo).set({ iban: "SE45 5000 0000 0583 9825 7466" });
  rates.asked.length = 0;
});
afterAll(async () => {
  await resetBankSettings();
  await restoreCompany();
  await resetBanking();
});

async function suppliers() {
  const de = await makeSupplier({
    name: "Müller & Söhne GmbH",
    currency: "EUR",
    country: "DE",
    address: "Hauptstraße 5",
    postalCode: "10115",
    city: "Berlin",
    paymentMethod: "iban",
    iban: "DE89370400440532013000",
    bic: "COBADEFF",
  });
  const us = await makeSupplier({
    name: "Lakeside Tooling Inc.",
    currency: "USD",
    country: "US",
    address: "400 Harbor Drive",
    postalCode: "60601",
    city: "Chicago",
    paymentMethod: "foreign_account",
    foreignAccountNumber: "123456789012",
    clearingSystem: "USABA",
    clearingMemberId: "123456780",
    bankName: "Example Bank N.A.",
    chargeBearer: "DEBT",
    paymentReportingCode: "130",
  });
  const dk = await makeSupplier({
    name: "Øresund Stål ApS",
    country: "DK",
    address: "Søndergade 14",
    postalCode: "8000",
    city: "Aarhus C",
    paymentMethod: "iban",
    iban: "DK5000400440116243",
    bic: "DABADKKK",
  });
  return { de, us, dk };
}

// The invoices: EUR (SEPA, rate 11.00 at attest), USD (international,
// DEBT), SEK 175 000 to Denmark (international, KU81), EUR 20 000 (SEPA,
// KU81 at today's 11.131) and CAD (no rate today ⇒ reported to be safe).
async function invoices() {
  const { de, us, dk } = await suppliers();
  const eur = await makeApprovedSupplierInvoice(de.id, { registrationNumber: "LF-1", gross: 1250, currency: "EUR", exchangeRate: 11, dueDate: "2024-10-15", invoiceNumber: "2026-311" });
  const usd = await makeApprovedSupplierInvoice(us.id, { registrationNumber: "LF-2", gross: 980, currency: "USD", exchangeRate: 10.5, dueDate: "2024-10-15", invoiceNumber: "LT-2209" });
  const sek = await makeApprovedSupplierInvoice(dk.id, { registrationNumber: "LF-3", gross: 175000, dueDate: "2024-10-15", invoiceNumber: "4471" });
  const big = await makeApprovedSupplierInvoice(de.id, { registrationNumber: "LF-4", gross: 20000, currency: "EUR", exchangeRate: 11, dueDate: "2024-10-15", invoiceNumber: "2026-312" });
  const cad = await makeApprovedSupplierInvoice(us.id, { registrationNumber: "LF-5", gross: 100, currency: "CAD", exchangeRate: 7.5, dueDate: "2024-10-15", invoiceNumber: "LT-2210" });
  return { eur, usd, sek, big, cad };
}

async function verificationRowsOf(verificationId: string) {
  const rows = await db
    .select({ number: accounts.number, debit: verificationRows.debit, credit: verificationRows.credit })
    .from(verificationRows)
    .innerJoin(accounts, eq(accounts.id, verificationRows.accountId))
    .where(eq(verificationRows.verificationId, verificationId))
    .orderBy(asc(verificationRows.createdAt));
  return Object.fromEntries(rows.map((row) => [row.number, { debit: Number(row.debit), credit: Number(row.credit) }]));
}

describe("omgången: betalningstyp och rapportering till Skatteverket", () => {
  it("previews each row's kind and KU81 decision at today's rate; a missing rate is reported for safety and warned about", async () => {
    const { eur, usd, sek, big, cad } = await invoices();
    const batch = await batches.create({ invoiceIds: [eur.id, usd.id, sek.id, big.id, cad.id] }, userId);
    expect(batch.items.map((i) => [i.registrationNumber, i.currency, i.amount, i.paymentKind, i.regulatoryReporting])).toEqual([
      ["LF-1", "EUR", 1250, "sepa", null],
      ["LF-2", "USD", 980, "international", null],
      ["LF-3", "SEK", 175000, "international", { code: "101", amountSek: 175000, rateMissing: false }],
      ["LF-4", "EUR", 20000, "sepa", { code: "101", amountSek: 222620, rateMissing: false }],
      ["LF-5", "CAD", 100, "international", { code: "130", amountSek: null, rateMissing: true }],
    ]);
    expect(batch.items[4]!.warnings).toContain(
      "Kurs för CAD saknas — betalningen rapporteras till Skatteverket med betalningskod 130 för säkerhets skull (ange kursen under Ekonomi → Valutakurser)"
    );
    expect(batch.items[0]!.warnings).toEqual(['Mottagarens namn skickas som "Muller and Sohne GmbH"']);
    expect(batch.problems).toEqual([]);
    expect(batch.items.every((i) => i.problems.length === 0)).toBe(true);
    expect(batch.totalAmount).toBe(175000);
    expect(batch.totalsByCurrency).toEqual([
      { currency: "CAD", amount: 100 },
      { currency: "EUR", amount: 21250 },
      { currency: "SEK", amount: 175000 },
      { currency: "USD", amount: 980 },
    ]);
    // Today's rate, one lookup per currency.
    expect([...new Set(rates.asked)].sort()).toEqual(["CAD 2024-10-09", "EUR 2024-10-09", "USD 2024-10-09"]);
    // The list carries the totals per currency too.
    const listed = (await batches.list({ limit: 25, offset: 0 })).rows[0]!;
    expect(listed).toMatchObject({ totalAmount: 175000, totalsByCurrency: batch.totalsByCurrency });
  });

  it("shows what the export would refuse — the company's missing debit IBAN, a payee's missing street — and the export refuses it", async () => {
    const { eur } = await invoices();
    await db.update(companyInfo).set({ iban: null });
    const batch = await batches.create({ invoiceIds: [eur.id] }, userId);
    expect(batch.problems).toEqual(["Swedbank kräver IBAN som debiteringskonto för utlandsbetalningar — lägg in det i Företagsinformation"]);
    const error = await failure(batches.export(batch.id, userId));
    expect(error).toBeInstanceOf(PaymentFileInvalidError);
    expect((error as PaymentFileInvalidError).violations.map((v) => v.field)).toEqual(["debtorForeignAccount"]);

    await db.update(companyInfo).set({ iban: "SE4550000000058398257466" });
    const noStreet = await makeSupplier({ name: "Nameless SARL", country: "FR", city: "Lyon", paymentMethod: "iban", iban: "FR1420041010050500013M02606" });
    const fr = await makeApprovedSupplierInvoice(noStreet.id, { registrationNumber: "LF-9", gross: 10, currency: "EUR" });
    const second = await batches.create({ invoiceIds: [fr.id] }, userId);
    expect(second.problems).toEqual([]);
    expect(second.items[0]!.problems).toEqual(["Mottagarens gatuadress saknas (krävs för utlandsbetalningar)"]);
  });

  it("exports the payments abroad: one file, XSD-valid, the KU81 decision in each row's snapshot", async () => {
    const { eur, usd, sek, big, cad } = await invoices();
    const draft = await batches.create({ invoiceIds: [eur.id, usd.id, sek.id, big.id, cad.id] }, userId);
    const exported = await batches.export(draft.id, userId);
    expect(exported.status).toBe("exported");
    const [file] = await db.select().from(bankFiles);
    const xml = file!.data.toString("utf8");
    expect(await validateAgainstXsd(xml, "pain.001.001.03")).toEqual([]);
    const n = exported.batchNumber;
    expect(xml).toContain(`<PmtInfId>${n}-20241015S</PmtInfId>`);
    expect(xml).toContain(`<PmtInfId>${n}-20241015I</PmtInfId>`);
    expect(xml).toContain(`<PmtInfId>${n}-20241015D</PmtInfId>`);
    expect(xml).toContain("<DbtrAcct><Id><IBAN>SE4550000000058398257466</IBAN></Id><Ccy>SEK</Ccy></DbtrAcct>");
    expect(xml).toContain('<InstdAmt Ccy="CAD">100.00</InstdAmt>');
    expect(xml.match(/<RgltryRptg><Dtls><Cd>101<\/Cd><\/Dtls><\/RgltryRptg>/g)).toHaveLength(2);
    expect(xml).toContain("<RgltryRptg><Dtls><Cd>130</Cd></Dtls></RgltryRptg>");
    // Nav's own message is English abroad.
    expect(xml).toContain("<Ustrd>Invoice 2026-311</Ustrd>");

    const byNumber = Object.fromEntries(exported.items.map((i) => [i.registrationNumber, i]));
    expect(byNumber["LF-4"]!.creditor).toMatchObject({
      kind: "sepa",
      currency: "EUR",
      chargeBearer: "SLEV",
      regulatoryReporting: { code: "101", amountSek: 222620, rate: 11.131, rateDate: TODAY },
    });
    expect(byNumber["LF-5"]!.creditor!.regulatoryReporting).toEqual({ code: "130", amountSek: null, rate: null, rateDate: null });
    expect(byNumber["LF-1"]!.creditor!.regulatoryReporting).toBeNull();
    expect(byNumber["LF-2"]!).toMatchObject({ paymentKind: "international", regulatoryReporting: null });
    expect(byNumber["LF-2"]!.creditor).toMatchObject({ method: "foreign_account", account: "123456789012", clearingSystem: "USABA", chargeBearer: "DEBT", country: "US" });

    const [log] = await db.select().from(auditLog).where(and(eq(auditLog.entityId, n), eq(auditLog.action, "exported")));
    expect(log!.detail).toMatchObject({
      amount: 175000,
      foreign: [
        { currency: "EUR", amount: 21250 },
        { currency: "USD", amount: 980 },
        { currency: "CAD", amount: 100 },
      ],
      regulatoryReporting: [`${n}-3`, `${n}-4`, `${n}-5`],
    });
  });
});

describe("Bekräfta utförd för en post i annan valuta", () => {
  it("needs the SEK amount per row; with it (and the fee) the UTB books the exchange difference", async () => {
    const { eur, sek } = await invoices();
    const draft = await batches.create({ invoiceIds: [eur.id, sek.id] }, userId);
    const exported = await batches.export(draft.id, userId);
    const [eurRow, sekRow] = exported.items;

    // Without amounts: the SEK row is confirmed as before, the EUR row fails.
    const first = await batches.confirm(exported.id, { paymentDate: TODAY }, userId);
    expect(first.results).toEqual([
      { itemId: eurRow!.id, ok: false, error: { error: "A payment in EUR needs the amount in SEK that left the bank account", code: "supplier-payment-amount-sek" } },
      { itemId: sekRow!.id, ok: true, paymentNumber: expect.any(String) },
    ]);

    const second = await batches.confirm(exported.id, { paymentDate: TODAY, amounts: [{ itemId: eurRow!.id, amountSek: 13938.75, bankFeeSek: 25 }] }, userId);
    expect(second.results).toEqual([{ itemId: eurRow!.id, ok: true, paymentNumber: expect.any(String) }]);
    expect(second.batch.status).toBe("confirmed");
    const [payment] = await db.select().from(supplierPayments).where(eq(supplierPayments.paymentBatchItemId, eurRow!.id));
    const detail = await testSupplierPaymentService.getPayment(payment!.id);
    // 1 250 EUR attested at 11.00 = 13 750 kr; 13 938.75 left the account, 25 of it the fee.
    expect(detail).toMatchObject({ currency: "EUR", amount: "1250.00", amountSek: "13938.75", bankFeeSek: "25.00", exchangeRateDifferenceSek: -163.75 });
    expect(await verificationRowsOf(payment!.verificationId!)).toEqual({
      "1930": { debit: 0, credit: 13938.75 },
      "2440": { debit: 13750, credit: 0 },
      "6570": { debit: 25, credit: 0 },
      "7960": { debit: 163.75, credit: 0 },
    });
    const [log] = await db.select().from(auditLog).where(and(eq(auditLog.entityId, exported.batchNumber), eq(auditLog.action, "item_confirmed"))).orderBy(asc(auditLog.createdAt));
    expect(log!.detail).toMatchObject({ via: "manual" });
  });
});

describe("camt.054: utlandsbetalningar bekräftas på det instruerade beloppet", () => {
  const upload = (xml: string, filename = "camt054.xml") => files.upload({ filename, contentType: "application/xml", data: Buffer.from(xml) }, userId);

  async function exportedEur() {
    const { eur } = await invoices();
    const draft = await batches.create({ invoiceIds: [eur.id] }, userId);
    return batches.export(draft.id, userId);
  }
  const debit = (endToEndId: string, opts: { sek?: number; instructed?: number | null; charges?: number; ref?: string } = {}) =>
    camtFile({
      messageId: `FX-${opts.ref ?? "1"}`,
      account: "SE4550000000058398257466",
      entries: [
        {
          direction: "debit",
          amount: opts.sek ?? 13938.75,
          bookingDate: TODAY,
          txs: [
            {
              acctSvcrRef: `T-${opts.ref ?? "1"}`,
              endToEndId,
              amount: opts.sek ?? 13938.75,
              ...(opts.instructed === null ? {} : { instructed: { amount: opts.instructed ?? 1250, currency: "EUR" } }),
              exchange: { source: "SEK", target: "EUR", unit: "EUR", rate: "11.131" },
              charges: opts.charges === undefined ? [{ amount: 25, code: "COMM" }] : opts.charges === 0 ? [] : [{ amount: opts.charges, code: "COMM" }],
            },
          ],
        },
      ],
    });

  it("matches on InstdAmt in the invoice's currency and books the SEK debited and the included charges", async () => {
    const batch = await exportedEur();
    const endToEndId = batch.items[0]!.endToEndId;
    const { file } = await upload(debit(endToEndId));
    const [entry] = await files.outgoingView(file.id);
    expect(entry).toMatchObject({
      state: "matched",
      amount: 13938.75,
      currency: "SEK",
      instructedAmount: 1250,
      instructedCurrency: "EUR",
      chargesAmount: 25,
      currencyExchange: { sourceCurrency: "SEK", targetCurrency: "EUR", unitCurrency: "EUR", rate: "11.131" },
      item: { amount: 1250, currency: "EUR" },
    });
    const { results } = await files.bookOutgoing(file.id, { entryIds: [entry!.id] }, userId);
    expect(results[0]).toMatchObject({ ok: true });
    const [payment] = await db.select().from(supplierPayments);
    expect(payment).toMatchObject({ currency: "EUR", amount: "1250.00", amountSek: "13938.75", bankFeeSek: "25.00", bankFileEntryId: entry!.id });
    expect((await testSupplierPaymentService.getPayment(payment!.id))!.exchangeRateDifferenceSek).toBe(-163.75);
    expect((await files.outgoingView(file.id))[0]!.state).toBe("booked");
  });

  it("a bank that reports no charges (Nordea) leaves the fee inside the exchange difference", async () => {
    const batch = await exportedEur();
    const { file } = await upload(debit(batch.items[0]!.endToEndId, { charges: 0, sek: 13900 }));
    const [entry] = await files.outgoingView(file.id);
    await files.bookOutgoing(file.id, { entryIds: [entry!.id] }, userId);
    const [payment] = await db.select().from(supplierPayments);
    expect(payment).toMatchObject({ amountSek: "13900.00", bankFeeSek: "0.00" });
    expect(await verificationRowsOf(payment!.verificationId!)).toEqual({
      "1930": { debit: 0, credit: 13900 },
      "2440": { debit: 13750, credit: 0 },
      "7960": { debit: 150, credit: 0 },
    });
  });

  it("another instructed amount, or none, is 'amount differs' and books nothing", async () => {
    const batch = await exportedEur();
    const endToEndId = batch.items[0]!.endToEndId;
    const wrong = await upload(debit(endToEndId, { instructed: 1200, ref: "2" }));
    const [entry] = await files.outgoingView(wrong.file.id);
    expect(entry!.state).toBe("amount_mismatch");
    const { results } = await files.bookOutgoing(wrong.file.id, { entryIds: [entry!.id] }, userId);
    expect(results[0]).toEqual({
      entryId: entry!.id,
      ok: false,
      error: { error: `Payment ${endToEndId} was 1250.00 EUR but the bank debited 1200.00 EUR`, code: "bank-entry-amount-differs" },
    });
    const missing = await upload(debit(endToEndId, { instructed: null, ref: "3" }));
    const [bare] = await files.outgoingView(missing.file.id);
    expect(bare!.state).toBe("amount_mismatch");
    const refused = await files.bookOutgoing(missing.file.id, { entryIds: [bare!.id] }, userId);
    expect(refused.results[0]).toMatchObject({ ok: false, error: { error: `Payment ${endToEndId} was 1250.00 EUR but the bank reported no instructed amount in EUR` } });
    expect(await db.select().from(supplierPayments)).toEqual([]);
  });

  it("a separately debited fee (an entry without our EndToEndId) is never matched", async () => {
    await exportedEur();
    const xml = camtFile({
      messageId: "FEE-1",
      account: "SE4550000000058398257466",
      entries: [{ direction: "debit", amount: 50, bookingDate: TODAY, txs: [{ acctSvcrRef: "FEE-T1", amount: 50, ustrd: "Avgift utlandsbetalning" }] }],
    });
    const { file } = await upload(xml);
    const [entry] = await files.outgoingView(file.id);
    expect(entry).toMatchObject({ state: "unknown", item: null });
    const { results } = await files.bookOutgoing(file.id, { entryIds: [entry!.id] }, userId);
    expect(results[0]).toMatchObject({ ok: false, error: { code: "bank-entry-not-matched" } });
  });

  it("a return of a confirmed payment abroad is booked only when it brings back the SEK the payment took", async () => {
    const batch = await exportedEur();
    const endToEndId = batch.items[0]!.endToEndId;
    const confirmed = await upload(debit(endToEndId));
    await files.bookOutgoing(confirmed.file.id, { entryIds: (await files.outgoingView(confirmed.file.id)).map((e) => e.id) }, userId);
    const returnOf = (sek: number, ref: string) =>
      camtFile({
        messageId: `RET-${ref}`,
        account: "SE4550000000058398257466",
        entries: [
          {
            direction: "credit",
            reversal: true,
            amount: sek,
            bookingDate: "2024-10-17",
            txs: [{ acctSvcrRef: `R-${ref}`, endToEndId, amount: sek, instructed: { amount: 1250, currency: "EUR" }, returnReason: "AC01" }],
          },
        ],
      });
    const differs = await upload(returnOf(13800, "1"));
    const [ret] = await files.outgoingView(differs.file.id);
    expect(ret!.state).toBe("return");
    const refused = await files.bookOutgoing(differs.file.id, { entryIds: [ret!.id] }, userId);
    expect(refused.results[0]).toMatchObject({ ok: false, error: { code: "bank-return-sek-differs" } });
    const [still] = await db.select().from(paymentBatchItems);
    expect(still!.status).toBe("confirmed");

    const exact = await upload(returnOf(13938.75, "2"));
    const [back] = await files.outgoingView(exact.file.id);
    const booked = await files.bookOutgoing(exact.file.id, { entryIds: [back!.id] }, userId);
    expect(booked.results[0]).toMatchObject({ ok: true, paymentNumber: endToEndId });
    const [returned] = await db.select().from(paymentBatchItems);
    expect(returned!.status).toBe("returned");
  });
});
