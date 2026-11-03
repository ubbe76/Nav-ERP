import { describe, expect, it } from "vitest";
import { CUSTOMER_IMPORT_ENTITY_ORDER, IMPORT_ENTITY_ORDER, SUPPLIER_IMPORT_ENTITY_ORDER, importEntitySchema } from "@navet/shared";
import { detectImportEntity, importFileRank } from "../src/modules/import/service/detect.js";
import { IMPORT_FIELD_HELP } from "../src/modules/import/service/field-help.js";

// The header rows of Monitor G5's article exports, copied as literals so this
// runs without the files.
const HEADERS = {
  artikellista: ["Artikelnummer", "Artikelbenämning", "Artikeltyp", "Standardpris", "Artikelkategori", "Artikelkod", "Varugrupp", "Enhet", "Totalt saldo", "Lagerplatsurval"],
  planering: ["Artikelnummer", "Artikelbenämning", "Artikeltyp", "Planeringsmetod", "Styrning", "Partiformningsregel", "Periodlängd", "Orderkvantitet", "Min. kvantitet", "Avrundningsantal", "Beställningspunkt", "Säkerhetslager", "Säkerhetstid", "Max. kvant. på T-order", "Max. kvant på I-order", "Ledtid", "Årsvolym", "ABC-kod", "Anskaffa från lagerställe", "Nettovikt"],
  extraBenamning: ["Artikelnummer", "Extra benämning", "Färg"],
  enheter: ["Artikelnummer", "Artikelbenämning", "Enh.", "Förvald", "Omr.faktor", "Materialuttag", "Inköpsorder", "Rapportera inleverans", "Kundorder", "Packa för leverans", "Rapportera utleverans", "Lagerrapportering", "Statistik"],
  materiallista: ["Huvudartikel", "Artikelbenämning", "Status", "Beredare", "Spärrad (material)", "Pos.", "Artikelnummer", "Artikelbenämning (2)", "A", "Ersättningsartikel", "Artikeltyp", "Till operation", "Pgrp", "Inst.kvant.", "Extra %", "Kvantitet", "Enhet", "Standardpris", "End. kal.", "Instruktion", "Filer (material)", "Villkor", "Från och med", "Till och med"],
  operationslista: ["Artikelnummer", "Artikelbenämning", "Produktionsgrupp", "Op.", "Operationens benämning", "Antal maskiner/personer per order", "Ställantal", "Extra %", "Ställtid", "Stycktid", "Cykeltid", "Fördelningstid", "Enhet", "ÖL", "Kötid", "Bem.fakt. ställ", "Bem.fakt. styck", "Fast ledtid", "Und. K-faktor ställ", "Und. K-faktor styck", "Endast kalkyl", "Instruktion", "Filer", "Villkor", "Från och med", "Till och med"],
  operationslistaLego: ["Produktionsgrupp", "Namn", "Leverantör", "Namn", "Artikelnummer", "Artikelbenämning", "Legoartikelnummer", "Op.", "Operationens benämning", "Ställkostnad", "Styckkostnad", "Kötid", "Transportkostnad", "Lev.adress – Rad 1", "Lev.adress – Rad 2", "Lev.adress – Rad 3", "Lev.adress – Rad 4", "Lev.adress – Rad 5", "Lev.adress – Land", "Färg"],
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
    // No time columns — it used to fall through to the article list, whose
    // "Namn" alias took the resource name as every article's Benämning.
    expect(detectImportEntity(HEADERS.operationslistaLego)).toBe("routing");
    expect(detectImportEntity(["Artikelnummer", "Lager", "Lagerplats", "Antal", "À-pris"])).toBe("stockBalances");
    expect(detectImportEntity(["Artikelnummer", "Benämning", "Lagerställe", "Saldo"])).toBe("stockBalances");
    // A Lagerplats column without a quantity is still the article list.
    expect(detectImportEntity(["Artikelnummer", "Benämning", "Lagerplats"])).toBe("articles");
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

// The header rows of Monitor G5's customer exports (Kundlista, 2026-10).
const CUSTOMER_HEADERS = {
  lista: ["Kund", "Namn", "Betalningsvillkor", "Leveransvillkor", "Leveranssätt", "Giltighetstid", "Faktureringsplan", "Prislista", "Rabatt", "Rabattkategori", "Legeringstillägg"],
  ovrigt: ["Kund", "Namn", "Prioritet", "Kundgrupp", "Momsreg.nr", "Moderbolag (kund)", "Välj leveransadress", "Personnummer", "Organisationsnr", "Kundkategori", "Vårt leverantörsnummer", "Kundnummer faktura", "Kreditlimit", "Försäkringsavgift", "Bankgiro", "PlusGiro", "Faktureringsavgift", "Betalningspåminnelse", "Samlingsfaktura", "Påminnelseavgift", "Öresavrundning", "Faktura i vänteläge", "Factoring", "Distributionsmetod", "Terminskurs", "Strökund", "Privatperson", "Webbsida", "Order som XML", "Faktura som XML", "Ärende som XML", "EORI-nr", "Flera order i e-postmeddelande", "Flera fakturor i e-post"],
  postadress: ["Kund", "Namn", "Postadress – Adressformat", "Postadress – Namn", "Postadress – Adressrad 1", "Postadress – Adressrad 2", "Postadress – Adressrad 3", "Postadress – Adressrad 4", "Postadress – Postnummer", "Postadress – Stad", "Postadress – Region", "Postadress – Land"],
  fakturaadress: ["Kund", "Namn", "Avviker från postadress", "Fakturaadress – Namn", "Fakturaadress – Adressrad 1", "Fakturaadress – Adressrad 2", "Fakturaadress – Adressrad 3", "Fakturaadress – Adressrad 4", "Fakturaadress – Postnummer", "Fakturaadress – Stad", "Fakturaadress – Land"],
  besoksadress: ["Kund", "Namn", "Avviker från leveransadress", "Besöksadress – Namn", "Besöksadress adressrad 1", "Besöksadress adressrad 2", "Besöksadress adressrad 3", "Besöksadress adressrad 4", "Besöksadress – Postnummer", "Besöksadress – Stad", "Besöksadress – Land"],
  leveransadress: ["Kund", "Namn", "Leveransadress – Namn", "Leveransadress – Adressrad 1", "Leveransadress – Adressrad 2", "Leveransadress – Adressrad 3", "Leveransadress – Adressrad 4", "Leveransadress – Postnummer", "Leveransadress – Stad", "Leveransadress – Land"],
  alternativa: ["Kund", "Namn", "Förvald", "Aktiv", "Namn (2)", "Adressrad 1", "Adressrad 2", "Adressrad 3", "Adressrad 4", "Postnummer", "Stad", "Leveransvillkor", "Leveranssätt", "Transporttid", "Bestämmelseort", "Ort för leveransvillkor", "Kundgrupp", "Undantag momsreg.nr", "Momsreg.nr"],
  referenser: ["Kund", "Förvald", "Aktiv", "Referens – Namn", "Telefon", "Mobiltelefon", "E-post", "Faxnummer", "Anmärkning", "Kommentar", "F", "Referenskategori"],
};

describe("detectImportEntity — customer exports", () => {
  it("recognises every Monitor G5 customer export that has something to import", () => {
    expect(detectImportEntity(CUSTOMER_HEADERS.lista)).toBe("customers");
    expect(detectImportEntity(CUSTOMER_HEADERS.ovrigt)).toBe("customers");
    expect(detectImportEntity(CUSTOMER_HEADERS.postadress)).toBe("customers");
    expect(detectImportEntity(CUSTOMER_HEADERS.fakturaadress)).toBe("customers");
    expect(detectImportEntity(CUSTOMER_HEADERS.leveransadress)).toBe("customerDeliveryAddresses");
    expect(detectImportEntity(CUSTOMER_HEADERS.alternativa)).toBe("customerDeliveryAddresses");
    expect(detectImportEntity(CUSTOMER_HEADERS.referenser)).toBe("customerContacts");
  });

  it("leaves Besöksadress unrecognised — nothing but the customer number maps", () => {
    expect(detectImportEntity(CUSTOMER_HEADERS.besoksadress)).toBeNull();
  });

  it("recognises the three customer templates by their own headings", () => {
    const headings = (entity: "customers" | "customerContacts" | "customerDeliveryAddresses") =>
      IMPORT_FIELD_HELP[entity].map((f) => f.header);
    expect(detectImportEntity(headings("customers"))).toBe("customers");
    expect(detectImportEntity(headings("customerContacts"))).toBe("customerContacts");
    expect(detectImportEntity(headings("customerDeliveryAddresses"))).toBe("customerDeliveryAddresses");
  });

  it("keeps the price list (customer + article) a customer price file", () => {
    expect(detectImportEntity(HEADERS.prislistaForsaljning)).toBe("customerPrices");
    expect(detectImportEntity(["Kund", "Artikelnummer", "Namn"])).toBeNull();
  });

  it("ranks the Lista-like files before the address files, and named article files before the rest", () => {
    expect(importFileRank("customers", CUSTOMER_HEADERS.lista)).toBe(0);
    expect(importFileRank("customers", CUSTOMER_HEADERS.ovrigt)).toBe(0);
    expect(importFileRank("customers", CUSTOMER_HEADERS.postadress)).toBe(1);
    expect(importFileRank("customers", CUSTOMER_HEADERS.fakturaadress)).toBe(1);
    expect(importFileRank("customerContacts", CUSTOMER_HEADERS.referenser)).toBe(0);
    expect(importFileRank("articles", HEADERS.artikellista)).toBe(0);
    expect(importFileRank("articles", HEADERS.planering)).toBe(0);
    // Extra benämning has no Benämning column: it cannot create an article,
    // so it runs after the files that can.
    expect(importFileRank("articles", HEADERS.extraBenamning)).toBe(1);
  });

  it("orders the customers before what hangs on them", () => {
    for (const entity of CUSTOMER_IMPORT_ENTITY_ORDER) expect(importEntitySchema.options).toContain(entity);
    expect(CUSTOMER_IMPORT_ENTITY_ORDER[0]).toBe("customers");
  });
});

// The header rows of Monitor G5's supplier exports (Leverantörslista, 2026-10)
// and the lego resource list, which also carries "Leverantör".
const SUPPLIER_HEADERS = {
  ovrigt: ["Leverantör", "Namn", "Leverantörsroll", "Prioritet", "Leverantörsgrupp", "Minsta ordervärde", "Momsreg.nr", "Organisationsnummer", "E-fakturaadress (EIA)", "Leverantörskategori", "Vårt kundnr", "Lev.nr på faktura", "Moderbolag (lev.)", "Attestansvarig", "Kalender", "Skapa inte fakturaunderlag", "Ströleverantör", "Webbsida", "Order som XML", "Leveransplan som XML", "Leveransplan (fullständig) som XML", "Ärende som XML", "XML med leveransavisering", "EORI-nr", "E-faktura", "Transportavstånd", "2D-kodsmall", "Flera order i e-postmeddelande"],
  villkor: ["Leverantör", "Namn", "Betalningsvillkor", "Leveransvillkor", "Leveranssätt", "Svarstid", "Emballagevillkor", "Betalningsplan", "Rabatt", "Rabattkategori"],
  postadress: ["Leverantör", "Namn", "Postadress – Adressformat", "Postadress – Namn", "Postadress – Adressrad 1", "Postadress – Adressrad 2", "Postadress – Adressrad 3", "Postadress – Adressrad 4", "Postadress – Postnummer", "Postadress – Stad", "Postadress – Region", "Postadress – Land"],
  besoksadress: ["Leverantör", "Namn", "Avviker från leveransadress", "Besöksadress – Namn", "Besöksadress adressrad 1", "Besöksadress adressrad 2", "Besöksadress adressrad 3", "Besöksadress adressrad 4", "Besöksadress – Land"],
  leveransadress: ["Leverantör", "Namn", "Leveransadress – Namn", "Leveransadress – Adressrad 1", "Leveransadress – Adressrad 2", "Leveransadress – Adressrad 3", "Leveransadress – Adressrad 4", "Leveransadress – Land"],
  referenser: ["Leverantör", "Namn", "Leverantörsroll", "Förvald", "Aktiv", "Referens – Namn", "Telefon", "Mobiltelefon", "E-post", "Faxnummer", "Anmärkning", "Kommentar", "F", "Referenskategori"],
  // The 2026-09 export's single Lista file.
  lista: ["Leverantör", "Namn", "Leverantörsroll", "Leverantörsgrupp", "Minsta ordervärde", "Momsreg.nr", "Organisationsnummer", "Vårt kundnr", "Webbsida"],
  legoResurser: ["Prod.grupp", "Namn", "Leverantör", "Namn (2)", "Ledtid", "Kötid"],
};

describe("detectImportEntity — supplier exports", () => {
  it("recognises every Monitor G5 supplier export that has something to import", () => {
    expect(detectImportEntity(SUPPLIER_HEADERS.ovrigt)).toBe("suppliers");
    expect(detectImportEntity(SUPPLIER_HEADERS.villkor)).toBe("suppliers");
    expect(detectImportEntity(SUPPLIER_HEADERS.postadress)).toBe("suppliers");
    expect(detectImportEntity(SUPPLIER_HEADERS.lista)).toBe("suppliers");
    expect(detectImportEntity(SUPPLIER_HEADERS.leveransadress)).toBe("supplierDeliveryAddresses");
    expect(detectImportEntity(SUPPLIER_HEADERS.referenser)).toBe("supplierContacts");
  });

  it("leaves Besöksadress and the lego resource list unrecognised", () => {
    expect(detectImportEntity(SUPPLIER_HEADERS.besoksadress)).toBeNull();
    expect(detectImportEntity(SUPPLIER_HEADERS.legoResurser)).toBeNull();
    expect(detectImportEntity(IMPORT_FIELD_HELP.legoWorkCenters.map((f) => f.header))).toBeNull();
    expect(detectImportEntity(["Leverantör", "Namn"])).toBeNull();
  });

  it("recognises the three supplier templates by their own headings", () => {
    const headings = (entity: "suppliers" | "supplierContacts" | "supplierDeliveryAddresses") =>
      IMPORT_FIELD_HELP[entity].map((f) => f.header);
    expect(detectImportEntity(headings("suppliers"))).toBe("suppliers");
    expect(detectImportEntity(headings("supplierContacts"))).toBe("supplierContacts");
    expect(detectImportEntity(headings("supplierDeliveryAddresses"))).toBe("supplierDeliveryAddresses");
  });

  it("keeps the purchase price lists (supplier + article) supplier price files", () => {
    expect(detectImportEntity(HEADERS.prislistaInkop)).toBe("supplierPrices");
    expect(detectImportEntity(["Leverantör", "Artikelnummer", "Namn", "Telefon"])).toBeNull();
  });

  it("ranks the Lista-like files (Övrigt, Villkor, Lista) before Postadress", () => {
    expect(importFileRank("suppliers", SUPPLIER_HEADERS.ovrigt)).toBe(0);
    expect(importFileRank("suppliers", SUPPLIER_HEADERS.villkor)).toBe(0);
    expect(importFileRank("suppliers", SUPPLIER_HEADERS.lista)).toBe(0);
    expect(importFileRank("suppliers", SUPPLIER_HEADERS.postadress)).toBe(1);
    expect(importFileRank("supplierContacts", SUPPLIER_HEADERS.referenser)).toBe(0);
  });

  it("orders the suppliers before what hangs on them", () => {
    for (const entity of SUPPLIER_IMPORT_ENTITY_ORDER) expect(importEntitySchema.options).toContain(entity);
    expect(SUPPLIER_IMPORT_ENTITY_ORDER[0]).toBe("suppliers");
  });
});
