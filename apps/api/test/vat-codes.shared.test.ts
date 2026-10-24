import { describe, expect, it } from "vitest";
import {
  DOMESTIC_VAT_CODES,
  EU_COUNTRY_CODES,
  VAT_BOXES,
  VAT_CODES,
  VAT_CODE_ACCOUNT_FIELDS,
  VAT_CODE_CATALOG,
  VAT_CODE_SLOTS,
  VAT_SETTLED_BOXES,
  computedVatAmount,
  domesticVatCodeForRate,
  importVatSchema,
  isDomesticVatCode,
  isEuCountry,
  reverseVatPreview,
  updateVatCodeSchema,
  vatCodeAllowedOn,
  vatCodeEntry,
  vatCodeTakesCatchAllRule,
  vatNumberPrefix,
  vatRates,
} from "@navet/shared";

// Momskoder: the pure catalog and the helpers every consumer shares.

describe("the momskod catalog", () => {
  it("lists every code once, in VAT_CODES order", () => {
    expect(VAT_CODE_CATALOG.map((entry) => entry.code)).toEqual([...VAT_CODES]);
  });

  it("uses only Swedish rates, four-digit accounts and declaration boxes", () => {
    for (const entry of VAT_CODE_CATALOG) {
      expect(vatRates).toContain(entry.rate);
      for (const [slot, value] of Object.entries(entry.slots)) {
        expect(VAT_CODE_SLOTS).toContain(slot);
        expect(value.account).toMatch(/^[0-9]{4}$/);
        expect([...VAT_BOXES, "none"]).toContain(value.box);
      }
    }
  });

  it("gives each kind the slots its posting needs", () => {
    for (const entry of VAT_CODE_CATALOG) {
      const slots = Object.keys(entry.slots).sort();
      const expected = {
        domestic: entry.rate === 0 ? ["revenue"] : ["inputVat", "outputVat", "revenue"],
        eu_sale: ["revenue"],
        export: ["revenue"],
        reverse_sale: ["revenue"],
        reverse_purchase: ["cost", "inputVat", "outputVat"],
        non_eu_goods: [],
        import: ["base", "baseCounter", "inputVat", "outputVat"],
      }[entry.kind];
      expect({ code: entry.code, slots }).toEqual({ code: entry.code, slots: expected });
    }
  });

  it("puts every VAT slot in a box the momsomföring empties", () => {
    for (const entry of VAT_CODE_CATALOG) {
      for (const slot of ["outputVat", "inputVat"] as const) {
        const value = entry.slots[slot];
        if (value) expect(VAT_SETTLED_BOXES as readonly string[]).toContain(value.box);
      }
    }
  });

  it("requires the buyer's VAT number exactly for EU sales and omvänd betalningsskyldighet", () => {
    expect(VAT_CODE_CATALOG.filter((entry) => entry.requiresBuyerVatNumber).map((entry) => entry.code)).toEqual(["EUV", "EUT", "OB"]);
  });

  it("maps every account field to its slot", () => {
    expect(Object.keys(VAT_CODE_ACCOUNT_FIELDS).sort()).toEqual([...VAT_CODE_SLOTS].sort());
  });
});

describe("helpers", () => {
  it("translates a Swedish rate to its domestic code", () => {
    expect(vatRates.map(domesticVatCodeForRate)).toEqual(["MP25", "MP12", "MP6", "MF"]);
    expect([...DOMESTIC_VAT_CODES].every(isDomesticVatCode)).toBe(true);
    expect(isDomesticVatCode("EUV")).toBe(false);
  });

  it("allows a code on the documents of its direction", () => {
    expect(vatCodeAllowedOn("MP25", "sales")).toBe(true);
    expect(vatCodeAllowedOn("MP25", "purchase")).toBe(true);
    expect(vatCodeAllowedOn("EUV", "purchase")).toBe(false);
    expect(vatCodeAllowedOn("IEUV25", "sales")).toBe(false);
    expect(vatCodeAllowedOn("IMP25", "purchase")).toBe(false);
    expect(vatCodeAllowedOn("IMP25", "import")).toBe(true);
    expect(vatCodeAllowedOn("MP25", "import")).toBe(false);
  });

  it("lets the catch-all rule take domestic codes and IUTV only", () => {
    expect(VAT_CODES.filter(vatCodeTakesCatchAllRule)).toEqual(["MP25", "MP12", "MP6", "MF", "IUTV"]);
  });

  it("knows the 27 member states and writes Greece as EL in a VAT number", () => {
    expect(EU_COUNTRY_CODES).toHaveLength(27);
    expect(isEuCountry("de")).toBe(true);
    expect(isEuCountry("NO")).toBe(false);
    expect(isEuCountry("GB")).toBe(false);
    expect(vatNumberPrefix("GR")).toBe("EL");
    expect(vatNumberPrefix("de")).toBe("DE");
  });

  it("rounds computed VAT half away from zero in both directions", () => {
    expect(computedVatAmount(1000.02, 25)).toBe(250.01);
    expect(computedVatAmount(-1000.02, 25)).toBe(-250.01);
    expect(computedVatAmount(1000, 12)).toBe(120);
    expect(computedVatAmount(0.1, 6)).toBe(0.01);
    expect(vatCodeEntry("IUTT").rate).toBe(25);
  });
});

describe("reverseVatPreview", () => {
  it("is empty for a domestic invoice", () => {
    expect(reverseVatPreview({ headerCode: "MP25", netAmount: 1000, rows: [{ code: null, lineAmount: 1000 }] })).toEqual([]);
  });

  it("puts rows without a code and the remainder under the header's code", () => {
    expect(
      reverseVatPreview({
        headerCode: "IEUV25",
        netAmount: 1500,
        rows: [
          { code: null, lineAmount: 800 },
          { code: "MP25", lineAmount: 200 },
        ],
      })
    ).toEqual([{ code: "IEUV25", base: 1300, vat: 325 }]);
  });

  it("lists one entry per omvänd code in catalog order", () => {
    expect(
      reverseVatPreview({
        headerCode: "MP25",
        netAmount: 2000,
        rows: [
          { code: "IOBT", lineAmount: 300 },
          { code: "IEUV12", lineAmount: 500 },
          { code: "IEUV12", lineAmount: 100.5 },
          { code: null, lineAmount: 1000 },
        ],
      })
    ).toEqual([
      { code: "IEUV12", base: 600.5, vat: 72.06 },
      { code: "IOBT", base: 300, vat: 75 },
    ]);
  });

  it("leaves out a code whose rows net to zero", () => {
    expect(
      reverseVatPreview({
        headerCode: "MP25",
        netAmount: 0,
        rows: [
          { code: "IEUT", lineAmount: 100 },
          { code: "IEUT", lineAmount: -100 },
        ],
      })
    ).toEqual([]);
  });
});

describe("schemas", () => {
  it("updateVatCodeSchema: accounts are four digits or \"\", no unknown fields, at least one field", () => {
    expect(updateVatCodeSchema.safeParse({ revenueAccount: "3108" }).success).toBe(true);
    expect(updateVatCodeSchema.safeParse({ revenueAccount: "" }).success).toBe(true);
    expect(updateVatCodeSchema.safeParse({ revenueAccount: "310" }).success).toBe(false);
    expect(updateVatCodeSchema.safeParse({ rate: 25 }).success).toBe(false);
    expect(updateVatCodeSchema.safeParse({}).success).toBe(false);
    expect(updateVatCodeSchema.parse({ invoiceText: "" }).invoiceText).toBeNull();
  });

  it("importVatSchema: at least one row with a positive tax base", () => {
    const id = "00000000-0000-0000-0000-000000000000";
    expect(importVatSchema.safeParse({ date: "2030-01-15", description: "Tull", rows: [{ vatCodeId: id, taxBase: "100.50" }] }).success).toBe(true);
    expect(importVatSchema.safeParse({ date: "2030-01-15", description: "Tull", rows: [] }).success).toBe(false);
    expect(importVatSchema.safeParse({ date: "2030-01-15", description: "Tull", rows: [{ vatCodeId: id, taxBase: 0 }] }).success).toBe(false);
    expect(importVatSchema.safeParse({ date: "2030-01-15", description: "", rows: [{ vatCodeId: id, taxBase: 1 }] }).success).toBe(false);
  });
});
