// Recognises WHICH Monitor G5 article or customer export a file is from its header row,
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
// Faxnummer — the customer template has neither).
const CUSTOMER_CONTACT_HEADINGS = ["referensnamn", "mobiltelefon", "faxnummer"];
// Leveransadress ("Leveransadress – Namn") and the template (Adressnamn).
// Alternativa leveransadresser has neither; it is the only customer file
// with both Förvald and a bare Adressrad 1.
const CUSTOMER_DELIVERY_ADDRESS_HEADINGS = ["leveransadressnamn", "adressnamn"];

function detectCustomerFile(present: Set<string>, headers: string[]): ImportEntity | null {
  if (!CUSTOMER_KEY_HEADINGS.some((heading) => present.has(heading)) || present.has("artikelnummer")) return null;
  if (CUSTOMER_CONTACT_HEADINGS.some((heading) => present.has(heading))) return "customerContacts";
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
  return detectCustomerFile(present, headers);
}

// Order WITHIN one entity in the multi-file import (lower first; the wizard
// sorts by entity order, then rank, then file name).
// - customers: the Lista-like files (Lista, Övrigt) map their short "Namn" to
//   the name and must run before Postadress, whose legal name is the one to
//   keep.
// - articles: only a file with a Benämning column can create articles (a new
//   article needs a name), so it runs before the sub-exports that only add
//   fields (Extra-fält …) — otherwise those preview every new article as
//   "Benämning saknas".
export function importFileRank(entity: ImportEntity, headers: string[]): number {
  if (entity === "customers") return isCustomerListaFile(headers) ? 0 : 1;
  if (entity === "articles") return Object.values(suggestArticleMapping(headers)).includes("name") ? 0 : 1;
  return 0;
}
