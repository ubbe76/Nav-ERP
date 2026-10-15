import { describe, expect, it } from "vitest";
import {
  SUPPLIER_PAYMENT_METHODS,
  SUPPLIER_PAYMENT_METHOD_LABELS,
  isLuhnValid,
  isValidIban,
  isValidOcrReference,
  normalizeSupplierPaymentDetails,
  paymentReferenceSchema,
  supplierPaymentDetailsProblems,
  type SupplierPaymentDetails,
} from "@navet/shared";
import * as web from "../../web/lib/banking.js";

const NONE: SupplierPaymentDetails = {
  paymentMethod: null, bankgiro: null, plusgiro: null, bankClearing: null, bankAccountNumber: null, iban: null, bic: null,
};

describe("kontrollsiffror", () => {
  it("validates bankgiro/plusgiro/OCR with mod 10", () => {
    expect(isLuhnValid("50501055")).toBe(true); // Bankgiro 5050-1055
    expect(isLuhnValid("4892162")).toBe(true); // Plusgiro 489216-2
    expect(isLuhnValid("4892160")).toBe(false);
    expect(isValidOcrReference("4605127")).toBe(true);
    expect(isValidOcrReference("4605128")).toBe(false);
    expect(isValidOcrReference("1")).toBe(false);
    expect(isValidOcrReference("12345678901234567890123459")).toBe(false); // 26 digits
  });

  it("validates IBAN with mod 97", () => {
    expect(isValidIban("SE4550000000058398257466")).toBe(true);
    expect(isValidIban("DE89370400440532013000")).toBe(true);
    expect(isValidIban("SE4550000000058398257467")).toBe(false);
    expect(isValidIban("se4550000000058398257466")).toBe(false); // normalize first
  });
});

describe("leverantörens betalningsuppgifter", () => {
  it("normalizes spaces, hyphens and case; blank becomes null", () => {
    expect(
      normalizeSupplierPaymentDetails({ bankgiro: "5050-1055", plusgiro: " 48 92 16-2 ", iban: "se45 5000 0000 0583 9825 7466", bic: "eSSesess", bankClearing: "" })
    ).toEqual({ bankgiro: "50501055", plusgiro: "4892162", iban: "SE4550000000058398257466", bic: "ESSESESS", bankClearing: null });
  });

  it("requires the field the payment method names", () => {
    expect(supplierPaymentDetailsProblems({ ...NONE, paymentMethod: "bankgiro" })).toEqual({ bankgiro: "Bankgiro saknas" });
    expect(supplierPaymentDetailsProblems({ ...NONE, paymentMethod: "bank_account", bankClearing: "83279" })).toEqual({
      bankAccountNumber: "Kontonummer saknas",
    });
    expect(supplierPaymentDetailsProblems({ ...NONE, paymentMethod: "iban" })).toEqual({ iban: "IBAN saknas" });
    expect(supplierPaymentDetailsProblems({ ...NONE, paymentMethod: "bankgiro", bankgiro: "50501055" })).toEqual({});
  });

  it("rejects malformed numbers even when another method is chosen", () => {
    expect(supplierPaymentDetailsProblems({ ...NONE, plusgiro: "4892160" })).toEqual({
      plusgiro: "Plusgironumret ska vara 2–8 siffror med giltig kontrollsiffra",
    });
    expect(supplierPaymentDetailsProblems({ ...NONE, bankClearing: "12" })).toEqual({ bankClearing: "Clearingnumret ska vara 4–5 siffror" });
    // Swedbank's 8-series carries a fifth (check) digit; other clearings are 4.
    expect(supplierPaymentDetailsProblems({ ...NONE, bankClearing: "8327" })).toEqual({
      bankClearing: "Clearingnummer i 8-serien (Swedbank) ska vara 5 siffror",
    });
    expect(supplierPaymentDetailsProblems({ ...NONE, bankClearing: "83279" })).toEqual({});
    expect(supplierPaymentDetailsProblems({ ...NONE, bankClearing: "6001" })).toEqual({});
    expect(supplierPaymentDetailsProblems({ ...NONE, bic: "SWED" })).toEqual({ bic: "BIC ska vara 8 eller 11 tecken" });
    expect(supplierPaymentDetailsProblems({ ...NONE, iban: "SE4550000000058398257467" })).toEqual({ iban: "IBAN är ogiltigt" });
  });
});

describe("paymentReferenceSchema", () => {
  it("normalizes and checks an OCR, keeps a message as typed", () => {
    expect(paymentReferenceSchema.parse({ kind: "ocr", value: "460 512-7" })).toEqual({ kind: "ocr", value: "4605127" });
    expect(paymentReferenceSchema.parse({ kind: "message", value: "Faktura 2026-118" })).toEqual({ kind: "message", value: "Faktura 2026-118" });
    expect(paymentReferenceSchema.safeParse({ kind: "ocr", value: "4605128" }).success).toBe(false);
    expect(paymentReferenceSchema.safeParse({ kind: "message", value: "x".repeat(141) }).success).toBe(false);
  });
});

describe("webbspegeln", () => {
  it("has the same payment methods and labels", () => {
    expect([...web.SUPPLIER_PAYMENT_METHODS]).toEqual([...SUPPLIER_PAYMENT_METHODS]);
    expect(web.SUPPLIER_PAYMENT_METHOD_LABELS).toEqual(SUPPLIER_PAYMENT_METHOD_LABELS);
  });

  it("formats accounts the way the bank documents show them", () => {
    expect(web.describeCreditor({ method: "bankgiro", account: "50501055", clearing: null })).toBe("Bankgiro 5050-1055");
    expect(web.describeCreditor({ method: "plusgiro", account: "4892162", clearing: null })).toBe("Plusgiro 489216-2");
    expect(web.describeCreditor({ method: "bank_account", account: "832799941234123", clearing: "83279" })).toBe("Bankkonto 83279, 9941234123");
    expect(web.describeCreditor({ method: "bank_account", account: "9941234123", clearing: "6001" })).toBe("Bankkonto 6001, 9941234123");
  });
});
