import { describe, expect, it } from "vitest";
import {
  COMBITERMS,
  STANDARD_UNITS,
} from "../src/modules/register/service/register.service.js";
import {
  createArticleSchema,
  createCustomerSchema,
  createSupplierSchema,
  DOCUMENT_LANGUAGES,
  documentLanguageOf,
  documentLanguageSchema,
  localized,
  parseDocumentLanguageCell,
  termRegisterEntrySchema,
  unitRegisterEntrySchema,
  updateArticleSchema,
  updateCustomerSchema,
  updateSupplierSchema,
  updateVatCodeSchema,
  VAT_CODE_CATALOG,
} from "@navet/shared";
import * as webCodes from "../../web/lib/vatCodes";

// Dokument på engelska (#7) — the pure parts: the fallback rule, the Språk
// cell parser, the API schemas and the seed catalogs' English texts.

describe("localized — the one fallback rule", () => {
  it("returns the English text only for en with a filled-in English text", () => {
    expect(localized("Diskbänk", "Sink unit", "en")).toBe("Sink unit");
    expect(localized("Diskbänk", "Sink unit", "sv")).toBe("Diskbänk");
  });

  it("falls back to the Swedish text when the English one is empty, blank or missing", () => {
    expect(localized("Diskbänk", null, "en")).toBe("Diskbänk");
    expect(localized("Diskbänk", undefined, "en")).toBe("Diskbänk");
    expect(localized("Diskbänk", "", "en")).toBe("Diskbänk");
    expect(localized("Diskbänk", "   ", "en")).toBe("Diskbänk");
  });

  it("never lets the English text leak into a Swedish document", () => {
    expect(localized("", "Sink unit", "sv")).toBe("");
  });
});

describe("documentLanguageOf and parseDocumentLanguageCell", () => {
  it("types a stored column value and treats anything else as Swedish", () => {
    expect(documentLanguageOf("en")).toBe("en");
    expect(documentLanguageOf("sv")).toBe("sv");
    expect(documentLanguageOf("de")).toBe("sv");
    expect(documentLanguageOf(null)).toBe("sv");
    expect(documentLanguageOf(undefined)).toBe("sv");
  });

  it("reads the imports' Språk cell: code or name, either language, any case", () => {
    for (const raw of ["sv", "SV", "Svenska", "svenska", " SVENSKA ", "Swedish"]) expect(parseDocumentLanguageCell(raw), raw).toBe("sv");
    for (const raw of ["en", "EN", "Engelska", "engelska", "English", " english"]) expect(parseDocumentLanguageCell(raw), raw).toBe("en");
    for (const raw of ["", "de", "Tyska", "Engelsk", "en-GB"]) expect(parseDocumentLanguageCell(raw), raw).toBeNull();
  });

  it("the zod enum is exactly the language list", () => {
    expect([...DOCUMENT_LANGUAGES]).toEqual(["sv", "en"]);
    expect(documentLanguageSchema.options).toEqual(["sv", "en"]);
    expect(documentLanguageSchema.safeParse("de").success).toBe(false);
  });
});

describe("API schemas — language and English texts", () => {
  it("customers: language defaults to sv on create, is optional and never null on update", () => {
    expect(createCustomerSchema.parse({ name: "Kund AB" }).language).toBe("sv");
    expect(createCustomerSchema.parse({ name: "Kund AB", language: "en" }).language).toBe("en");
    expect(createCustomerSchema.safeParse({ name: "Kund AB", language: "de" }).success).toBe(false);
    expect(createCustomerSchema.safeParse({ name: "Kund AB", language: "EN" }).success).toBe(false);
    expect(updateCustomerSchema.parse({ language: "en" }).language).toBe("en");
    expect(updateCustomerSchema.parse({ name: "X" }).language).toBeUndefined();
    expect(updateCustomerSchema.safeParse({ language: null }).success).toBe(false);
  });

  it("suppliers: the same rule", () => {
    expect(createSupplierSchema.parse({ name: "Lev AB" }).language).toBe("sv");
    expect(createSupplierSchema.parse({ name: "Lev AB", language: "en" }).language).toBe("en");
    expect(createSupplierSchema.safeParse({ name: "Lev AB", language: "no" }).success).toBe(false);
    expect(updateSupplierSchema.parse({ language: "sv" }).language).toBe("sv");
    expect(updateSupplierSchema.safeParse({ language: null }).success).toBe(false);
  });

  it("articles: nameEn/extraDescriptionEn are optional, blank ⇒ null, length-capped like the Swedish texts", () => {
    const base = { name: "Diskbänk", type: "manufactured", unitId: "00000000-0000-0000-0000-000000000000" };
    const created = createArticleSchema.parse({ ...base, nameEn: "  Sink unit ", extraDescriptionEn: "" });
    expect(created.nameEn).toBe("Sink unit");
    expect(created.extraDescriptionEn).toBeNull();
    expect(createArticleSchema.parse(base).nameEn).toBeUndefined();
    expect(createArticleSchema.safeParse({ ...base, nameEn: "x".repeat(256) }).success).toBe(false);
    expect(createArticleSchema.safeParse({ ...base, extraDescriptionEn: "x".repeat(2001) }).success).toBe(false);
    expect(updateArticleSchema.parse({ nameEn: "" }).nameEn).toBeNull();
    expect(updateArticleSchema.parse({ extraDescriptionEn: null }).extraDescriptionEn).toBeNull();
    expect(updateArticleSchema.parse({ nameEn: "Sink" })).toEqual({ nameEn: "Sink" });
  });

  it("terms take nameEn and units codeEn, blank ⇒ null; the plain registers keep their shape", () => {
    expect(termRegisterEntrySchema.parse({ code: "DAP", name: "Levererat angiven plats", nameEn: " Delivered at Place " })).toMatchObject({
      nameEn: "Delivered at Place",
    });
    expect(termRegisterEntrySchema.parse({ code: "30", name: "30 dagar netto", nameEn: "" }).nameEn).toBeNull();
    expect(termRegisterEntrySchema.parse({ code: "30", name: "30 dagar netto" }).nameEn).toBeUndefined();
    expect(termRegisterEntrySchema.safeParse({ code: "30", name: "30 dagar netto", nameEn: "x".repeat(101) }).success).toBe(false);
    expect(unitRegisterEntrySchema.parse({ code: "st", name: "Styck", codeEn: "pcs" }).codeEn).toBe("pcs");
    expect(unitRegisterEntrySchema.parse({ code: "st", name: "Styck", codeEn: "  " }).codeEn).toBeNull();
    expect(unitRegisterEntrySchema.safeParse({ code: "st", name: "Styck", codeEn: "x".repeat(21) }).success).toBe(false);
  });

  it("vat codes: PATCH takes nameEn/invoiceTextEn, \"\" and null clear", () => {
    expect(updateVatCodeSchema.parse({ nameEn: "Goods to another EU country" }).nameEn).toBe("Goods to another EU country");
    expect(updateVatCodeSchema.parse({ nameEn: "" }).nameEn).toBeNull();
    expect(updateVatCodeSchema.parse({ invoiceTextEn: null }).invoiceTextEn).toBeNull();
    expect(updateVatCodeSchema.parse({ invoiceTextEn: " Reverse charge " }).invoiceTextEn).toBe("Reverse charge");
    expect(updateVatCodeSchema.safeParse({ nameEn: "x".repeat(101) }).success).toBe(false);
    expect(updateVatCodeSchema.safeParse({ invoiceTextEn: "x".repeat(256) }).success).toBe(false);
  });
});

describe("seed catalogs — English texts", () => {
  it("every VAT code has an English name; the invoice text is English exactly where the Swedish one exists", () => {
    for (const entry of VAT_CODE_CATALOG) {
      expect(entry.labelEn.trim(), entry.code).not.toBe("");
      expect(entry.labelEn, entry.code).not.toBe(entry.label);
      expect(entry.invoiceTextEn === null, entry.code).toBe(entry.invoiceText === null);
    }
    expect(VAT_CODE_CATALOG.find((e) => e.code === "EUV")?.invoiceTextEn).toBe("Intra-Community supply (Article 138 of the VAT Directive)");
    expect(VAT_CODE_CATALOG.find((e) => e.code === "UTM")?.invoiceTextEn).toBeNull();
  });

  it("the web mirror carries the same English texts", () => {
    expect(webCodes.VAT_CODE_CATALOG.map((e) => [e.code, e.labelEn, e.invoiceTextEn])).toEqual(
      VAT_CODE_CATALOG.map((e) => [e.code, e.labelEn, e.invoiceTextEn])
    );
  });

  it("every Combiterm has its Incoterms 2020 name; the units st/tim/förp have an English code", () => {
    expect(COMBITERMS).toHaveLength(11);
    for (const term of COMBITERMS) expect(term.nameEn.trim(), term.code).not.toBe("");
    expect(COMBITERMS.find((t) => t.code === "EXW")?.nameEn).toBe("Ex Works");
    expect(COMBITERMS.find((t) => t.code === "DDP")?.nameEn).toBe("Delivered Duty Paid");
    expect(STANDARD_UNITS.filter((u) => u.codeEn).map((u) => [u.code, u.codeEn])).toEqual([
      ["st", "pcs"],
      ["tim", "h"],
      ["förp", "pkg"],
    ]);
  });
});
