import { describe, expect, it } from "vitest";
import {
  createQuoteSchema,
  createPaymentSchema,
  createSupplierInvoiceSchema,
  createSupplierPaymentSchema,
  verificationRowInputSchema,
} from "@navet/shared";

// Pure schema tests — no database. The blank-string guard (Package 2.2):
// Number("") is 0, so a cleared form field must FAIL coercion, never become a
// phantom zero. Money fields stay SIGNED — an AP credit note is a supplier
// invoice with negative amounts (see purchase open-amounts.ts), and payments
// settling only credits are negative too.

const uuid = "5b3f2a10-0000-4000-8000-000000000001";

describe("blank-string guard on amounts and quantities", () => {
  it("rejects blank supplier-invoice amounts instead of coercing to 0", () => {
    const base = { supplierId: uuid, invoiceNumber: "LF-1", invoiceDate: "2026-08-23" };
    expect(() => createSupplierInvoiceSchema.parse({ ...base, netAmount: "" })).toThrow();
    expect(() => createSupplierInvoiceSchema.parse({ ...base, vatAmount: " " })).toThrow();
    expect(() => createSupplierInvoiceSchema.parse({ ...base, grossAmount: "" })).toThrow();
  });

  it("still accepts NEGATIVE supplier-invoice amounts — an AP credit note is a negative invoice", () => {
    const parsed = createSupplierInvoiceSchema.parse({
      supplierId: uuid,
      invoiceNumber: "KREDIT-1",
      invoiceDate: "2026-08-23",
      netAmount: -400,
      vatAmount: -100,
      grossAmount: -500,
    });
    expect(parsed.grossAmount).toBe(-500);
  });

  it("rejects blank payment amounts on both AR and AP but keeps them signed", () => {
    expect(() =>
      createSupplierPaymentSchema.parse({
        supplierId: uuid,
        paymentDate: "2026-08-23",
        bankAccountNumber: "1930",
        amount: "",
        rows: [{ supplierInvoiceId: uuid, appliedAmount: 100 }],
      })
    ).toThrow();
    expect(
      createSupplierPaymentSchema.parse({
        supplierId: uuid,
        paymentDate: "2026-08-23",
        bankAccountNumber: "1930",
        amount: -500,
        rows: [{ supplierInvoiceId: uuid, appliedAmount: -500 }],
      }).amount
    ).toBe(-500);
    expect(() =>
      createPaymentSchema.parse({
        paymentDate: "2026-08-23",
        bankAccountNumber: "1930",
        amount: "",
        rows: [{ invoiceId: uuid, appliedAmount: 100 }],
      })
    ).toThrow();
  });

  it("rejects blank verification debit/credit", () => {
    expect(() => verificationRowInputSchema.parse({ accountId: uuid, debit: "", credit: 100 })).toThrow();
    expect(() => verificationRowInputSchema.parse({ accountId: uuid, debit: 100, credit: "" })).toThrow();
  });

  it("rejects blank sales quantities", () => {
    expect(() =>
      createQuoteSchema.parse({
        customerId: uuid,
        rows: [{ articleId: uuid, quantity: "", unitPrice: 10 }],
      })
    ).toThrow();
  });
});
