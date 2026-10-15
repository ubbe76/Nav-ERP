import { describe, expect, it } from "vitest";
import { IMPORT_ENTITY_ORDER, importEntitySchema } from "@navet/shared";
import { detectImportEntity } from "../src/modules/import/service/detect.js";

// The header rows of Monitor G5's article exports, copied as literals so this
// runs without the files.
const HEADERS = {
  artikellista: ["Artikelnummer", "Artikelbenämning", "Artikeltyp", "Standardpris", "Artikelkategori", "Artikelkod", "Varugrupp", "Enhet", "Totalt saldo", "Lagerplatsurval"],
  planering: ["Artikelnummer", "Artikelbenämning", "Artikeltyp", "Planeringsmetod", "Styrning", "Partiformningsregel", "Periodlängd", "Orderkvantitet", "Min. kvantitet", "Avrundningsantal", "Beställningspunkt", "Säkerhetslager", "Säkerhetstid", "Max. kvant. på T-order", "Max. kvant på I-order", "Ledtid", "Årsvolym", "ABC-kod", "Anskaffa från lagerställe", "Nettovikt"],
  extraBenamning: ["Artikelnummer", "Extra benämning", "Färg"],
  enheter: ["Artikelnummer", "Artikelbenämning", "Enh.", "Förvald", "Omr.faktor", "Materialuttag", "Inköpsorder", "Rapportera inleverans", "Kundorder", "Packa för leverans", "Rapportera utleverans", "Lagerrapportering", "Statistik"],
  materiallista: ["Huvudartikel", "Artikelbenämning", "Status", "Beredare", "Spärrad (material)", "Pos.", "Artikelnummer", "Artikelbenämning (2)", "A", "Ersättningsartikel", "Artikeltyp", "Till operation", "Pgrp", "Inst.kvant.", "Extra %", "Kvantitet", "Enhet", "Standardpris", "End. kal.", "Instruktion", "Filer (material)", "Villkor", "Från och med", "Till och med"],
  operationslista: ["Artikelnummer", "Artikelbenämning", "Produktionsgrupp", "Op.", "Operationens benämning", "Antal maskiner/personer per order", "Ställantal", "Extra %", "Ställtid", "Stycktid", "Cykeltid", "Fördelningstid", "Enhet", "ÖL", "Kötid", "Bem.fakt. ställ", "Bem.fakt. styck", "Fast ledtid", "Und. K-faktor ställ", "Und. K-faktor styck", "Endast kalkyl", "Instruktion", "Filer", "Villkor", "Från och med", "Till och med"],
  prislistaInkop: ["Artikelnummer", "Artikelbenämning", "Artikeltyp", "Artikelkod", "Förvald", "Leverantör", "Namn", "Lev. art.nr", "Pris", "Ställpris", "Rabatt", "Prisdatum"],
  prislistaInkopStafflat: ["Artikelnummer", "Artikelbenämning", "Artikeltyp", "Artikelkod", "Leverantör", "Namn", "Lev. art.nr", "Pris", "Ställpris", "Rabatt", "Prisdatum", "Gränsvärde antal", "Pris (2)"],
  prislistaForsaljning: ["Artikelnummer", "Artikelbenämning", "Artikeltyp", "Artikelkod", "Kund", "Namn", "Kundens art.nummer", "Pris", "Ställpris", "Rabatt", "Prisdatum"],
  nivalista: ["Artikeltyp/Operation", "Artikel/Operation", "Benämning", "Kvantitet", "Artikelstatus", "Mer info"],
};

describe("detectImportEntity", () => {
  it("recognises every real Monitor G5 article export", () => {
    expect(detectImportEntity(HEADERS.artikellista)).toBe("articles");
    expect(detectImportEntity(HEADERS.planering)).toBe("articles");
    expect(detectImportEntity(HEADERS.extraBenamning)).toBe("articles");
    expect(detectImportEntity(HEADERS.enheter)).toBe("articleUnits");
    expect(detectImportEntity(HEADERS.materiallista)).toBe("bom");
    expect(detectImportEntity(HEADERS.operationslista)).toBe("routing");
    expect(detectImportEntity(HEADERS.prislistaInkop)).toBe("supplierPrices");
    expect(detectImportEntity(HEADERS.prislistaInkopStafflat)).toBe("supplierPrices");
    expect(detectImportEntity(HEADERS.prislistaForsaljning)).toBe("customerPrices");
  });

  it("leaves the Nivålista (and anything without an article column) unrecognised", () => {
    expect(detectImportEntity(HEADERS.nivalista)).toBeNull();
    expect(detectImportEntity(["Kund", "Namn"])).toBeNull();
    expect(detectImportEntity([])).toBeNull();
  });

  it("is independent of column order and of parse()'s duplicate suffixes", () => {
    expect(detectImportEntity([...HEADERS.prislistaInkopStafflat].reverse())).toBe("supplierPrices");
    expect(detectImportEntity(["Pris (3)", "Leverantör", "Artikelnummer"])).toBe("supplierPrices");
  });

  it("does not mistake an article list with an Op. column for a routing without a time column", () => {
    expect(detectImportEntity(["Artikelnummer", "Op.", "Artikeltyp"])).toBe("articles");
    expect(detectImportEntity(["Artikelnummer", "Op.", "Stycktid"])).toBe("routing");
  });

  it("only orders entities the schema knows, articles first and prices last", () => {
    for (const entity of IMPORT_ENTITY_ORDER) expect(importEntitySchema.options).toContain(entity);
    expect(IMPORT_ENTITY_ORDER[0]).toBe("articles");
    expect(IMPORT_ENTITY_ORDER.indexOf("routing")).toBeLessThan(IMPORT_ENTITY_ORDER.indexOf("bom"));
    expect(IMPORT_ENTITY_ORDER.indexOf("articles")).toBeLessThan(IMPORT_ENTITY_ORDER.indexOf("supplierPrices"));
  });
});
