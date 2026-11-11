// Recognises WHICH Monitor G5 article, customer or supplier export a file is from its header row,
// for the multi-file import ("Alla filer"): the user drops every export at
// once and the wizard sorts them into entities and dependency order. Pure —
// headers in, entity out — so the whole signature table is unit-tested
// against the real exports' header rows.
//
// The rules are ORDERED and the first match wins, because several files
// share "Artikelnummer": the Operationslista also carries "Enhet" (an
// article-file heading) and the price lists carry "Artikeltyp", so the more
// specific signatures must be tried before the plain article list.
import type { ImportEntity } from "@navet/shared";
import { normalizeHeader } from "./import.service.js";
import { isCustomerListaFile, suggestCustomerMapping } from "./customers.js";
import { isSupplierListaFile, suggestSupplierMapping } from "./suppliers.js";
import { LEGO_WORK_CENTER_HEADER_ALIASES } from "./lego-work-centers.js";
import { suggestArticleMapping } from "./articles.js";

interface Signature {
  entity: ImportEntity;
  /** Every one of these normalized headings must be present. */
  all: string[];
  /** At least one of these must be present (when the list is non-empty). */
  any?: string[];
  /** Also requires one of ROUTING_TIME_HEADINGS (the internal Operationslista). */
  needsTimeColumn?: true;
  /** Also requires one of STOCK_QUANTITY_HEADINGS (Lagersaldon). */
  needsQuantity?: true;
}

export const IMPORT_ENTITY_SIGNATURES: Signature[] = [
  // Materiallista: parent + component + quantity.
  { entity: "bom", all: ["huvudartikel", "artikelnummer", "kvantitet"] },
  // The Excel templates (field-help.ts headings) for the three files whose
  // template would otherwise fall through to the article list — they carry
  // "Artikelnummer" plus "Enhet" or nothing the article signature knows.
  // The routing and article templates already match their export rules.
  { entity: "bom", all: ["artikelnummer", "komponentnummer", "antal"] },
  { entity: "articleUnits", all: ["artikelnummer", "enhet", "omrakningsfaktor"] },
  { entity: "supplierPrices", all: ["artikelnummer", "leverantorsnummer", "pris"] },
  { entity: "customerPrices", all: ["artikelnummer", "kundnummer", "pris"] },
  // Operationslista, Lego: no times, but the lego prices. Without this rule
  // the file fell through to the article list, whose alias "namn" took the
  // resource name as every article's Benämning.
  { entity: "routing", all: ["artikelnummer", "op"], any: ["stallkostnad", "styckkostnad", "legoartikelnummer"] },
  // Operationslista: article + resource/sequence + a time column.
  { entity: "routing", all: ["artikelnummer"], any: ["produktionsgrupp", "op", "sekvensnr"], needsTimeColumn: true },
  // Artikellista, Enheter: the conversion factor is unique to it.
  { entity: "articleUnits", all: ["artikelnummer", "omrfaktor"] },
  // Prislista Inköp (plain and stafflat): supplier + price.
  { entity: "supplierPrices", all: ["artikelnummer", "leverantor", "pris"] },
  // Prislista Försäljning: customer + price.
  { entity: "customerPrices", all: ["artikelnummer", "kund", "pris"] },
  // Lagersaldon: the article on a place with a quantity — the template's
  // headings and a stock list's (Lagerställe, Saldo). Ahead of the article
  // list, which a "Lagerplats" column would otherwise fall into.
  { entity: "stockBalances", all: ["artikelnummer"], any: ["lagerplats", "lagerstalle"], needsQuantity: true },
  // Artikellista and its sub-exports (Planering, Extra benämning …): the
  // article number plus at least one article field.
  {
    entity: "articles",
    all: ["artikelnummer"],
    any: [
      "artikeltyp",
      "artikelbenamning",
      "benamning",
      "enhet",
      "standardpris",
      "farg",
      "extrabenamning",
      "ytbehandling",
      "vikt",
      "nettovikt",
      "bestallningspunkt",
      "orderkvantitet",
      "avrundning",
      "avrundningsantal",
      "partiformningsregel",
      "artikelgrupp",
      "varugrupp",
      "varugruppkod",
      "aktiv",
    ],
  },
];

// The routing signature's "any" list is checked together with a time column
// so a bare article list with an "Op." column somewhere is not mistaken for
// a routing — Monitor's Operationslista always has Ställtid/Stycktid.
const ROUTING_TIME_HEADINGS = ["stalltid", "stycktid", "tidenhet"];
const STOCK_QUANTITY_HEADINGS = ["antal", "saldo", "lagersaldo"];

// Monitor G5's customer exports (Kundlista: Lista, Övrigt, Postadress,
// Fakturaadress, Besöksadress, Leveransadress, Alternativa leveransadresser,
// Referenser) and the three customer templates. They all key on the customer
// number and never carry an article number — the price lists, which have
// both, are matched by the article signatures above.
const CUSTOMER_KEY_HEADINGS = ["kund", "kundnummer", "kundnr"];
// Referenser ("Referens – Namn") and the contact template (Mobiltelefon,
// Faxnummer, Anmärkning — the customer template has none of them). The
// template's Förvald counts too when there is no address line (the
// Alternativa leveransadresser file has Förvald + Adressrad 1): the manual
// says to drop unused columns, and a template without Mobiltelefon and
// Faxnummer was read as a customer file — its Kontaktperson/Telefon/E-post
// written over the customer's own.
const CUSTOMER_CONTACT_HEADINGS = ["referensnamn", "mobiltelefon", "faxnummer", "anmarkning"];
const isContactFile = (present: Set<string>, headings: string[]) =>
  headings.some((heading) => present.has(heading)) || (present.has("forvald") && !present.has("adressrad1"));
// Leveransadress ("Leveransadress – Namn") and the template (Adressnamn).
// Alternativa leveransadresser has neither; it is the only customer file
// with both Förvald and a bare Adressrad 1.
const CUSTOMER_DELIVERY_ADDRESS_HEADINGS = ["leveransadressnamn", "adressnamn"];

function detectCustomerFile(present: Set<string>, headers: string[]): ImportEntity | null {
  if (!CUSTOMER_KEY_HEADINGS.some((heading) => present.has(heading)) || present.has("artikelnummer")) return null;
  if (isContactFile(present, CUSTOMER_CONTACT_HEADINGS)) return "customerContacts";
  if (
    CUSTOMER_DELIVERY_ADDRESS_HEADINGS.some((heading) => present.has(heading)) ||
    (present.has("forvald") && present.has("adressrad1"))
  ) {
    return "customerDeliveryAddresses";
  }
  // A customer file is only worth importing when something besides the
  // number maps — Besöksadress (Nav has no visiting address) maps nothing
  // and stays unrecognised instead of updating every customer with nothing.
  const mapped = Object.values(suggestCustomerMapping(headers));
  return mapped.some((field) => field !== null && field !== "customerNumber") ? "customers" : null;
}

// Monitor G5's supplier exports (Leverantörslista: Övrigt, Villkor,
// Postadress, Besöksadress, Leveransadress, Referenser — the 2026-09 export
// had a plain Lista instead of Övrigt/Villkor) and the three supplier
// templates, keyed on the supplier number. The purchase price lists carry
// an article number too and are matched by the article signatures above;
// the lego resource files (Monitor's Prod.grupp + Leverantör, the template's
// Nummer + Leverantörsnummer + Ledtid) are the resource page's own import and
// never a supplier file — every heading the lego import reads besides the
// name and the supplier rules a file out.
const SUPPLIER_KEY_HEADINGS = ["leverantor", "leverantorsnummer", "leverantorsnr", "levnr"];
const NOT_SUPPLIER_HEADINGS = [
  "artikelnummer",
  ...Object.entries(LEGO_WORK_CENTER_HEADER_ALIASES)
    .filter(([, field]) => field !== "name" && field !== "supplierNumber")
    .map(([heading]) => heading),
];
// Referenser ("Referens – Namn") and the contact template (Mobiltelefon,
// Faxnummer, Anmärkning, Förvald without an address line — as the customers').
const SUPPLIER_CONTACT_HEADINGS = ["referensnamn", "mobiltelefon", "faxnummer", "anmarkning"];
// Leveransadress ("Leveransadress – Namn") and the template (Adressnamn).
const SUPPLIER_DELIVERY_ADDRESS_HEADINGS = ["leveransadressnamn", "adressnamn"];

function detectSupplierFile(present: Set<string>, headers: string[]): ImportEntity | null {
  if (!SUPPLIER_KEY_HEADINGS.some((heading) => present.has(heading))) return null;
  if (NOT_SUPPLIER_HEADINGS.some((heading) => present.has(heading))) return null;
  if (isContactFile(present, SUPPLIER_CONTACT_HEADINGS)) return "supplierContacts";
  if (SUPPLIER_DELIVERY_ADDRESS_HEADINGS.some((heading) => present.has(heading))) return "supplierDeliveryAddresses";
  // Same rule as the customers: Besöksadress maps nothing but the number and
  // stays unrecognised.
  const mapped = Object.values(suggestSupplierMapping(headers));
  return mapped.some((field) => field !== null && field !== "supplierNumber") ? "suppliers" : null;
}

function presentHeadings(headers: string[]): Set<string> {
  // parse() suffixes repeated headings ("Pris (2)") — strip that before
  // normalizing, as suggestMapping does.
  return new Set(headers.map((header) => normalizeHeader(header.replace(/ \(\d+\)$/, ""))));
}

export function detectImportEntity(headers: string[]): ImportEntity | null {
  const present = presentHeadings(headers);
  for (const signature of IMPORT_ENTITY_SIGNATURES) {
    if (!signature.all.every((heading) => present.has(heading))) continue;
    if (signature.any && !signature.any.some((heading) => present.has(heading))) continue;
    if (signature.needsTimeColumn && !ROUTING_TIME_HEADINGS.some((heading) => present.has(heading))) continue;
    if (signature.needsQuantity && !STOCK_QUANTITY_HEADINGS.some((heading) => present.has(heading))) continue;
    return signature.entity;
  }
  return detectCustomerFile(present, headers) ?? detectSupplierFile(present, headers);
}

// Order WITHIN one entity in the multi-file import (lower first; the wizard
// sorts by entity order, then rank, then file name).
// - customers: the Lista-like files (Lista, Övrigt) map their short "Namn" to
//   the name and must run before Postadress, whose legal name is the one to
//   keep.
// - suppliers: likewise the Lista-like files (Övrigt, Villkor, the older
//   Lista) before Postadress.
// - articles: only a file with a Benämning column can create articles (a new
//   article needs a name), so it runs before the sub-exports that only add
//   fields (Extra-fält …) — otherwise those preview every new article as
//   "Benämning saknas". Among the named files, one that carries Ledtid but
//   not Leverantörsnr (Planering) runs after the ones that set the primary
//   supplier (Inköp och Ritningsnummer): a purchased article's Ledtid lands
//   on its primary supplier.
export function importFileRank(entity: ImportEntity, headers: string[]): number {
  if (entity === "customers") return isCustomerListaFile(headers) ? 0 : 1;
  if (entity === "suppliers") return isSupplierListaFile(headers) ? 0 : 1;
  if (entity === "articles") {
    const fields = Object.values(suggestArticleMapping(headers));
    if (!fields.includes("name")) return 2;
    return fields.includes("leadTimeDays") && !fields.includes("primarySupplierNumber") ? 1 : 0;
  }
  return 0;
}
