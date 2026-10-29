import { z } from "zod";

// CSV/xlsx import (Monitor G5): the file is uploaded ONCE to
// POST /imports/:entity/parse; preview and commit then re-send the parsed
// rows as JSON together with the column mapping — the client never
// re-uploads the file.

// "bom" = artikelstruktur, "routing" = operationer. Both are create-only by
// default: a row that already exists is an error, not an update — unless
// skipExisting is set, which turns it into a skipped row instead. The
// routing import can additionally opt in to updateExisting (below).
// "customerContacts"/"customerDeliveryAddresses" (and their supplier
// mirrors) are also create-only, but unconditionally so — a matching row is
// ALWAYS skipped, never an error, with or without skipExisting (see
// customer-contacts.ts/customer-delivery-addresses.ts and the supplier-*
// siblings).
export const importEntitySchema = z.enum([
  "articles",
  "customers",
  "suppliers",
  "bom",
  "routing",
  "customerContacts",
  "customerDeliveryAddresses",
  "supplierContacts",
  "supplierDeliveryAddresses",
  // Monitor G5 Produktionsgruppslista: resources (Monitor's Produktionsgrupp),
  // lego resources (subcontract work centers) and production groups
  // (Monitor's Avdelning). Create-or-update by code, no number series.
  "workCenters",
  "legoWorkCenters",
  "productionGroups",
  // Monitor G5 article sub-exports, all upserts by key: alternative units
  // (Artikellista Enheter), the supplier catalog with price breaks (Prislista
  // Inköp, plain and stafflat) and customer prices (Prislista Försäljning).
  "articleUnits",
  "supplierPrices",
  "customerPrices",
  // Lagersaldon (#3): the balance per article and location AFTER the import —
  // the difference to today's balance is booked as a stock adjustment.
  "stockBalances",
]);
export type ImportEntity = z.infer<typeof importEntitySchema>;

// The order the multi-file article import ("Alla filer") commits the files
// it recognises in — each later entity depends on the earlier ones existing:
// units and prices need the articles, the structure resolves its Operation
// column against the routing. Mirrored in apps/web/lib/importEntities.ts.
export const IMPORT_ENTITY_ORDER: ImportEntity[] = [
  "articles",
  "articleUnits",
  "routing",
  "bom",
  "supplierPrices",
  "customerPrices",
  "stockBalances",
];

// CSV-header -> target-field name, or null = "importera inte". The KEY ORDER
// is the column order: key i of the mapping addresses column i of every row
// array (JSON objects preserve key order; the wizard builds the mapping from
// the parse response's headers in order).
export const importMappingSchema = z.record(z.string(), z.string().nullable());
export type ImportMapping = z.infer<typeof importMappingSchema>;

export const importCommitSchema = z.object({
  mapping: importMappingSchema,
  rows: z.array(z.array(z.string())).max(10000),
  defaults: z
    .object({ articleType: z.enum(["manufactured", "purchased", "service"]).optional() })
    .optional(),
  // "Hoppa över rader som redan finns": a row whose record already exists is
  // left completely alone — no update (articles/customers/suppliers), no row
  // error (bom/routing) — and reported back as skipped. Optional and additive:
  // omitted or false means today's behaviour, so the external configurator and
  // every existing caller are unaffected. NOT under `defaults` — that object
  // holds field values for new records, this is an import setting.
  skipExisting: z.boolean().optional(),
  // "Skapa saknade artiklar" — bara strukturimporten (bom) läser den. En
  // komponent som inte finns i artikelregistret skapas ur radens egna
  // kolumner i stället för att bli ett radfel. BEFINTLIGA artiklar rörs
  // aldrig; den ÖVERORDNADE artikeln skapas aldrig, eftersom filen varken
  // bär artikeltyp eller enhet för den. De fyra andra entiteterna ignorerar
  // flaggan tyst — samma linje som defaults.articleType. Optional och
  // additiv, så konfiguratorn och alla befintliga anrop är opåverkade.
  createMissingArticles: z.boolean().optional(),
  // "Skriv ut kommentaren på arbetskortet" — bara operationsimporten
  // (routing) läser den. Monitors Operationslista bär instruktionstexten men
  // ingen kolumn för om den ska ut på papperet, så valet gäller hela filen i
  // stället för raden. Av som standard, precis som kryssrutan på
  // artikelkortets operation. Övriga entiteter ignorerar flaggan tyst.
  printCommentOnWorkCard: z.boolean().optional(),
  // "Uppdatera befintliga operationer" (routing) / "Uppdatera befintliga
  // strukturrader" (bom — antal, enhet, operationskoppling när kolumnen är
  // mappad och Pos.) — bara de två importerna läser den. En operation som redan finns (artikel + sekvensnr) får
  // resurs, tider, tidsenhet, Kalkyl och de textfält filen fyller i
  // överskrivna i stället för att bli ett radfel. Snapshoten på
  // mo_operations (frisläppta TO) rörs aldrig — samma regel som PATCH på
  // artikelkortet. Utesluter skipExisting (båda ⇒ 400). Av som standard, så
  // konfiguratorn och alla befintliga anrop är opåverkade.
  updateExisting: z.boolean().optional(),
  // "Sätt som förvald leveransadress" — bara leveransadressimporterna
  // (customerDeliveryAddresses/supplierDeliveryAddresses) läser den. Standard TRUE när den utelämnas:
  // en importerad rad blir kundens förvalda leveransadress om kunden ännu
  // saknar en (i databasen eller bland tidigare rader i samma fil), annars
  // en varning och raden blir icke-förvald. Övriga entiteter ignorerar
  // flaggan tyst — samma linje som createMissingArticles/
  // printCommentOnWorkCard. Optional och additiv, så konfiguratorn och alla
  // befintliga anrop är opåverkade.
  setAsDefault: z.boolean().optional(),
});
export type ImportCommitInput = z.infer<typeof importCommitSchema>;

// GET /imports/:entity/fields — one entry per mappable field, in the
// wizard's field order. `header` is the column heading the Excel template
// uses (always recognised by the entity's own alias dictionary), `label` the
// wizard's field name, and `required` what the wizard marks with *. The
// mapping step shows `description`, the template's Instruktioner sheet and
// the manual chapter Importmallar show all of it.
export interface ImportFieldHelp {
  field: string;
  label: string;
  required: boolean;
  header: string;
  description: string;
  example: string;
}
