import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  customerPaymentRows,
  customerPayments,
  customers,
  db,
  invoiceReminders,
  invoiceRows,
  invoices,
  supplierInvoices,
  supplierPaymentRows,
  supplierPayments,
  suppliers,
} from "@navet/db";
import { payablesTotalAsOf } from "../src/modules/purchase/repository/open-amounts.js";
import { receivablesTotalAsOf } from "../src/modules/sales/repository/open-amounts.js";
import { NEXT_YEAR, YEAR, bookManual, createCalendarYear, resetYearEnd, setupYearEnd, testYearEndPoster } from "./helpers/year-end.js";
import { vatCodeId } from "./helpers/vat-codes.js";

beforeEach(resetYearEnd);
afterAll(resetYearEnd);

const D = `${YEAR}-12-31`;
let seq = 0;

// Any balanced booked verification on `date` — only its DATE matters to the
// as-of rule.
async function verificationOn(date: string, userId: string) {
  const booked = await bookManual(date, [{ account: "1930", debit: 1 }, { account: "2091", credit: 1 }], userId);
  return booked.id;
}

async function issuedInvoice(customerId: string, date: string, net: number, vat: number, userId: string, type: "invoice" | "credit" = "invoice") {
  const [invoice] = await db
    .insert(invoices)
    .values({ customerId, type, status: "issued", invoiceDate: date, verificationId: await verificationOn(date, userId) })
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
  return invoice!;
}

async function customerPayment(
  customerId: string,
  invoiceId: string,
  paymentDate: string,
  applied: number,
  userId: string,
  opts: { writeOff?: number; cancelledOn?: string } = {}
) {
  seq += 1;
  const [payment] = await db
    .insert(customerPayments)
    .values({
      paymentNumber: `BET-T${seq}`,
      customerId,
      paymentDate,
      bankAccountNumber: "1930",
      amount: String(applied),
      // Valuta (0145): a SEK payment's SEK amount is its amount.
      amountSek: String(applied),
      verificationId: await verificationOn(paymentDate, userId),
      cancelledAt: opts.cancelledOn ? new Date(`${opts.cancelledOn}T12:00:00Z`) : null,
      cancellationVerificationId: opts.cancelledOn ? await verificationOn(opts.cancelledOn, userId) : null,
    })
    .returning();
  await db.insert(customerPaymentRows).values({
    paymentId: payment!.id,
    invoiceId,
    appliedAmount: String(applied),
    writeOffAmount: String(opts.writeOff ?? 0),
    appliedAmountSek: String(applied),
    writeOffAmountSek: String(opts.writeOff ?? 0),
  });
}

describe("receivablesTotalAsOf", () => {
  it("counts documents and payments on their ledger dates", async () => {
    const { user } = await setupYearEnd();
    await createCalendarYear(NEXT_YEAR);
    const [customer] = await db.insert(customers).values({ name: "Kund AB", customerNumber: "K-T1", active: true }).returning();
    const a = await issuedInvoice(customer!.id, `${YEAR}-11-10`, 10000, 2500, user.id); // +12 500
    await issuedInvoice(customer!.id, `${YEAR}-12-05`, 1000, 250, user.id, "credit"); //  −1 250
    await issuedInvoice(customer!.id, `${NEXT_YEAR}-01-03`, 4000, 1000, user.id); // after D: not counted
    await customerPayment(customer!.id, a.id, `${YEAR}-12-20`, 5000, user.id, { writeOff: 4 }); // −5 004
    await customerPayment(customer!.id, a.id, `${YEAR}-12-28`, 3000, user.id, { cancelledOn: `${NEXT_YEAR}-01-15` }); // −3 000 (paid as of D)
    await customerPayment(customer!.id, a.id, `${YEAR}-12-10`, 1000, user.id, { cancelledOn: `${YEAR}-12-12` }); // cancelled by D: not counted
    await customerPayment(customer!.id, a.id, `${NEXT_YEAR}-01-05`, 2000, user.id); // after D: not counted
    await db.insert(invoiceReminders).values({ invoiceId: a.id, level: 1, fee: "60", feeVerificationId: await verificationOn(`${YEAR}-12-15`, user.id) }); // +60

    expect(await receivablesTotalAsOf(db, D)).toBe(3306);
    expect(await receivablesTotalAsOf(db, `${YEAR}-11-30`)).toBe(12500);
  });
});

describe("payablesTotalAsOf", () => {
  it("counts approved invoices until their reversal date and payments until cancelled", async () => {
    const { user } = await setupYearEnd();
    await createCalendarYear(NEXT_YEAR);
    const [supplier] = await db.insert(suppliers).values({ supplierNumber: "L-T1", name: "Leverantör AB" }).returning();
    async function supplierInvoice(n: number, gross: number, date: string, reversedOn?: string) {
      const verificationId = await verificationOn(date, user.id);
      if (reversedOn) {
        await db.transaction((tx) =>
          testYearEndPoster.reverseBookedVerification(tx, verificationId, { date: reversedOn, description: "Makulerad" }, user.id)
        );
      }
      const [row] = await db
        .insert(supplierInvoices)
        .values({
          registrationNumber: `LF-T${n}`,
          invoiceNumber: `F${n}`,
          supplierId: supplier!.id,
          vatCodeId: await vatCodeId("MP25"),
          invoiceDate: date,
          status: reversedOn ? "cancelled" : "approved",
          grossAmount: String(gross),
          // Valuta: the attest stamps the SEK debt — what the reskontra sums.
          grossAmountSek: String(gross),
          verificationId,
        })
        .returning();
      return row!;
    }
    const si1 = await supplierInvoice(1, 8000, `${YEAR}-11-01`);
    await supplierInvoice(2, 2000, `${YEAR}-11-02`, `${NEXT_YEAR}-02-01`); // cancelled after D: counts
    await supplierInvoice(3, 1500, `${YEAR}-11-03`, `${YEAR}-12-01`); // cancelled before D: not counted
    await supplierInvoice(4, -500, `${YEAR}-12-02`); // credit note
    const [payment] = await db
      .insert(supplierPayments)
      .values({
        paymentNumber: "UT-T1",
        supplierId: supplier!.id,
        paymentDate: `${YEAR}-12-15`,
        bankAccountNumber: "1930",
        amount: "3000",
        amountSek: "3000",
        verificationId: await verificationOn(`${YEAR}-12-15`, user.id),
      })
      .returning();
    await db
      .insert(supplierPaymentRows)
      .values({ paymentId: payment!.id, supplierInvoiceId: si1.id, appliedAmount: "3000", appliedAmountSek: "3000" });

    expect(await payablesTotalAsOf(db, D)).toBe(6500);
  });
});

async function supplierPayment(
  supplierId: string,
  supplierInvoiceId: string,
  paymentDate: string,
  applied: number,
  userId: string,
  opts: { writeOff?: number; cancelledOn?: string } = {}
) {
  seq += 1;
  const [payment] = await db
    .insert(supplierPayments)
    .values({
      paymentNumber: `UT-P${seq}`,
      supplierId,
      paymentDate,
      bankAccountNumber: "1930",
      amount: String(applied),
      amountSek: String(applied),
      verificationId: await verificationOn(paymentDate, userId),
      cancelledAt: opts.cancelledOn ? new Date(`${opts.cancelledOn}T12:00:00Z`) : null,
      cancellationVerificationId: opts.cancelledOn ? await verificationOn(opts.cancelledOn, userId) : null,
    })
    .returning();
  await db.insert(supplierPaymentRows).values({
    paymentId: payment!.id,
    supplierInvoiceId,
    appliedAmount: String(applied),
    writeOffAmount: String(opts.writeOff ?? 0),
    appliedAmountSek: String(applied),
    writeOffAmountSek: String(opts.writeOff ?? 0),
  });
}

describe("payablesTotalAsOf — payments", () => {
  it("counts write-offs and a payment until its cancellation date", async () => {
    const { user } = await setupYearEnd();
    await createCalendarYear(NEXT_YEAR);
    const [supplier] = await db.insert(suppliers).values({ supplierNumber: "L-T2", name: "Leverantör AB" }).returning();
    const [invoice] = await db
      .insert(supplierInvoices)
      .values({
        registrationNumber: "LF-P1",
        invoiceNumber: "P1",
        supplierId: supplier!.id,
        vatCodeId: await vatCodeId("MP25"),
        invoiceDate: `${YEAR}-11-01`,
        status: "approved",
        grossAmount: "10000",
        grossAmountSek: "10000",
        verificationId: await verificationOn(`${YEAR}-11-01`, user.id),
      })
      .returning();
    const id = invoice!.id;
    await supplierPayment(supplier!.id, id, `${YEAR}-12-10`, 3000, user.id, { writeOff: 5 }); // −3 005
    await supplierPayment(supplier!.id, id, `${YEAR}-12-12`, 1000, user.id, { cancelledOn: `${YEAR}-12-14` }); // cancelled by D: not counted
    await supplierPayment(supplier!.id, id, `${YEAR}-12-20`, 2000, user.id, { cancelledOn: `${NEXT_YEAR}-01-10` }); // −2 000 (paid as of D)
    await supplierPayment(supplier!.id, id, `${NEXT_YEAR}-01-05`, 500, user.id); // after D: not counted

    expect(await payablesTotalAsOf(db, D)).toBe(4995);
    expect(await payablesTotalAsOf(db, `${YEAR}-12-13`)).toBe(5995);
  });

  it("keeps an approved invoice whose L verification was reversed without cancelling it", async () => {
    const { user } = await setupYearEnd();
    const [supplier] = await db.insert(suppliers).values({ supplierNumber: "L-T3", name: "Leverantör AB" }).returning();
    const verificationId = await verificationOn(`${YEAR}-11-01`, user.id);
    // A manual Omför booked in the year — the invoice itself stays approved.
    await db.transaction((tx) =>
      testYearEndPoster.reverseBookedVerification(tx, verificationId, { date: `${YEAR}-12-01`, description: "Omföring" }, user.id)
    );
    await db.insert(supplierInvoices).values({
      registrationNumber: "LF-R1",
      invoiceNumber: "R1",
      supplierId: supplier!.id,
      vatCodeId: await vatCodeId("MP25"),
      invoiceDate: `${YEAR}-11-01`,
      status: "approved",
      grossAmount: "4000",
      grossAmountSek: "4000",
      verificationId,
    });

    expect(await payablesTotalAsOf(db, D)).toBe(4000);
  });

  // Valuta: the sum is SEK — the EUR invoice counts with its stamped debt
  // and the payment with the SEK it released, never in their own currency.
  it("sums gross_amount_sek − released SEK, never an EUR amount next to a SEK one", async () => {
    const { user } = await setupYearEnd();
    const [supplier] = await db.insert(suppliers).values({ supplierNumber: "L-T4", name: "Lieferant GmbH", currency: "EUR" }).returning();
    const [eur] = await db
      .insert(supplierInvoices)
      .values({
        registrationNumber: "LF-V1",
        invoiceNumber: "V1",
        supplierId: supplier!.id,
        vatCodeId: await vatCodeId("IEUV25"),
        invoiceDate: `${YEAR}-11-01`,
        status: "approved",
        currency: "EUR",
        exchangeRate: "11.131",
        exchangeRateSource: "manual",
        grossAmount: "1000",
        grossAmountSek: "11131",
        verificationId: await verificationOn(`${YEAR}-11-01`, user.id),
      })
      .returning();
    await db.insert(supplierInvoices).values({
      registrationNumber: "LF-V2",
      invoiceNumber: "V2",
      supplierId: supplier!.id,
      vatCodeId: await vatCodeId("MP25"),
      invoiceDate: `${YEAR}-11-02`,
      status: "approved",
      grossAmount: "500",
      grossAmountSek: "500",
      verificationId: await verificationOn(`${YEAR}-11-02`, user.id),
    });
    const [payment] = await db
      .insert(supplierPayments)
      .values({
        paymentNumber: "UT-V1",
        supplierId: supplier!.id,
        paymentDate: `${YEAR}-12-01`,
        bankAccountNumber: "1930",
        currency: "EUR",
        amount: "400",
        amountSek: "4500",
        verificationId: await verificationOn(`${YEAR}-12-01`, user.id),
      })
      .returning();
    await db
      .insert(supplierPaymentRows)
      .values({ paymentId: payment!.id, supplierInvoiceId: eur!.id, appliedAmount: "400", appliedAmountSek: "4452.40" });

    // 11 131 + 500 − 4 452,40 (the SEK the 400 EUR released, not the 4 500 the bank moved).
    expect(await payablesTotalAsOf(db, D)).toBe(7178.6);
  });
});
