import { describe, expect, it } from "vitest";
import {
  DOMESTIC_VAT_CODES,
  EU_COUNTRY_CODES,
  VAT_BOXES,
  VAT_BOX_49_LABEL,
  VAT_CODES,
  VAT_CODE_ACCOUNT_FIELDS,
  VAT_CODE_CATALOG,
  VAT_CODE_DIRECTIONS,
  VAT_CODE_KINDS,
  VAT_CODE_SLOTS,
  VAT_REPORTING_PERIODS,
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
import { findRuleBoxMismatches } from "../src/modules/economy/service/vat-report.service.js";
import * as webBoxes from "../../web/lib/vatBoxes.js";
import * as webCodes from "../../web/lib/vatCodes.js";

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

// The web cannot import @navet/shared, so apps/web/lib/vatCodes.ts (and the
// box additions in vatBoxes.ts) are hand-kept copies — compared here.
describe("momskoder — web mirror", () => {
  it("has the same lists, catalog and EU countries as @navet/shared", () => {
    expect([...webCodes.VAT_CODES]).toEqual([...VAT_CODES]);
    expect([...webCodes.VAT_CODE_DIRECTIONS]).toEqual([...VAT_CODE_DIRECTIONS]);
    expect([...webCodes.VAT_CODE_KINDS]).toEqual([...VAT_CODE_KINDS]);
    expect([...webCodes.VAT_CODE_SLOTS]).toEqual([...VAT_CODE_SLOTS]);
    expect([...webCodes.DOMESTIC_VAT_CODES]).toEqual([...DOMESTIC_VAT_CODES]);
    expect([...webCodes.EU_COUNTRY_CODES]).toEqual([...EU_COUNTRY_CODES]);
    expect(webCodes.VAT_CODE_ACCOUNT_FIELDS).toEqual(VAT_CODE_ACCOUNT_FIELDS);
    expect(webCodes.VAT_CODE_CATALOG).toEqual(VAT_CODE_CATALOG);
  });

  it("has the same ruta additions as @navet/shared", () => {
    expect([...webBoxes.VAT_BOXES]).toEqual([...VAT_BOXES]);
    expect(webBoxes.VAT_BOX_49_LABEL).toBe(VAT_BOX_49_LABEL);
    expect([...webBoxes.VAT_SETTLED_BOXES]).toEqual([...VAT_SETTLED_BOXES]);
    expect([...webBoxes.VAT_REPORTING_PERIODS]).toEqual([...VAT_REPORTING_PERIODS]);
  });

  it("has a Swedish label for every slot, kind and direction", () => {
    for (const slot of VAT_CODE_SLOTS) expect(webCodes.VAT_CODE_SLOT_LABELS[slot]).toMatch(/\S/);
    for (const slot of VAT_CODE_SLOTS) expect(webCodes.VAT_CODE_SLOT_SHORT_LABELS[slot]).toMatch(/\S/);
    for (const kind of VAT_CODE_KINDS) expect(webCodes.VAT_CODE_KIND_LABELS[kind]).toMatch(/\S/);
    for (const direction of VAT_CODE_DIRECTIONS) expect(webCodes.VAT_CODE_DIRECTION_LABELS[direction]).toMatch(/\S/);
    for (const period of VAT_REPORTING_PERIODS) expect(webBoxes.VAT_REPORTING_PERIOD_LABELS[period]).toMatch(/\S/);
  });

  it("answers the helpers like @navet/shared", () => {
    for (const code of VAT_CODES) {
      expect(webCodes.vatCodeEntry(code)).toEqual(vatCodeEntry(code));
      expect(webCodes.isDomesticVatCode(code)).toBe(isDomesticVatCode(code));
      expect(webCodes.vatCodeTakesCatchAllRule(code)).toBe(vatCodeTakesCatchAllRule(code));
      for (const document of ["sales", "purchase", "import"] as const) {
        expect(webCodes.vatCodeAllowedOn(code, document)).toBe(vatCodeAllowedOn(code, document));
      }
      for (const slot of VAT_CODE_SLOTS) {
        expect(webCodes.vatCodeUsesSlot(code, slot)).toBe(vatCodeEntry(code).slots[slot] !== undefined);
      }
    }
    for (const rate of vatRates) expect(webCodes.domesticVatCodeForRate(rate)).toBe(domesticVatCodeForRate(rate));
    for (const country of ["SE", "de", "GR", "NO", "GB", "fr"]) {
      expect(webCodes.isEuCountry(country)).toBe(isEuCountry(country));
      expect(webCodes.vatNumberPrefix(country)).toBe(vatNumberPrefix(country));
    }
    for (const [base, rate] of [
      [1000.02, 25],
      [-1000.02, 25],
      [0.1, 6],
      [600.5, 12],
    ] as const) {
      expect(webCodes.computedVatAmount(base, rate)).toBe(computedVatAmount(base, rate));
    }
  });

  it("previews omvänd moms like @navet/shared", () => {
    const input = {
      headerCode: "IEUV25" as const,
      netAmount: 2000,
      rows: [
        { code: "IOBT" as const, lineAmount: 300 },
        { code: "IEUV12" as const, lineAmount: 600.5 },
        { code: null, lineAmount: 100 },
      ],
    };
    expect(webCodes.reverseVatPreview(input)).toEqual(reverseVatPreview(input));
    expect(webCodes.reverseVatPreview({ headerCode: "MP25", netAmount: 1000, rows: [] })).toEqual([]);
  });

  // The Konteringsregler page marks a rule's account with the wrong momsruta
  // itself (ruleBoxProblems); the Momsrapport's warning comes from the API
  // (findRuleBoxMismatches). Same rules — compared over every code (and
  // "Alla momskoder") against every box either account may carry.
  it("marks the konteringsregler's account boxes like the Momsrapport's warning", () => {
    const boxes = [null, "none", ...VAT_BOXES] as const;
    const codes = VAT_CODES.map((code, index) => ({
      id: `code-${index}`,
      code,
      active: true,
      revenueAccount: null,
      outputVatAccount: null,
      inputVatAccount: null,
      costAccount: null,
      baseAccount: null,
      baseCounterAccount: null,
    }));
    for (const code of [null, ...VAT_CODES]) {
      for (const revenueBox of boxes) {
        for (const costBox of boxes) {
          for (const accounts of [{ revenue: true, cost: true }, { revenue: true, cost: false }, { revenue: false, cost: true }]) {
            const rule = {
              vatCode: code,
              revenueAccountNumber: accounts.revenue ? "3001" : null,
              revenueAccountVatBox: accounts.revenue ? revenueBox : null,
              costAccountNumber: accounts.cost ? "4010" : null,
              costAccountVatBox: accounts.cost ? costBox : null,
            };
            const api = findRuleBoxMismatches(
              [
                {
                  id: "rule",
                  groupCode: "100",
                  groupName: "Grupp",
                  vatCodeId: code === null ? null : codes.find((row) => row.code === code)!.id,
                  revenueAccountNumber: rule.revenueAccountNumber,
                  revenueAccountVatBox: rule.revenueAccountVatBox,
                  costAccountNumber: rule.costAccountNumber,
                  costAccountVatBox: rule.costAccountVatBox,
                },
              ],
              codes
            ).map((mismatch) => ({
              slot: mismatch.slot,
              problem: mismatch.problem,
              accountNumber: mismatch.accountNumber,
              actualBox: mismatch.actualBox,
              expectedBoxes: mismatch.expectedBoxes,
            }));
            expect({ code, revenueBox, costBox, problems: webCodes.ruleBoxProblems(rule) }).toEqual({ code, revenueBox, costBox, problems: api });
          }
        }
      }
    }
  });
});
