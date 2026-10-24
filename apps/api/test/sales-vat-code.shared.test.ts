import { describe, expect, it } from "vitest";
import {
  buyerVatNumberProblem,
  buyerVatNumberWarning,
  CUSTOMER_VAT_TREATMENT_LABELS,
  CUSTOMER_VAT_TREATMENTS,
  customerVatNumberWarning,
  customerVatTreatment,
  normalizeVatNumber,
  salesRowIsGoods,
  salesVatCode,
  supplierDefaultVatCode,
  hasVatNumber,
  VAT_CODES,
  type SalesVatCustomer,
} from "@navet/shared";
import * as webCodes from "../../web/lib/vatCodes.js";

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
  it("1. a private person in the EU (Sweden included) gets the article's domestic code", () => {
    for (const country of ["SE", "DE", " fi ", "GR"]) {
      const c = customer({ country, privatePerson: true, vatNumber: "DE123456789", reverseChargeConstruction: true });
      expect(salesVatCode({ customer: c, isGoods: true, articleRate: 25 })).toBe("MP25");
      expect(salesVatCode({ customer: c, isGoods: false, articleRate: 12 })).toBe("MP12");
      expect(salesVatCode({ customer: c, isGoods: true, articleRate: 6 })).toBe("MP6");
      expect(salesVatCode({ customer: c, isGoods: true, articleRate: 0 })).toBe("MF");
    }
  });

  it("1. a private person outside the EU: goods are export (EXV, artikel 146), services svensk moms", () => {
    for (const country of ["NO", "US", " ch "]) {
      const c = customer({ country, privatePerson: true, reverseChargeConstruction: true });
      expect(salesVatCode({ customer: c, isGoods: true, articleRate: 25 })).toBe("EXV");
      expect(salesVatCode({ customer: c, isGoods: true, articleRate: 0 })).toBe("EXV");
      expect(salesVatCode({ customer: c, isGoods: false, articleRate: 25 })).toBe("MP25");
      expect(salesVatCode({ customer: c, isGoods: false, articleRate: 6 })).toBe("MP6");
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
    expect(customerVatTreatment(customer({ country: "US", privatePerson: true }))).toBe("private_export");
    expect(customerVatTreatment(customer({ country: " no ", privatePerson: true, vatNumber: "NO123" }))).toBe("private_export");
  });

  it("has a Swedish label for every treatment", () => {
    expect(Object.keys(CUSTOMER_VAT_TREATMENT_LABELS).sort()).toEqual([...CUSTOMER_VAT_TREATMENTS].sort());
    expect(CUSTOMER_VAT_TREATMENT_LABELS.domestic_no_vat_number).toBe("Svensk moms (saknar momsnummer)");
    expect(CUSTOMER_VAT_TREATMENT_LABELS.private_eu).toBe("Privatperson i annat EU-land — svensk moms");
    expect(CUSTOMER_VAT_TREATMENT_LABELS.private_export).toBe("Privatperson utanför EU — export utan moms för varor");
  });
});

describe("customerVatNumberWarning", () => {
  it("is null for every treatment but an EU company customer, and for a number of the customer's own country", () => {
    expect(customerVatNumberWarning(customer({ vatNumber: "DE123456789" }))).toBeNull();
    expect(customerVatNumberWarning(customer({ country: "DE" }))).toBeNull();
    expect(customerVatNumberWarning(customer({ country: "NO", vatNumber: "DE123456789" }))).toBeNull();
    expect(customerVatNumberWarning(customer({ country: "DE", vatNumber: "DE123456789", privatePerson: true }))).toBeNull();
    expect(customerVatNumberWarning(customer({ country: "DE", vatNumber: "de 123.456.789" }))).toBeNull();
    expect(customerVatNumberWarning(customer({ country: "GR", vatNumber: "EL123456789" }))).toBeNull();
  });

  it("warns about another member state's number (allowed) and about a number that is no other member state's", () => {
    expect(customerVatNumberWarning(customer({ country: "DE", vatNumber: "ATU12345678" }))).toEqual({
      reason: "eu_country_mismatch",
      prefix: "AT",
      expectedPrefix: "DE",
    });
    expect(customerVatNumberWarning(customer({ country: "GR", vatNumber: "CY12345678X" }))).toEqual({
      reason: "eu_country_mismatch",
      prefix: "CY",
      expectedPrefix: "EL",
    });
    for (const vatNumber of ["123456789", "SE556677889901", "NO123456789", "GR123456789"]) {
      expect(customerVatNumberWarning(customer({ country: "GR", vatNumber }))).toEqual({ reason: "eu_format", expectedPrefix: "EL" });
    }
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

  it("eu_format: the number must be ANOTHER member state's than Sweden — any of them (Greece EL)", () => {
    expect(buyerVatNumberProblem({ codes: ["EUV"], vatNumber: "de 123456789", country: "DE" })).toBeNull();
    expect(buyerVatNumberProblem({ codes: ["EUT"], vatNumber: "EL123456789", country: "GR" })).toBeNull();
    // Artikel 138 asks for another member state's number, not necessarily
    // the one of the customer's address — a warning, not a refusal.
    expect(buyerVatNumberProblem({ codes: ["EUV"], vatNumber: "ATU12345678", country: "DE" })).toBeNull();
    expect(buyerVatNumberProblem({ codes: ["EUT"], vatNumber: "DE123456789", country: "NO" })).toBeNull();
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
    // A Swedish number is never an EU sale's, whoever the customer is.
    expect(buyerVatNumberProblem({ codes: ["EUV"], vatNumber: "SE556677889901", country: "SE" })).toEqual({
      reason: "eu_format",
      code: "EUV",
      prefix: null,
    });
    expect(buyerVatNumberProblem({ codes: ["EUV"], vatNumber: "SE556677889901", country: "DE" })).toEqual({
      reason: "eu_format",
      code: "EUV",
      prefix: "DE",
    });
    expect(buyerVatNumberProblem({ codes: ["EUV"], vatNumber: "NO123456789", country: "NO" })).toEqual({
      reason: "eu_format",
      code: "EUV",
      prefix: null,
    });
    // Too short / too long after the prefix.
    expect(buyerVatNumberProblem({ codes: ["EUV"], vatNumber: "DE1", country: "DE" })?.reason).toBe("eu_format");
    expect(buyerVatNumberProblem({ codes: ["EUV"], vatNumber: "DE1234567890123", country: "DE" })?.reason).toBe("eu_format");
  });

  it("OB is unchanged by the EU rule: a foreign number is no Swedish reverse-charge number", () => {
    expect(buyerVatNumberProblem({ codes: ["OB"], vatNumber: "DE123456789", country: "SE" })).toEqual({ reason: "ob_format", code: "OB" });
  });

  it("ob_format: SE + ten digits + 01", () => {
    expect(buyerVatNumberProblem({ codes: ["OB"], vatNumber: "SE 556677-8899 01", country: "SE" })).toBeNull();
    expect(buyerVatNumberProblem({ codes: ["OB"], vatNumber: "SE556677889902", country: "SE" })).toEqual({ reason: "ob_format", code: "OB" });
    expect(buyerVatNumberProblem({ codes: ["OB"], vatNumber: "5566778899", country: "SE" })).toEqual({ reason: "ob_format", code: "OB" });
  });
});

describe("buyerVatNumberWarning", () => {
  it("is null without an EU-sale code, for an invalid number and for the customer's own prefix", () => {
    expect(buyerVatNumberWarning({ codes: ["MP25", "OB"], vatNumber: "ATU12345678", country: "DE" })).toBeNull();
    expect(buyerVatNumberWarning({ codes: ["EUV"], vatNumber: "123456789", country: "DE" })).toBeNull();
    expect(buyerVatNumberWarning({ codes: ["EUV"], vatNumber: null, country: "DE" })).toBeNull();
    expect(buyerVatNumberWarning({ codes: ["EUV"], vatNumber: "de123456789", country: " de " })).toBeNull();
    expect(buyerVatNumberWarning({ codes: ["EUT"], vatNumber: "EL123456789", country: "GR" })).toBeNull();
  });

  it("warns when the number belongs to another member state than the customer's country", () => {
    expect(buyerVatNumberWarning({ codes: ["MP25", "EUV"], vatNumber: "ATU12345678", country: "DE" })).toEqual({
      reason: "eu_country_mismatch",
      code: "EUV",
      prefix: "AT",
      expectedPrefix: "DE",
    });
    expect(buyerVatNumberWarning({ codes: ["EUT"], vatNumber: "DE123456789", country: "NO" })).toEqual({
      reason: "eu_country_mismatch",
      code: "EUT",
      prefix: "DE",
      expectedPrefix: "NO",
    });
  });
});

// The web cannot import @navet/shared, so apps/web/lib/vatCodes.ts holds hand-
// kept copies of the derivations — compared here over every customer shape,
// so the previews on the customer card and the invoice forms never disagree
// with what the server derives.
describe("momskod derivations — web mirror", () => {
  const countries = ["SE", "se", " DE ", "GR", "FI", "NO", "US", "GB"];
  const vatNumbers = [null, "", "  ", "DE123456789", "SE556677889901", "ATU12345678", "EL123456789", "123456789"];
  const customers: SalesVatCustomer[] = countries.flatMap((country) =>
    vatNumbers.flatMap((vatNumber) =>
      [false, true].flatMap((privatePerson) =>
        [false, true].map((reverseChargeConstruction) => ({ country, vatNumber, privatePerson, reverseChargeConstruction }))
      )
    )
  );

  it("derives the same salesVatCode, Momsbehandling and VAT number warning for every customer", () => {
    for (const c of customers) {
      expect(webCodes.customerVatTreatment(c)).toBe(customerVatTreatment(c));
      expect(webCodes.customerVatNumberWarning(c)).toEqual(customerVatNumberWarning(c));
      expect(webCodes.hasVatNumber(c.vatNumber)).toBe(hasVatNumber(c.vatNumber));
      for (const isGoods of [true, false]) {
        for (const articleRate of [25, 12, 6, 0, 19]) {
          expect(webCodes.salesVatCode({ customer: c, isGoods, articleRate })).toBe(salesVatCode({ customer: c, isGoods, articleRate }));
        }
      }
    }
  });

  it("has the same treatments and labels", () => {
    expect([...webCodes.CUSTOMER_VAT_TREATMENTS]).toEqual([...CUSTOMER_VAT_TREATMENTS]);
    expect(webCodes.CUSTOMER_VAT_TREATMENT_LABELS).toEqual(CUSTOMER_VAT_TREATMENT_LABELS);
  });

  it("answers salesRowIsGoods, supplierDefaultVatCode and normalizeVatNumber like @navet/shared", () => {
    const rows = [
      { articleId: null, articleType: null, freightArticleId: null },
      { articleId: "a", articleType: "manufactured", freightArticleId: null },
      { articleId: "a", articleType: "service", freightArticleId: null },
      { articleId: "f", articleType: "service", freightArticleId: "f" },
      { articleId: "a", articleType: "service", freightArticleId: "other" },
    ];
    for (const row of rows) expect(webCodes.salesRowIsGoods(row)).toBe(salesRowIsGoods(row));
    for (const country of ["SE", "de", "GR", "CN", " fr "]) {
      expect(webCodes.supplierDefaultVatCode(country)).toBe(supplierDefaultVatCode(country));
    }
    for (const raw of [" de 123.456-789 ", null, undefined, "", "SE 556677-8899 01"]) {
      expect(webCodes.normalizeVatNumber(raw)).toBe(normalizeVatNumber(raw));
    }
  });

  it("answers buyerVatNumberProblem like @navet/shared", () => {
    const numbers = [null, " ", "de 123456789", "DE123456789", "123456789", "EL123456789", "GR123456789", "SE556677889901", "SE556677889902", "NO123456789", "ATU12345678"];
    const countries = ["SE", "DE", "GR", "NO"];
    const codeSets = [["MP25"], ["EUV"], ["EUT"], ["OB"], ["EUV", "OB"], ["MP25", "EXV"], [...VAT_CODES]] as const;
    for (const codes of codeSets) {
      for (const vatNumber of numbers) {
        for (const country of countries) {
          const input = { codes: [...codes], vatNumber, country };
          expect(webCodes.buyerVatNumberProblem(input)).toEqual(buyerVatNumberProblem(input));
        }
      }
    }
  });

  it("answers buyerVatNumberWarning like @navet/shared", () => {
    const numbers = [null, " ", "de 123456789", "DE123456789", "123456789", "EL123456789", "GR123456789", "SE556677889901", "NO123456789", "ATU12345678"];
    const countries = ["SE", "DE", " de ", "GR", "NO", "AT"];
    const codeSets = [["MP25"], ["EUV"], ["EUT"], ["OB"], ["EUV", "OB"], ["MP25", "EXV"], [...VAT_CODES]] as const;
    for (const codes of codeSets) {
      for (const vatNumber of numbers) {
        for (const country of countries) {
          const input = { codes: [...codes], vatNumber, country };
          expect(webCodes.buyerVatNumberWarning(input)).toEqual(buyerVatNumberWarning(input));
        }
      }
    }
  });

  it("has a sentence for every warning", () => {
    expect(webCodes.buyerVatNumberWarningText({ reason: "eu_country_mismatch", code: "EUV", prefix: "AT", expectedPrefix: "DE" })).toBe(
      "Momsnumret har ett annat landsprefix (AT) än kundens land (DE) — kontrollera att det är rätt."
    );
    expect(webCodes.buyerVatNumberWarningText({ reason: "eu_country_mismatch", prefix: "CY", expectedPrefix: "EL" })).toMatch(/\(CY\).*\(EL\)/);
    expect(webCodes.buyerVatNumberWarningText({ reason: "eu_format", expectedPrefix: "EL" })).toMatch(/kundens land EL/);
  });

  it("has a sentence for every problem reason", () => {
    expect(webCodes.buyerVatNumberProblemText({ reason: "missing", code: "EUV" })).toMatch(/saknar momsregistreringsnummer/);
    expect(webCodes.buyerVatNumberProblemText({ reason: "eu_format", code: "EUV", prefix: "DE" })).toMatch(/till exempel DE/);
    expect(webCodes.buyerVatNumberProblemText({ reason: "eu_format", code: "EUV", prefix: null })).toMatch(/annat EU-land/);
    expect(webCodes.buyerVatNumberProblemText({ reason: "ob_format", code: "OB" })).toMatch(/SE \+ tio siffror \+ 01/);
  });
});
