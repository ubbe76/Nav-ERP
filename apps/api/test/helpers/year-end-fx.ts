import { vi } from "vitest";
import { customers, db, suppliers } from "@navet/db";
import { createAuditRepository } from "../../src/modules/system/repository/audit.repository.js";
import type { YearEndClosingService } from "../../src/modules/economy/service/year-end-closing.service.js";
import { createSupplierInvoiceRepository } from "../../src/modules/purchase/repository/supplier-invoice.repository.js";
import { createSupplierInvoiceService } from "../../src/modules/purchase/service/supplier-invoice.service.js";
import { createSupplierPaymentRepository } from "../../src/modules/purchase/repository/supplier-payment.repository.js";
import { createSupplierPaymentService } from "../../src/modules/purchase/service/supplier-payment.service.js";
import { createInvoiceRepository } from "../../src/modules/sales/repository/invoice.repository.js";
import { createInvoiceService } from "../../src/modules/sales/service/invoice.service.js";
import { createPaymentRepository } from "../../src/modules/sales/repository/payment.repository.js";
import { createPaymentService } from "../../src/modules/sales/service/payment.service.js";
import { ExchangeRateUnavailableError, type ExchangeRateReader } from "../../src/modules/system/service/exchange-rates.js";
import { YEAR, setupYearEnd, testYearEndPoster } from "./year-end.js";
import { vatCodeId } from "./vat-codes.js";

// Valuta steg 4 fixtures: real EUR invoices booked in the closing year
// (Utfärda and attest through their own services), the payments, and a
// stub rate reader — the suites never call Riksbanken.

export function stubExchangeRates() {
  const rates = new Map<string, number>();
  const lookups: { currency: string; date: string }[] = [];
  const reader: ExchangeRateReader = {
    async getRate(currency, date) {
      lookups.push({ currency, date });
      const rate = rates.get(currency);
      if (rate === undefined) throw new ExchangeRateUnavailableError(currency, date);
      return { currency, requestedDate: date, date, rate, source: "riksbank" };
    },
  };
  return { rates, lookups, reader };
}

const audit = createAuditRepository(db);
const mailStub = { async sendMail() { return null; } };
const pdfStub = { async render() { return Buffer.alloc(0); }, async renderPaymentReminder() { return Buffer.alloc(0); } };
export const fxInvoiceService = createInvoiceService(createInvoiceRepository(db), mailStub, pdfStub, testYearEndPoster, audit);
export const fxPaymentService = createPaymentService(createPaymentRepository(db), testYearEndPoster, audit);
export const fxSupplierInvoiceService = createSupplierInvoiceService(createSupplierInvoiceRepository(db), testYearEndPoster);
export const fxSupplierPaymentService = createSupplierPaymentService(createSupplierPaymentRepository(db), testYearEndPoster);

export async function eurCustomer() {
  const [row] = await db
    .insert(customers)
    .values({ name: "Kunde GmbH", customerNumber: `FX-${crypto.randomUUID()}`, currency: "EUR", active: true })
    .returning();
  return row!;
}

export async function eurSupplier() {
  const [row] = await db
    .insert(suppliers)
    .values({ name: "Lieferant GmbH", supplierNumber: `FX-${crypto.randomUUID()}`, currency: "EUR", country: "DE", active: true })
    .returning();
  return row!;
}

// Utfärda dates the invoice "today" — pin today inside the closing year.
export async function asOf<T>(date: string, run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${date}T10:00:00Z`));
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
}

// An issued customer invoice in EUR: net + 25 % VAT, booked at `rate`.
export async function issuedEurInvoice(customerId: string, userId: string, net: number, rate: number, date = `${YEAR}-11-15`) {
  return asOf(date, async () => {
    const draft = await fxInvoiceService.create(
      { customerId, currency: "EUR", exchangeRate: rate, rows: [{ description: "Leverans", quantity: 1, unitPrice: net, vatRate: 25 }] } as never,
      userId
    );
    return (await fxInvoiceService.issue(draft!.id, userId))!;
  });
}

export async function issuedEurCredit(sourceId: string, userId: string, date = `${YEAR}-11-25`) {
  return asOf(date, async () => {
    const credit = await fxInvoiceService.createCredit(sourceId, {}, userId);
    return (await fxInvoiceService.issue(credit!.id, userId))!;
  });
}

// An attested supplier invoice in EUR (EU purchase, reverse charge) at `rate`.
export async function attestedEurInvoice(supplierId: string, userId: string, gross: number, rate: number, date = `${YEAR}-11-20`) {
  const created = await fxSupplierInvoiceService.create(
    {
      supplierId,
      invoiceNumber: `E-${crypto.randomUUID().slice(0, 8)}`,
      invoiceDate: date,
      netAmount: gross,
      vatAmount: 0,
      grossAmount: gross,
      exchangeRate: rate,
      vatCodeId: await vatCodeId("IEUV25"),
      rows: [],
    },
    userId
  );
  return (await fxSupplierInvoiceService.approve(created!.id, userId))!;
}

// 1000 EUR receivable (800 + 25 % VAT) and 500 EUR payable, both booked at
// 11,00 in YEAR, and a started closing.
export async function openEurItems(service: YearEndClosingService) {
  const { user, yearId } = await setupYearEnd();
  const customer = await eurCustomer();
  const supplier = await eurSupplier();
  const invoice = await issuedEurInvoice(customer.id, user.id, 800, 11);
  const supplierInvoice = await attestedEurInvoice(supplier.id, user.id, 500, 11);
  const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
  return { user, yearId, customer, supplier, invoice, supplierInvoice, closing };
}
