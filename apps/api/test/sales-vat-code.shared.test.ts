import { describe, expect, it } from "vitest";
import {
  buyerVatNumberProblem,
  CUSTOMER_VAT_TREATMENT_LABELS,
  CUSTOMER_VAT_TREATMENTS,
  customerVatTreatment,
  normalizeVatNumber,
  salesRowIsGoods,
  salesVatCode,
  supplierDefaultVatCode,
  type SalesVatCustomer,
} from "@navet/shared";

// Momskoder steg 2 (spec 4.1, 4.2, 4.6, 5): the pure derivations — the
// sales row's momskod, the customer's Momsbehandling, the supplier's derived
// förval and Utfärda's momsregistreringsnummer rule. Every branch.

const customer = (overrides: Partial<SalesVatCustomer> = {}): SalesVatCustomer => ({
  country: "SE",
  vatNumber: null,
  privatePerson: false,
  reverseChargeConstruction: false,
  ...overrides,
});

describe("salesVatCode", () => {
  it("1. a private person gets the article's domestic code in any country", () => {
    for (const country of ["SE", "DE", "NO", "US"]) {
      const c = customer({ country, privatePerson: true, vatNumber: "DE123456789", reverseChargeConstruction: true });
      expect(salesVatCode({ customer: c, isGoods: true, articleRate: 25 })).toBe("MP25");
      expect(salesVatCode({ customer: c, isGoods: false, articleRate: 12 })).toBe("MP12");
      expect(salesVatCode({ customer: c, isGoods: true, articleRate: 6 })).toBe("MP6");
      expect(salesVatCode({ customer: c, isGoods: true, articleRate: 0 })).toBe("MF");
    }
  });

  it("2. Sweden: domestic code, OB for a service to a construction reverse-charge customer", () => {
    expect(salesVatCode({ customer: customer(), isGoods: true, articleRate: 25 })).toBe("MP25");
    expect(salesVatCode({ customer: customer(), isGoods: false, articleRate: 0 })).toBe("MF");
    const construction = customer({ reverseChargeConstruction: true });
    expect(salesVatCode({ customer: construction, isGoods: false, articleRate: 25 })).toBe("OB");
    // Goods to the same customer stay svensk moms.
    expect(salesVatCode({ customer: construction, isGoods: true, articleRate: 25 })).toBe("MP25");
    // Lower case / padded country codes are the same country.
    expect(salesVatCode({ customer: customer({ country: " se " }), isGoods: true, articleRate: 12 })).toBe("MP12");
  });

  it("3. another EU country: EUV/EUT with a VAT number, domestic without one", () => {
    const withNumber = customer({ country: "DE", vatNumber: "DE123456789" });
    expect(salesVatCode({ customer: withNumber, isGoods: true, articleRate: 25 })).toBe("EUV");
    expect(salesVatCode({ customer: withNumber, isGoods: false, articleRate: 25 })).toBe("EUT");
    // The construction flag only matters in Sweden.
    expect(salesVatCode({ customer: { ...withNumber, reverseChargeConstruction: true }, isGoods: false, articleRate: 25 })).toBe("EUT");
    const without = customer({ country: "FI", vatNumber: "   " });
    expect(salesVatCode({ customer: without, isGoods: true, articleRate: 25 })).toBe("MP25");
    expect(salesVatCode({ customer: without, isGoods: false, articleRate: 6 })).toBe("MP6");
    // Greece is GR as a country.
    expect(salesVatCode({ customer: customer({ country: "GR", vatNumber: "EL123456789" }), isGoods: true, articleRate: 25 })).toBe("EUV");
  });

  it("4. outside the EU: EXV for goods, EXT for services — with or without a VAT number", () => {
    expect(salesVatCode({ customer: customer({ country: "NO" }), isGoods: true, articleRate: 25 })).toBe("EXV");
    expect(salesVatCode({ customer: customer({ country: "US", vatNumber: "123" }), isGoods: false, articleRate: 25 })).toBe("EXT");
  });

  it("falls back to MP25 for a rate outside the Swedish set", () => {
    expect(salesVatCode({ customer: customer(), isGoods: true, articleRate: 19 })).toBe("MP25");
  });
});

describe("salesRowIsGoods", () => {
  it("goods = not a service, the freight article, or a free row", () => {
    expect(salesRowIsGoods({ articleId: "a", articleType: "manufactured", freightArticleId: null })).toBe(true);
    expect(salesRowIsGoods({ articleId: "a", articleType: "purchased", freightArticleId: "f" })).toBe(true);
    expect(salesRowIsGoods({ articleId: "a", articleType: "service", freightArticleId: null })).toBe(false);
    expect(salesRowIsGoods({ articleId: "a", articleType: "service", freightArticleId: "other" })).toBe(false);
    // The freight article is often a service article — frakt följer varorna.
    expect(salesRowIsGoods({ articleId: "f", articleType: "service", freightArticleId: "f" })).toBe(true);
    expect(salesRowIsGoods({ articleId: null, articleType: null, freightArticleId: null })).toBe(true);
  });
});

describe("customerVatTreatment", () => {
  it("covers every treatment", () => {
    expect(customerVatTreatment(customer())).toBe("domestic");
    expect(customerVatTreatment(customer({ reverseChargeConstruction: true }))).toBe("domestic");
    expect(customerVatTreatment(customer({ country: "DE" }))).toBe("domestic_no_vat_number");
    expect(customerVatTreatment(customer({ country: "DE", vatNumber: "DE123456789" }))).toBe("eu");
    expect(customerVatTreatment(customer({ country: "CH", vatNumber: "CHE-123" }))).toBe("export");
    expect(customerVatTreatment(customer({ country: "DK", privatePerson: true }))).toBe("private_eu");
    expect(customerVatTreatment(customer({ country: "SE", privatePerson: true }))).toBe("domestic");
    expect(customerVatTreatment(customer({ country: "US", privatePerson: true }))).toBe("domestic");
  });

  it("has a Swedish label for every treatment", () => {
    expect(Object.keys(CUSTOMER_VAT_TREATMENT_LABELS).sort()).toEqual([...CUSTOMER_VAT_TREATMENTS].sort());
    expect(CUSTOMER_VAT_TREATMENT_LABELS.domestic_no_vat_number).toBe("Svensk moms (saknar momsnummer)");
    expect(CUSTOMER_VAT_TREATMENT_LABELS.private_eu).toBe("Privatperson i annat EU-land — svensk moms");
  });
});

describe("supplierDefaultVatCode", () => {
  it("SE ⇒ MP25, EU ⇒ IEUV25, otherwise IUTV", () => {
    expect(supplierDefaultVatCode("SE")).toBe("MP25");
    expect(supplierDefaultVatCode("de")).toBe("IEUV25");
    expect(supplierDefaultVatCode("GR")).toBe("IEUV25");
    expect(supplierDefaultVatCode("CN")).toBe("IUTV");
  });
});

describe("normalizeVatNumber", () => {
  it("upper-cases and keeps letters and digits only", () => {
    expect(normalizeVatNumber(" de 123.456-789 ")).toBe("DE123456789");
    expect(normalizeVatNumber(null)).toBe("");
  });
});

describe("buyerVatNumberProblem", () => {
  it("is null when no code requires the buyer's number", () => {
    expect(buyerVatNumberProblem({ codes: ["MP25", "MF", "EXV"], vatNumber: null, country: "NO" })).toBeNull();
  });

  it("missing: an EU sale or OB without a number", () => {
    expect(buyerVatNumberProblem({ codes: ["MP25", "EUV"], vatNumber: " ", country: "DE" })).toEqual({ reason: "missing", code: "EUV" });
    expect(buyerVatNumberProblem({ codes: ["OB"], vatNumber: null, country: "SE" })).toEqual({ reason: "missing", code: "OB" });
  });

  it("eu_format: the number must start with the buyer's own prefix (Greece EL)", () => {
    expect(buyerVatNumberProblem({ codes: ["EUV"], vatNumber: "de 123456789", country: "DE" })).toBeNull();
    expect(buyerVatNumberProblem({ codes: ["EUT"], vatNumber: "EL123456789", country: "GR" })).toBeNull();
    expect(buyerVatNumberProblem({ codes: ["EUV"], vatNumber: "123456789", country: "DE" })).toEqual({
      reason: "eu_format",
      code: "EUV",
      prefix: "DE",
    });
    expect(buyerVatNumberProblem({ codes: ["EUT"], vatNumber: "GR123456789", country: "GR" })).toEqual({
      reason: "eu_format",
      code: "EUT",
      prefix: "EL",
    });
    // A Swedish or non-EU customer can never be an EU sale.
    expect(buyerVatNumberProblem({ codes: ["EUV"], vatNumber: "SE556677889901", country: "SE" })).toEqual({
      reason: "eu_format",
      code: "EUV",
      prefix: null,
    });
    expect(buyerVatNumberProblem({ codes: ["EUV"], vatNumber: "NO123456789", country: "NO" })?.reason).toBe("eu_format");
  });

  it("ob_format: SE + ten digits + 01", () => {
    expect(buyerVatNumberProblem({ codes: ["OB"], vatNumber: "SE 556677-8899 01", country: "SE" })).toBeNull();
    expect(buyerVatNumberProblem({ codes: ["OB"], vatNumber: "SE556677889902", country: "SE" })).toEqual({ reason: "ob_format", code: "OB" });
    expect(buyerVatNumberProblem({ codes: ["OB"], vatNumber: "5566778899", country: "SE" })).toEqual({ reason: "ob_format", code: "OB" });
  });
});
