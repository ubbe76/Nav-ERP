// Supplier import (Monitor G5 CSV/xlsx, leverantörsimport — TODO2 #3).
// Sibling of articles.ts/customers.ts: the entity-specific planner lives
// here and builds on the shared machinery in import.service.ts
// (resolveColumns/suggestMapping/summarize/ImportRowResult); all database
// work lives in import.repository.ts.
//
// Monitor's supplier export is a family of files (Postadress, Lista,
// Referenser, Leveransadress) keyed by the "Leverantör" column — the same
// shape as the customer export, minus the invoice address (suppliers have
// none in Nav) and the price list/discount. Contacts and delivery addresses
// are their own entities (supplier-contacts.ts/
// supplier-delivery-addresses.ts); this planner handles the supplier row.
import { z } from "zod";
import type { ImportCommitInput } from "@navet/shared";
import {
  normalizeHeader,
  resolveColumns,
  suggestMapping,
  skippedRow,
  summarize,
  type ImportRowResult,
  type ImportSummary,
} from "./import.service.js";

// Mappable target fields, in the order the wizard lists them.
export const SUPPLIER_IMPORT_FIELDS = [
  "supplierNumber",
  "name",
  "orgNumber",
  "vatNumber",
  "contactName",
  "email",
  "phone",
  "address",
  "address2",
  "address3",
  "postalCode",
  "city",
  "currency",
  "ourCustomerNumber",
  "paymentTerm",
  "deliveryTerm",
  "carrier",
  "carrierCustomerNumber",
] as const;
export type SupplierImportField = (typeof SUPPLIER_IMPORT_FIELDS)[number];

// Max lengths mirror the suppliers table (packages/db/src/schema/purchase.ts)
// and — for the three register-lookup fields — the shared register tables'
// `name` column (packages/db/src/schema/register.ts). address/address2/
// address3 are merged into the text column `address` — no cap; currency is
// validated by regex instead; supplierNumber has its own message and is
// checked separately in the planner.
const MAX_LENGTHS: Partial<Record<SupplierImportField, number>> = {
  name: 255,
  orgNumber: 20,
  vatNumber: 30,
  contactName: 255,
  email: 255,
  phone: 50,
  postalCode: 20,
  city: 100,
  ourCustomerNumber: 50,
  paymentTerm: 100,
  deliveryTerm: 100,
  carrier: 100,
  carrierCustomerNumber: 50,
};

// Swedish labels for row errors — keep in sync with SUPPLIER_IMPORT_FIELDS
// in apps/web/lib/importFields.ts.
const FIELD_LABELS: Record<SupplierImportField, string> = {
  supplierNumber: "Leverantörsnummer",
  name: "Namn",
  orgNumber: "Organisationsnummer",
  vatNumber: "VAT-nummer",
  contactName: "Kontaktperson",
  email: "E-post",
  phone: "Telefon",
  address: "Adress",
  address2: "Adressrad 2",
  address3: "Adressrad 3",
  postalCode: "Postnummer",
  city: "Postort",
  currency: "Valuta",
  ourCustomerNumber: "Vårt kundnummer",
  paymentTerm: "Betalningsvillkor",
  deliveryTerm: "Leveransvillkor",
  carrier: "Leveranssätt/speditör",
  carrierCustomerNumber: "Kundnummer hos speditör",
};

// E-mail policy: an invalid address never blocks the row — the value is
// dropped (the cell is then treated as empty: NULL on create, untouched on
// update) with a row warning.
const emailSchema = z.string().email();
// Mirrors createSupplierSchema's currency regex (packages/shared/src/purchase.ts).
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

// Fields with row-specific handling below (address merging, the currency
// parser and the three register lookups) — skipped by the generic
// pass-through loop.
const SPECIAL_FIELDS: ReadonlySet<SupplierImportField> = new Set<SupplierImportField>([
  "address2",
  "address3",
  "currency",
  "paymentTerm",
  "deliveryTerm",
  "carrier",
]);

// Normalized header -> target field (see import.service.ts's
// normalizeHeader: "Lev.nr" -> "levnr", "Vårt kundnr" -> "vartkundnr",
// "Momsreg.nr" -> "momsregnr", "Postadress – Adressrad 1" ->
// "postadressadressrad1"). Monitor's Postadress export names the FULL
// address block "Postadress – Namn" — that alias is also registered in
// SUPPLIER_PREFERRED_ALIASES so it beats the file's own short "Namn" column
// even though "Namn" comes first (see suggestMapping's `preferred` argument).
export const SUPPLIER_HEADER_ALIASES: Record<string, string> = {
  leverantorsnummer: "supplierNumber",
  leverantorsnr: "supplierNumber",
  levnr: "supplierNumber",
  leverantor: "supplierNumber",
  namn: "name",
  leverantorsnamn: "name",
  postadressnamn: "name",
  organisationsnummer: "orgNumber",
  orgnr: "orgNumber",
  momsregnr: "vatNumber",
  vatnummer: "vatNumber",
  kontaktperson: "contactName",
  referens: "contactName",
  epost: "email",
  mail: "email",
  telefon: "phone",
  adress: "address",
  besoksadress: "address",
  gatuadress: "address",
  adressrad1: "address",
  adressrad2: "address2",
  adressrad3: "address3",
  // Monitor's Postadress export prefixes every address column with the
  // block name ("Postadress – Adressrad 1" -> "postadressadressrad1").
  // Adressrad 4 has no alias — Nav stores three.
  postadressadressrad1: "address",
  postadressadressrad2: "address2",
  postadressadressrad3: "address3",
  postadresspostnummer: "postalCode",
  postadressstad: "city",
  postnummer: "postalCode",
  postnr: "postalCode",
  ort: "city",
  postort: "city",
  stad: "city",
  valuta: "currency",
  vartkundnummer: "ourCustomerNumber",
  vartkundnr: "ourCustomerNumber",
  betalningsvillkor: "paymentTerm",
  leveransvillkor: "deliveryTerm",
  leveranssatt: "carrier",
  speditor: "carrier",
  kundnummerhosspeditor: "carrierCustomerNumber",
};

// Applied in a first pass, before the general alias contest — a specific
// heading always wins its field even when a more generic heading (mapped to
// the SAME field through SUPPLIER_HEADER_ALIASES) appears earlier in the
// file. Monitor's Postadress export lists the short "Namn" column before the
// full "Postadress – Namn" one.
const SUPPLIER_PREFERRED_ALIASES: Record<string, string> = {
  postadressnamn: "name",
};

// Normalized headings only Monitor's Lista export carries. Same rule as the
// customer import (CUSTOMER_LISTA_MARKERS): Lista runs first and creates
// the suppliers, so it is the one Monitor file whose short "Namn" maps to
// name; the Postadress run then replaces it via "Postadress – Namn".
// "Leverantörsroll" is deliberately NOT a marker — the Referenser export
// carries it too, and that file must never map "Namn".
export const SUPPLIER_LISTA_MARKERS = ["leverantorsgrupp", "minstaordervarde", "betalningsvillkor"];

export function suggestSupplierMapping(headers: string[]): Record<string, string | null> {
  const normalizedHeaders = headers.map((header) => normalizeHeader(header.replace(/ \(\d+\)$/, "")));
  let aliases = SUPPLIER_HEADER_ALIASES;
  // Monitor's multi-file export (recognised by its "Leverantör" number
  // column) carries the SHORT display name as "Namn" in every file. The
  // supplier's name in Nav is the legal one from "Postadress – Namn" —
  // auto-mapping the short one would overwrite it EXCEPT in the Lista file,
  // which is where suppliers are CREATED under the Lista-first order (a new
  // supplier needs a name). The Postadress run then replaces that short name
  // via the preferred "Postadress – Namn" alias, and the other Monitor files
  // (Referenser, Leveransadress, Besöksadress) leave "Namn" for the user to
  // map deliberately. Generic CSVs ("Leverantörsnummer"/"Lev.nr" + "Namn")
  // keep the old suggestion.
  const isListaFile = SUPPLIER_LISTA_MARKERS.some((marker) => normalizedHeaders.includes(marker));
  if (normalizedHeaders.includes("leverantor") && !isListaFile) {
    const { namn: _namn, ...rest } = aliases;
    aliases = rest;
  }
  return suggestMapping(headers, aliases, {}, SUPPLIER_PREFERRED_ALIASES);
}

// Narrow lookups the planner runs against — implemented structurally by
// createImportRepository, stubbed with Maps in tests. The three register
// lookups key BOTH the code and the name (lowercased, trimmed — the cell is
// already trimmed by the record builder below) to the same id, so a cell
// that names either one resolves. Shared with the customer planner on the
// repository side.
export interface SupplierImportDeps {
  suppliersByNumber(numbers: string[]): Promise<Map<string, { id: string }>>;
  paymentTermsByNameOrCode(): Promise<Map<string, string>>;
  deliveryTermsByNameOrCode(): Promise<Map<string, string>>;
  carriersByNameOrCode(): Promise<Map<string, string>>;
}

export interface SupplierCreatePlan {
  supplierNumber: string;
  name: string;
  orgNumber?: string;
  vatNumber?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  address?: string;
  postalCode?: string;
  city?: string;
  // Uppercased; omitted = the column's DB default 'SEK'.
  currency?: string;
  ourCustomerNumber?: string;
  // Resolved id (register hit) XOR the raw name (register miss — the
  // repository creates the row and swaps this for the id). Never both.
  paymentTermId?: string;
  paymentTermName?: string;
  deliveryTermId?: string;
  deliveryTermName?: string;
  carrierId?: string;
  carrierName?: string;
  carrierCustomerNumber?: string;
}

export interface SupplierUpdatePlan {
  id: string;
  // Empty CSV cell = key absent = leave the stored value untouched.
  patch: Partial<Omit<SupplierCreatePlan, "supplierNumber">>;
}

export interface SupplierImportPlan {
  rows: ImportRowResult[];
  summary: ImportSummary;
  // units/articleGroups stay empty — kept only so the preview/commit
  // response shape lines up with the article import's. The three register
  // keys are dedupe-by-lowercased-value lists of names that need creating
  // (original casing of the first occurrence in the file).
  willCreate: {
    units: string[];
    articleGroups: string[];
    paymentTerms: string[];
    deliveryTerms: string[];
    carriers: string[];
  };
  creates: SupplierCreatePlan[];
  updates: SupplierUpdatePlan[];
  // Highest all-digit supplier number in the file (capped at 9 digits —
  // number_series.next_number is an int4). null = leave the series alone.
  // The supplier entity's counterpart to the article plan's fallback ids.
  maxNumericNumber: number | null;
  hasErrors: boolean;
}

// address = [address, address2, address3] with empty parts dropped, joined
// by newline. All three unmapped or empty on a row yields "" — the caller
// treats that exactly like an empty cell on any other field (NULL on
// create, untouched on update).
function mergeAddressLines(...parts: (string | undefined)[]): string {
  return parts
    .map((part) => (part ?? "").trim())
    .filter((part) => part !== "")
    .join("\n");
}

// A register cell resolves against the existing register (by code OR name,
// case-insensitively) or — on a miss — is queued for creation. `newMap`
// dedupes by lowercased value across the whole file, keeping the first-seen
// casing (mirrors customers.ts). Length is checked against the register's
// `name` column BEFORE the lookup, so an oversized value is a row error
// rather than a register that fails to create in the transaction.
function resolveRegisterCell(
  field: SupplierImportField,
  record: Record<string, string>,
  values: Record<string, unknown>,
  errors: string[],
  lookup: Map<string, string>,
  newMap: Map<string, string>
): { id?: string; name?: string } {
  const raw = record[field] ?? "";
  if (raw === "") return {};
  values[field] = raw;
  const max = MAX_LENGTHS[field];
  if (max !== undefined && raw.length > max) {
    errors.push(`Fältet '${FIELD_LABELS[field]}' är för långt (max ${max} tecken)`);
    return {};
  }
  const key = raw.toLowerCase();
  const id = lookup.get(key);
  if (id !== undefined) return { id };
  if (!newMap.has(key)) newMap.set(key, raw);
  return { name: raw };
}

// The SAME builder runs for preview and commit — commit never trusts the
// preview round-trip and re-plans from scratch (same shape as
// planArticleImport).
export async function planSupplierImport(
  input: ImportCommitInput,
  deps: SupplierImportDeps
): Promise<SupplierImportPlan> {
  const columns = resolveColumns(input.mapping, [...SUPPLIER_IMPORT_FIELDS], ["supplierNumber"]);

  // One record per CSV row: target field -> trimmed cell (mapped columns only).
  const records = input.rows.map((row) => {
    const record: Record<string, string> = {};
    columns.forEach((field, i) => {
      if (field) record[field] = (row[i] ?? "").trim();
    });
    return record;
  });

  const numbers = records.map((r) => r["supplierNumber"] ?? "").filter((n) => n !== "");
  const existingByNumber = await deps.suppliersByNumber(numbers);
  const paymentTermLookup = await deps.paymentTermsByNameOrCode();
  const deliveryTermLookup = await deps.deliveryTermsByNameOrCode();
  const carrierLookup = await deps.carriersByNameOrCode();

  const rows: ImportRowResult[] = [];
  const creates: SupplierCreatePlan[] = [];
  const updates: SupplierUpdatePlan[] = [];
  const seenNumbers = new Set<string>();
  let maxNumericNumber: number | null = null;

  // Lowercased register value -> first-seen original casing, across the
  // whole file — becomes willCreate.<register>.
  const newPaymentTerms = new Map<string, string>();
  const newDeliveryTerms = new Map<string, string>();
  const newCarriers = new Map<string, string>();

  // The register's number series is pulled up to the highest numeric number
  // the file mentions. Called for created AND skipped rows: a skipped number
  // is taken by the existing record, so the series must not hand it out
  // again. Error rows never contribute.
  function bumpSeries(number: string): void {
    if (!/^[0-9]{1,9}$/.test(number)) return;
    const numeric = Number(number);
    if (maxNumericNumber === null || numeric > maxNumericNumber) maxNumericNumber = numeric;
  }

  records.forEach((record, index) => {
    // 1-based data rows, +1 for the header line — matches what the user sees
    // when the file is open in Excel.
    const rowNumber = index + 2;
    const errors: string[] = [];
    const warnings: string[] = [];
    const values: Record<string, unknown> = {};

    const supplierNumber = record["supplierNumber"] ?? "";
    values["supplierNumber"] = supplierNumber;
    if (supplierNumber === "") {
      errors.push("Leverantörsnummer saknas");
    } else {
      if (supplierNumber.length > 50) errors.push("Leverantörsnumret är för långt (max 50 tecken)");
      if (seenNumbers.has(supplierNumber)) errors.push("Leverantörsnumret förekommer flera gånger i filen");
      seenNumbers.add(supplierNumber);
    }

    const existing = existingByNumber.get(supplierNumber);
    if (existing && input.skipExisting) {
      // "Hoppa över rader som redan finns": the record is left completely
      // alone — no patch. Short-circuit before the field validation below, so
      // a bad cell on a row we are not importing cannot block the file. The
      // series bump still runs: the number is taken either way, and the
      // series must never hand it out again.
      bumpSeries(supplierNumber);
      rows.push(skippedRow(rowNumber, `Leverantören ${supplierNumber} finns redan i registret`, { ...record }));
      return;
    }
    const action: "create" | "update" = existing ? "update" : "create";

    // Field-by-field payload: valid, non-empty cells only. An invalid
    // e-mail is dropped with a warning (create -> NULL, update ->
    // untouched), so the import never blanks existing data.
    const patch: Partial<Omit<SupplierCreatePlan, "supplierNumber">> = {};
    for (const field of SUPPLIER_IMPORT_FIELDS) {
      if (field === "supplierNumber" || SPECIAL_FIELDS.has(field)) continue;
      const raw = record[field] ?? "";
      if (raw === "") continue;
      values[field] = raw;
      if (field === "email" && !emailSchema.safeParse(raw).success) {
        warnings.push(`Ogiltig e-postadress '${raw}' — fältet lämnades tomt`);
        continue;
      }
      const max = MAX_LENGTHS[field];
      if (max !== undefined && raw.length > max) {
        errors.push(`Fältet '${FIELD_LABELS[field]}' är för långt (max ${max} tecken)`);
        continue;
      }
      // SPECIAL_FIELDS.has(field) above already excludes every field that
      // isn't a plain patch key — TS can't narrow that at the type level, so
      // the assignment goes through an untyped index.
      (patch as Record<string, string>)[field] = raw;
    }

    // Address merging — overrides whatever the generic loop above set for
    // "address" alone with the full multi-line join.
    const mergedAddress = mergeAddressLines(record["address"], record["address2"], record["address3"]);
    if (mergedAddress !== "") {
      values["address"] = mergedAddress;
      patch.address = mergedAddress;
    }

    // currency — stored uppercased; an invalid code is a row ERROR.
    const currencyCell = record["currency"] ?? "";
    if (currencyCell !== "") {
      values["currency"] = currencyCell;
      const upper = currencyCell.toUpperCase();
      if (!CURRENCY_PATTERN.test(upper)) {
        errors.push(`Ogiltig valutakod '${currencyCell}' — ange 3 bokstäver, t.ex. SEK`);
      } else {
        patch.currency = upper;
      }
    }

    // The three register lookups: id on a hit, name (queued for creation)
    // on a miss.
    const paymentTerm = resolveRegisterCell(
      "paymentTerm",
      record,
      values,
      errors,
      paymentTermLookup,
      newPaymentTerms
    );
    if (paymentTerm.id !== undefined) patch.paymentTermId = paymentTerm.id;
    else if (paymentTerm.name !== undefined) patch.paymentTermName = paymentTerm.name;

    const deliveryTerm = resolveRegisterCell(
      "deliveryTerm",
      record,
      values,
      errors,
      deliveryTermLookup,
      newDeliveryTerms
    );
    if (deliveryTerm.id !== undefined) patch.deliveryTermId = deliveryTerm.id;
    else if (deliveryTerm.name !== undefined) patch.deliveryTermName = deliveryTerm.name;

    const carrier = resolveRegisterCell("carrier", record, values, errors, carrierLookup, newCarriers);
    if (carrier.id !== undefined) patch.carrierId = carrier.id;
    else if (carrier.name !== undefined) patch.carrierName = carrier.name;

    if (!existing && (record["name"] ?? "") === "") {
      errors.push("Namn saknas — obligatoriskt för ny leverantör");
    }

    rows.push({ rowNumber, action, errors, warnings, values });
    if (errors.length > 0) return; // an error row never contributes writes or a series bump

    bumpSeries(supplierNumber);

    if (existing) {
      updates.push({ id: existing.id, patch });
    } else {
      // Error-free create rows always carry a non-empty name (checked
      // above), so the narrowing to SupplierCreatePlan is safe.
      creates.push({ supplierNumber, ...patch } as SupplierCreatePlan);
    }
  });

  return {
    rows,
    summary: summarize(rows),
    willCreate: {
      units: [],
      articleGroups: [],
      paymentTerms: [...newPaymentTerms.values()],
      deliveryTerms: [...newDeliveryTerms.values()],
      carriers: [...newCarriers.values()],
    },
    creates,
    updates,
    maxNumericNumber,
    hasErrors: rows.some((row) => row.errors.length > 0),
  };
}
