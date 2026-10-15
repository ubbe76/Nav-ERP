import { describe, expect, it } from "vitest";
import {
  DEFAULT_VAT_RATE,
  createSupplierInvoiceRowSchema,
  isVatRate,
  updateSupplierInvoiceRowSchema,
  vatRateSchema,
  vatRates,
} from "@navet/shared";

// B5: the Swedish VAT rate set lives in exactly one place
// (packages/shared/src/vat.ts). These tests pin the module's shape; the
// pre-existing suites for article/posting-rule schemas double as the
// regression net for the move out of article.ts/economy.ts.
describe("vat constants", () => {
  it("exposes the Swedish rate set, highest first", () => {
    expect([...vatRates]).toEqual([25, 12, 6, 0]);
  });

  it("isVatRate accepts exactly the four rates", () => {
    for (const rate of [25, 12, 6, 0]) {
      expect(isVatRate(rate)).toBe(true);
    }
    for (const rate of [21.5, 100, -25, 1, Number.NaN]) {
      expect(isVatRate(rate)).toBe(false);
    }
  });

  it("free invoice rows default to the standard rate", () => {
    expect(DEFAULT_VAT_RATE).toBe(25);
  });
});

describe("vatRateSchema (moved to vat.ts)", () => {
  it("accepts the four rates and coerces strings", () => {
    for (const rate of [25, 12, 6, 0]) {
      expect(vatRateSchema.parse(rate)).toBe(rate);
    }
    expect(vatRateSchema.parse("12")).toBe(12);
  });

  it("rejects rates outside the set", () => {
    expect(() => vatRateSchema.parse(21.5)).toThrow();
    expect(() => vatRateSchema.parse(20)).toThrow();
  });
});

// B5 harmonization: supplier-invoice rows used to accept any 0-100 rate,
// inconsistent with the sales side. Same enum on both sides now; null still
// means "no rate" (freight/fee lines — only a posting-rule lookup key).
describe("supplier invoice row vatRate is enum-locked", () => {
  const base = { description: "Frakt", unitPrice: 100 };

  it("create: accepts the four Swedish rates and omission", () => {
    for (const vatRate of [25, 12, 6, 0]) {
      expect(() => createSupplierInvoiceRowSchema.parse({ ...base, vatRate })).not.toThrow();
    }
    expect(() => createSupplierInvoiceRowSchema.parse(base)).not.toThrow();
  });

  it("create: rejects a rate outside the Swedish set", () => {
    expect(() => createSupplierInvoiceRowSchema.parse({ ...base, vatRate: 21.5 })).toThrow();
    expect(() => createSupplierInvoiceRowSchema.parse({ ...base, vatRate: 20 })).toThrow();
  });

  it("update: accepts null (clear the rate) and rejects out-of-set rates", () => {
    expect(() => updateSupplierInvoiceRowSchema.parse({ vatRate: null })).not.toThrow();
    expect(() => updateSupplierInvoiceRowSchema.parse({ vatRate: 6 })).not.toThrow();
    expect(() => updateSupplierInvoiceRowSchema.parse({ vatRate: 20 })).toThrow();
  });
});
