import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { accounts, customerPayments, db, invoiceRows, invoices, verificationRows } from "@navet/db";
import { toSek } from "@navet/shared";
import { computeOcrNumber } from "../src/modules/system/service/ocr.js";
import { camtFile } from "./helpers/camt.js";
import {
  BANK_YEAR,
  buildBankFileService,
  configureSwedbank,
  makeCustomer,
  makeIssuedCustomerInvoice,
  resetBanking,
  resetBankSettings,
  setupBanking,
  snapshotCompany,
} from "./helpers/banking.js";
import { vatCodeId } from "./helpers/vat-codes.js";

// Valuta steg 3: camt.054 kredit — a payment the customer instructed in EUR,
// credited to the SEK account (InstdAmt EUR, TxAmt SEK, charges included),
// is matched on its OCR against the EUR invoice and booked with the EUR
// amount as the payment's own and the entry's SEK amount as amount_sek.

const files = buildBankFileService();
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

// An issued EUR invoice (rate 11) written straight to the table, like
// makeIssuedCustomerInvoice does for SEK.
async function eurInvoice(customerId: string, invoiceNumber: string, gross: number, rate = 11) {
  const net = Math.round((gross / 1.25) * 100) / 100;
  const vat = Math.round((gross - net) * 100) / 100;
  const ocrNumber = computeOcrNumber(invoiceNumber);
  const [invoice] = await db
    .insert(invoices)
    .values({
      invoiceNumber,
      customerId,
      status: "issued",
      currency: "EUR",
      exchangeRate: String(rate),
      grossAmountSek: String(toSek(gross, rate)),
      invoiceDate: `${BANK_YEAR}-09-01`,
      dueDate: `${BANK_YEAR}-10-01`,
      ocrNumber,
      issuedAt: new Date(`${BANK_YEAR}-09-01T08:00:00Z`),
    })
    .returning();
  await db.insert(invoiceRows).values({
    invoiceId: invoice!.id,
    description: "Leverans",
    quantity: "1",
    unitPrice: String(net),
    vatRate: "25",
    vatCodeId: await vatCodeId("MP25"),
    lineAmount: String(net),
    vatAmount: String(vat),
  });
  return { id: invoice!.id, ocrNumber };
}

const upload = (xml: string) => files.upload({ filename: "camt054-eur.xml", contentType: "application/xml", data: Buffer.from(xml) }, userId);

function eurCredit(entries: { ref: string; ocr: string; eur: number; sek: number; charges?: number; currency?: string }[]) {
  return camtFile({
    messageId: `EUR-${crypto.randomUUID().slice(0, 8)}`,
    entries: entries.map((e) => ({
      direction: "credit" as const,
      amount: e.sek,
      bookingDate: "2024-10-09",
      txs: [
        {
          acctSvcrRef: e.ref,
          amount: e.sek,
          counterparty: "EURO KUND GMBH",
          refs: [{ type: "SCOR" as const, value: e.ocr }],
          instructed: { amount: e.eur, currency: e.currency ?? "EUR" },
          exchange: { source: "EUR", target: "SEK", unit: "EUR", rate: "11.2" },
          ...(e.charges ? { charges: [{ amount: e.charges }] } : {}),
        },
      ],
    })),
  });
}

describe("camt.054 kredit i valuta", () => {
  it("matches the instructed EUR amount on the OCR and books the entry's SEK amount and charges", async () => {
    const customer = await makeCustomer("Euro Kund GmbH");
    const invoice = await eurInvoice(customer.id, "FA-7001", 1000);
    const { file } = await upload(eurCredit([{ ref: "EUR-1", ocr: invoice.ocrNumber, eur: 1000, sek: 11150, charges: 50 }]));
    const [entry] = await files.incomingView(file.id);
    expect(entry).toMatchObject({
      amount: 11150,
      currency: "SEK",
      instructedAmount: 1000,
      instructedCurrency: "EUR",
      chargesAmount: 50,
      state: "matched",
      proposal: { basis: "ocr", rows: [{ invoiceId: invoice.id, appliedAmount: 1000 }] },
    });

    const { results } = await files.bookIncoming(
      file.id,
      { entries: [{ entryId: entry!.id, customerId: customer.id, rows: [{ invoiceId: invoice.id, appliedAmount: 1000 }] }] },
      userId
    );
    expect(results[0]).toMatchObject({ ok: true });
    const [payment] = await db.select().from(customerPayments);
    expect(payment).toMatchObject({ currency: "EUR", amount: "1000.00", amountSek: "11150.00", bankFeeSek: "50.00" });
    // 11 150 + 50 = 11 200 SEK for a receivable booked at 11 000 ⇒ 200 kursvinst.
    const rows = await db
      .select({ number: accounts.number, debit: verificationRows.debit, credit: verificationRows.credit })
      .from(verificationRows)
      .innerJoin(accounts, eq(accounts.id, verificationRows.accountId))
      .where(eq(verificationRows.verificationId, payment!.verificationId!))
      .orderBy(asc(accounts.number));
    expect(rows.map((r) => [r.number, Number(r.debit) - Number(r.credit)])).toEqual([
      ["1510", -11000],
      ["1930", 11150],
      ["3960", -200],
      ["6570", 50],
    ]);
    const [paid] = await db.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, invoice.id));
    expect(paid!.status).toBe("paid");
  });

  it("a SEK payment on an EUR invoice's OCR is not matched to it, and cannot book it", async () => {
    const customer = await makeCustomer("Blandad Kund AB");
    const sek = await makeIssuedCustomerInvoice(customer.id, { invoiceNumber: "FA-7002", gross: 11000 });
    const eur = await eurInvoice(customer.id, "FA-7003", 1000);
    const { file } = await upload(
      camtFile({
        messageId: "MIXED-1",
        entries: [
          {
            direction: "credit",
            amount: 11000,
            bookingDate: "2024-10-09",
            txs: [{ acctSvcrRef: "SEK-ON-EUR", amount: 11000, refs: [{ type: "SCOR", value: eur.ocrNumber }] }],
          },
        ],
      }) // a SEK payment on the EUR invoice's OCR
    );
    const [entry] = await files.incomingView(file.id);
    expect(entry!.state).toBe("suggested"); // the SEK invoice of the same amount, by amount
    expect(entry!.proposal!.reason).toContain("FA-7003 är i EUR men betalningen är i SEK");
    expect(entry!.proposal!.rows[0]!.invoiceId).toBe(sek.id);
    // Forcing the EUR invoice onto the SEK entry is refused (one currency).
    const { results } = await files.bookIncoming(
      file.id,
      { entries: [{ entryId: entry!.id, customerId: customer.id, rows: [{ invoiceId: eur.id, appliedAmount: 11000 }] }] },
      userId
    );
    expect(results[0]).toMatchObject({ ok: false, error: { code: "payment-mixed-currencies" } });
  });

  it("an entry in another currency than the account's stays Annan valuta", async () => {
    const customer = await makeCustomer("Euro Kund GmbH");
    await eurInvoice(customer.id, "FA-7004", 1000);
    const xml = camtFile({
      messageId: "EURACCT-1",
      entries: [{ direction: "credit", amount: 1000, bookingDate: "2024-10-09", txs: [{ acctSvcrRef: "EURACCT", amount: 1000 }] }],
    }).replaceAll('Ccy="SEK"', 'Ccy="EUR"');
    const { file } = await upload(xml);
    const [entry] = await files.incomingView(file.id);
    expect(entry).toMatchObject({ currency: "EUR", state: "not_sek", proposal: null });
  });
});
