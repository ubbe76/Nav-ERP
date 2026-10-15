// Recognises WHICH Monitor G5 article export a file is from its header row,
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

interface Signature {
  entity: ImportEntity;
  /** Every one of these normalized headings must be present. */
  all: string[];
  /** At least one of these must be present (when the list is non-empty). */
  any?: string[];
}

export const IMPORT_ENTITY_SIGNATURES: Signature[] = [
  // Materiallista: parent + component + quantity.
  { entity: "bom", all: ["huvudartikel", "artikelnummer", "kvantitet"] },
  // Operationslista: article + resource/sequence + a time column.
  { entity: "routing", all: ["artikelnummer"], any: ["produktionsgrupp", "op", "sekvensnr"] },
  // Artikellista, Enheter: the conversion factor is unique to it.
  { entity: "articleUnits", all: ["artikelnummer", "omrfaktor"] },
  // Prislista Inköp (plain and stafflat): supplier + price.
  { entity: "supplierPrices", all: ["artikelnummer", "leverantor", "pris"] },
  // Prislista Försäljning: customer + price.
  { entity: "customerPrices", all: ["artikelnummer", "kund", "pris"] },
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
      "ytbehandling",
      "vikt",
      "nettovikt",
      "bestallningspunkt",
      "orderkvantitet",
      "avrundning",
      "avrundningsantal",
      "partiformningsregel",
      "artikelgrupp",
      "aktiv",
    ],
  },
];

// The routing signature's "any" list is checked together with a time column
// so a bare article list with an "Op." column somewhere is not mistaken for
// a routing — Monitor's Operationslista always has Ställtid/Stycktid.
const ROUTING_TIME_HEADINGS = ["stalltid", "stycktid", "tidenhet"];

export function detectImportEntity(headers: string[]): ImportEntity | null {
  // parse() suffixes repeated headings ("Pris (2)") — strip that before
  // normalizing, as suggestMapping does.
  const present = new Set(headers.map((header) => normalizeHeader(header.replace(/ \(\d+\)$/, ""))));
  for (const signature of IMPORT_ENTITY_SIGNATURES) {
    if (!signature.all.every((heading) => present.has(heading))) continue;
    if (signature.any && !signature.any.some((heading) => present.has(heading))) continue;
    if (signature.entity === "routing" && !ROUTING_TIME_HEADINGS.some((heading) => present.has(heading))) continue;
    return signature.entity;
  }
  return null;
}
