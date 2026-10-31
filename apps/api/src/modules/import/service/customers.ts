// Customer import (Monitor G5 CSV, kundimport — TODO2 #2). Sibling of
// articles.ts: the entity-specific planner lives here and builds on the
// shared machinery in import.service.ts (resolveColumns/suggestMapping/
// summarize/ImportRowResult); all database work lives in
// import.repository.ts.
import { z } from "zod";
import type { ImportCommitInput } from "@navet/shared";
import { normalizeDecimal } from "./csv.js";
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
export const CUSTOMER_IMPORT_FIELDS = [
  "customerNumber",
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
  "country",
  "paymentTerm",
  "deliveryTerm",
  "carrier",
  "priceList",
  "discountPercent",
  "invoiceAddressDiffers",
  "invoiceName",
  "invoiceAddress",
  "invoiceAddress2",
  "invoiceAddress3",
  "invoicePostalCode",
  "invoiceCity",
  "invoiceCountry",
  "invoiceEmail",
  "ourSupplierNumber",
  "collectiveInvoicing",
  "invoiceOnHold",
  "privatePerson",
  "website",
  "currency",
] as const;
export type CustomerImportField = (typeof CUSTOMER_IMPORT_FIELDS)[number];

// Max lengths mirror the customers table (packages/db/src/schema/sales.ts)
// and — for the four register-lookup fields — the shared register tables'
// `name` column (packages/db/src/schema/register.ts). address/address2/
// address3/invoiceAddress(+2/3) are text columns — no cap; they are merged
// into address/invoiceAddress before any length matters anyway.
// customerNumber has its own message and is checked separately below.
const MAX_LENGTHS: Partial<Record<CustomerImportField, number>> = {
  name: 255,
  orgNumber: 20,
  vatNumber: 30,
  contactName: 255,
  email: 255,
  phone: 50,
  postalCode: 20,
  city: 100,
  paymentTerm: 100,
  deliveryTerm: 100,
  carrier: 100,
  priceList: 100,
  invoiceName: 255,
  invoicePostalCode: 20,
  invoiceCity: 100,
  invoiceEmail: 255,
  ourSupplierNumber: 50,
  website: 255,
};

// Swedish labels for row errors — keep in sync with CUSTOMER_IMPORT_FIELDS
// in apps/web/lib/importFields.ts.
const FIELD_LABELS: Record<CustomerImportField, string> = {
  customerNumber: "Kundnummer",
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
  country: "Land",
  paymentTerm: "Betalningsvillkor",
  deliveryTerm: "Leveransvillkor",
  carrier: "Leveranssätt/speditör",
  priceList: "Prislista",
  discountPercent: "Kundrabatt (%)",
  invoiceAddressDiffers: "Avviker från postadress",
  invoiceName: "Fakturanamn",
  invoiceAddress: "Fakturaadress",
  invoiceAddress2: "Fakturaadressrad 2",
  invoiceAddress3: "Fakturaadressrad 3",
  invoicePostalCode: "Fakturapostnummer",
  invoiceCity: "Fakturapostort",
  invoiceCountry: "Fakturaland",
  invoiceEmail: "E-post för faktura",
  ourSupplierNumber: "Vårt leverantörsnummer",
  collectiveInvoicing: "Samlingsfaktura",
  invoiceOnHold: "Faktura i vänteläge",
  privatePerson: "Privatperson",
  website: "Webbsida",
  currency: "Valuta",
};

// E-mail policy: an invalid address never blocks the row — the value is
// dropped (the cell is then treated as empty: NULL on create, untouched on
// update) with a row warning.
const EMAIL_FIELDS: ReadonlySet<CustomerImportField> = new Set<CustomerImportField>([
  "email",
  "invoiceEmail",
]);
const emailSchema = z.string().email();

// Fields with row-specific handling below (address merging, country
// validation, the discount/differs parsers and the four register lookups) —
// skipped by the generic pass-through loop.
const SPECIAL_FIELDS: ReadonlySet<CustomerImportField> = new Set<CustomerImportField>([
  "address2",
  "address3",
  "invoiceAddress2",
  "invoiceAddress3",
  "country",
  "invoiceCountry",
  "discountPercent",
  "invoiceAddressDiffers",
  "paymentTerm",
  "deliveryTerm",
  "carrier",
  "priceList",
  "collectiveInvoicing",
  "invoiceOnHold",
  "privatePerson",
  "currency",
]);

// Valuta: same rule as the supplier import's currency (ISO 4217, three
// letters, stored uppercased).
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

const COUNTRY_ERROR = "Land måste vara en landskod med två bokstäver (t.ex. SE)";

// Normalized header -> target field (see import.service.ts's
// normalizeHeader: "Besöksadress" -> "besoksadress", "Momsreg.nr" ->
// "momsregnr", "Faktura e-post" -> "fakturaepost"). Monitor's Postadress
// export names the FULL address block "Postadress – Namn" — that alias is
// also registered in CUSTOMER_PREFERRED_ALIASES so it beats the file's own
// short "Namn" column even though "Namn" comes first (see suggestMapping's
// `preferred` argument).
export const CUSTOMER_HEADER_ALIASES: Record<string, string> = {
  kundnummer: "customerNumber",
  kundnr: "customerNumber",
  kund: "customerNumber",
  namn: "name",
  kundnamn: "name",
  postadressnamn: "name",
  organisationsnummer: "orgNumber",
  // Monitor's Lista export abbreviates the heading to "Organisationsnr".
  organisationsnr: "orgNumber",
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
  postadressadressrad1: "address",
  postadressadressrad2: "address2",
  postadressadressrad3: "address3",
  postadresspostnummer: "postalCode",
  postadressstad: "city",
  postadressland: "country",
  postnummer: "postalCode",
  postnr: "postalCode",
  ort: "city",
  postort: "city",
  stad: "city",
  land: "country",
  fakturaadress: "invoiceAddress",
  fakturaadressnamn: "invoiceName",
  // ...and the Fakturaadress export the same way ("Fakturaadress –
  // Adressrad 1"). Adressrad 4 has no alias in either — Nav stores three.
  fakturaadressadressrad1: "invoiceAddress",
  fakturaadressadressrad2: "invoiceAddress2",
  fakturaadressadressrad3: "invoiceAddress3",
  fakturaadresspostnummer: "invoicePostalCode",
  fakturaadressstad: "invoiceCity",
  fakturaadressland: "invoiceCountry",
  fakturaepost: "invoiceEmail",
  // The Excel template's invoice headings (field-help.ts). They deliberately
  // do NOT include "fakturaadressnamn"/"avvikerfranpostadress", which would
  // flip suggestCustomerMapping into the invoice-address-file mode and turn
  // the template's own Adressrad 2/Postnummer/Land into invoice columns.
  fakturanamn: "invoiceName",
  fakturaadressrad2: "invoiceAddress2",
  fakturaadressrad3: "invoiceAddress3",
  fakturapostnummer: "invoicePostalCode",
  fakturapostort: "invoiceCity",
  fakturaland: "invoiceCountry",
  epostforfaktura: "invoiceEmail",
  avvikandefakturaadress: "invoiceAddressDiffers",
  avvikerfranpostadress: "invoiceAddressDiffers",
  betalningsvillkor: "paymentTerm",
  leveransvillkor: "deliveryTerm",
  leveranssatt: "carrier",
  // The template's heading "Leveranssätt/speditör".
  leveranssattspeditor: "carrier",
  prislista: "priceList",
  rabatt: "discountPercent",
  kundrabatt: "discountPercent",
  vartleverantorsnummer: "ourSupplierNumber",
  vartleverantorsnr: "ourSupplierNumber",
  samlingsfaktura: "collectiveInvoicing",
  fakturaivantelage: "invoiceOnHold",
  privatperson: "privatePerson",
  webbsida: "website",
  hemsida: "website",
  webbplats: "website",
  valuta: "currency",
  valutakod: "currency",
};

// Applied in a first pass, before the general alias contest — a specific
// heading always wins its field even when a more generic heading (mapped to
// the SAME field through CUSTOMER_HEADER_ALIASES) appears earlier in the
// file. Monitor's Postadress export lists the short "Namn" column before the
// full "Postadress – Namn" one; without this, "Namn" would claim `name` and
// "Postadress – Namn" would be left unmapped instead of the other way round.
const CUSTOMER_PREFERRED_ALIASES: Record<string, string> = {
  postadressnamn: "name",
};

// When Monitor's Fakturaadress export is detected — it carries "Fakturaadress
// – Namn" and/or "Avviker från postadress" — its "Adressrad 1..3",
// "Postnummer", "Stad" and "Land" columns (headings it shares verbatim with
// the Postadress export) mean the INVOICE address, not the customer's main
// one.
const INVOICE_CONTEXT_OVERRIDES: Record<string, string> = {
  adressrad1: "invoiceAddress",
  adressrad2: "invoiceAddress2",
  adressrad3: "invoiceAddress3",
  postnummer: "invoicePostalCode",
  stad: "invoiceCity",
  land: "invoiceCountry",
};

// Normalized headings only Monitor's Lista export carries — the three
// first from the 2026-09 export (Kundgrupp/Organisationsnr/Kreditlimit),
// the last two from the terms-bearing variant of the same list. The Lista
// run is where customers are CREATED under the Lista-first order, so it is
// the one Monitor file whose short "Namn" column maps to name.
export const CUSTOMER_LISTA_MARKERS = ["kundgrupp", "organisationsnr", "kreditlimit", "betalningsvillkor", "prislista"];

export function suggestCustomerMapping(headers: string[]): Record<string, string | null> {
  const normalizedHeaders = headers.map((header) => normalizeHeader(header.replace(/ \(\d+\)$/, "")));
  const isInvoiceAddressFile =
    normalizedHeaders.includes("fakturaadressnamn") || normalizedHeaders.includes("avvikerfranpostadress");
  let aliases = isInvoiceAddressFile
    ? { ...CUSTOMER_HEADER_ALIASES, ...INVOICE_CONTEXT_OVERRIDES }
    : CUSTOMER_HEADER_ALIASES;
  // Monitor's multi-file export (recognised by its "Kund" number column)
  // carries the SHORT display name as "Namn" in every file. Nav's customer
  // name is the legal one from "Postadress – Namn", so "Namn" is auto-mapped
  // in exactly one Monitor file: Lista, which runs FIRST and creates the
  // customers (a new customer needs a name). The Postadress run then
  // replaces that short name via the preferred "Postadress – Namn" alias,
  // and the address files (Fakturaadress, Leveransadress, Besöksadress)
  // leave "Namn" for the user to map deliberately. A file carrying both a
  // Lista marker and an invoice-address marker is treated as an address
  // file — the safe default is to never touch the name. Generic CSVs
  // ("Kundnummer"/"Kundnr" + "Namn") keep the old suggestion.
  const isListaFile =
    !isInvoiceAddressFile && CUSTOMER_LISTA_MARKERS.some((marker) => normalizedHeaders.includes(marker));
  if (normalizedHeaders.includes("kund") && !isListaFile) {
    const { namn: _namn, ...rest } = aliases;
    aliases = rest;
  }
  return suggestMapping(headers, aliases, {}, CUSTOMER_PREFERRED_ALIASES);
}

// Narrow lookups the planner runs against — implemented structurally by
// createImportRepository, stubbed with Maps in tests. The four register
// lookups key BOTH the code and the name (lowercased, trimmed — the cell is
// already trimmed by the record builder below) to the same id, so a cell
// that names either one resolves.
export interface CustomerImportDeps {
  customersByNumber(numbers: string[]): Promise<Map<string, { id: string }>>;
  paymentTermsByNameOrCode(): Promise<Map<string, string>>;
  deliveryTermsByNameOrCode(): Promise<Map<string, string>>;
  carriersByNameOrCode(): Promise<Map<string, string>>;
  priceListsByNameOrCode(): Promise<Map<string, string>>;
}

export interface CustomerCreatePlan {
  customerNumber: string;
  name: string;
  orgNumber?: string;
  vatNumber?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  address?: string;
  postalCode?: string;
  city?: string;
  country?: string;
  // Resolved id (register hit) XOR the raw name (register miss — the
  // repository creates the row and swaps this for the id). Never both.
  paymentTermId?: string;
  paymentTermName?: string;
  deliveryTermId?: string;
  deliveryTermName?: string;
  carrierId?: string;
  carrierName?: string;
  priceListId?: string;
  priceListName?: string;
  discountPercent?: number;
  invoiceName?: string;
  invoiceAddress?: string;
  invoicePostalCode?: string;
  invoiceCity?: string;
  invoiceCountry?: string;
  invoiceEmail?: string;
  ourSupplierNumber?: string;
  collectiveInvoicing?: boolean;
  invoiceOnHold?: boolean;
  privatePerson?: boolean;
  website?: string;
  currency?: string;
}

export interface CustomerUpdatePlan {
  id: string;
  // Empty CSV cell = key absent = leave the stored value untouched.
  patch: Partial<Omit<CustomerCreatePlan, "customerNumber">>;
}

export interface CustomerImportPlan {
  rows: ImportRowResult[];
  summary: ImportSummary;
  // units/articleGroups stay empty — kept only so the preview/commit
  // response shape lines up with the article import's. The four register
  // keys are dedupe-by-lowercased-value lists of names that need creating
  // (original casing of the first occurrence in the file).
  willCreate: {
    units: string[];
    articleGroups: string[];
    paymentTerms: string[];
    deliveryTerms: string[];
    carriers: string[];
    priceLists: string[];
  };
  creates: CustomerCreatePlan[];
  updates: CustomerUpdatePlan[];
  // Highest all-digit customer number in the file (capped at 9 digits —
  // number_series.next_number is an int4). null = leave the series alone.
  // The customer entity's counterpart to the article plan's fallback ids.
  maxNumericNumber: number | null;
  hasErrors: boolean;
}

function parseBoolCell(cell: string): boolean | null {
  const value = cell.trim().toLowerCase();
  if (value === "ja" || value === "1" || value === "true" || value === "x") return true;
  if (value === "nej" || value === "0" || value === "false") return false;
  return null;
}

// address = [address, address2, address3] with empty parts dropped, joined
// by newline (same rule for invoiceAddress/2/3). All three unmapped or empty
// on a row yields "" — the caller treats that exactly like an empty cell on
// any other field (NULL on create, untouched on update).
function mergeAddressLines(...parts: (string | undefined)[]): string {
  return parts
    .map((part) => (part ?? "").trim())
    .filter((part) => part !== "")
    .join("\n");
}

// A register cell resolves against the existing register (by code OR name,
// case-insensitively) or — on a miss — is queued for creation. `newMap`
// dedupes by lowercased value across the whole file, keeping the first-seen
// casing (mirrors newUnits in articles.ts). Length is checked against the
// register's `name` column BEFORE the lookup, so an oversized value is a row
// error rather than a register that fails to create in the transaction.
function resolveRegisterCell(
  field: CustomerImportField,
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
export async function planCustomerImport(
  input: ImportCommitInput,
  deps: CustomerImportDeps
): Promise<CustomerImportPlan> {
  const columns = resolveColumns(input.mapping, [...CUSTOMER_IMPORT_FIELDS], ["customerNumber"]);

  // One record per CSV row: target field -> trimmed cell (mapped columns only).
  const records = input.rows.map((row) => {
    const record: Record<string, string> = {};
    columns.forEach((field, i) => {
      if (field) record[field] = (row[i] ?? "").trim();
    });
    return record;
  });

  const numbers = records.map((r) => r["customerNumber"] ?? "").filter((n) => n !== "");
  const existingByNumber = await deps.customersByNumber(numbers);
  const paymentTermLookup = await deps.paymentTermsByNameOrCode();
  const deliveryTermLookup = await deps.deliveryTermsByNameOrCode();
  const carrierLookup = await deps.carriersByNameOrCode();
  const priceListLookup = await deps.priceListsByNameOrCode();

  const rows: ImportRowResult[] = [];
  const creates: CustomerCreatePlan[] = [];
  const updates: CustomerUpdatePlan[] = [];
  const seenNumbers = new Set<string>();
  let maxNumericNumber: number | null = null;

  // Lowercased register value -> first-seen original casing, across the
  // whole file — becomes willCreate.<register>.
  const newPaymentTerms = new Map<string, string>();
  const newDeliveryTerms = new Map<string, string>();
  const newCarriers = new Map<string, string>();
  const newPriceLists = new Map<string, string>();

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

    const customerNumber = record["customerNumber"] ?? "";
    values["customerNumber"] = customerNumber;
    if (customerNumber === "") {
      errors.push("Kundnummer saknas");
    } else {
      if (customerNumber.length > 50) errors.push("Kundnumret är för långt (max 50 tecken)");
      if (seenNumbers.has(customerNumber)) errors.push("Kundnumret förekommer flera gånger i filen");
      seenNumbers.add(customerNumber);
    }

    const existing = existingByNumber.get(customerNumber);
    if (existing && input.skipExisting) {
      // "Hoppa över rader som redan finns": the record is left completely
      // alone — no patch. Short-circuit before the field validation below, so
      // a bad cell on a row we are not importing cannot block the file. The
      // series bump still runs: the number is taken either way, and the
      // series must never hand it out again.
      bumpSeries(customerNumber);
      rows.push(skippedRow(rowNumber, `Kunden ${customerNumber} finns redan i registret`, { ...record }));
      return;
    }
    const action: "create" | "update" = existing ? "update" : "create";

    // Field-by-field payload: valid, non-empty cells only. An invalid
    // e-mail is dropped with a warning — the cell is then treated as empty
    // (NULL on create, untouched on update), so the import never blanks
    // existing data.
    const patch: Partial<Omit<CustomerCreatePlan, "customerNumber">> = {};
    for (const field of CUSTOMER_IMPORT_FIELDS) {
      if (field === "customerNumber" || SPECIAL_FIELDS.has(field)) continue;
      const raw = record[field] ?? "";
      if (raw === "") continue;
      values[field] = raw;
      if (EMAIL_FIELDS.has(field) && !emailSchema.safeParse(raw).success) {
        warnings.push(`Ogiltig e-postadress '${raw}' — fältet lämnades tomt`);
        continue;
      }
      const max = MAX_LENGTHS[field];
      if (max !== undefined && raw.length > max) {
        errors.push(`Fältet '${FIELD_LABELS[field]}' är för långt (max ${max} tecken)`);
        continue;
      }
      // SPECIAL_FIELDS.has(field) above already excludes every field that
      // isn't a plain patch key (address2/3, invoiceAddress2/3, country,
      // discountPercent, ...) — TS can't narrow that at the type level, so
      // the assignment goes through an untyped index.
      (patch as Record<string, string>)[field] = raw;
    }

    // Address merging — overrides whatever the generic loop above set for
    // "address"/"invoiceAddress" alone with the full multi-line join.
    const mergedAddress = mergeAddressLines(record["address"], record["address2"], record["address3"]);
    if (mergedAddress !== "") {
      values["address"] = mergedAddress;
      patch.address = mergedAddress;
    }
    const mergedInvoiceAddress = mergeAddressLines(
      record["invoiceAddress"],
      record["invoiceAddress2"],
      record["invoiceAddress3"]
    );
    if (mergedInvoiceAddress !== "") {
      values["invoiceAddress"] = mergedInvoiceAddress;
      patch.invoiceAddress = mergedInvoiceAddress;
    }

    // country / invoiceCountry — trim + uppercase, must be exactly two
    // letters. Empty cell: unset key (SE default on create, untouched on
    // update) — same as every other field.
    for (const field of ["country", "invoiceCountry"] as const) {
      const raw = record[field] ?? "";
      if (raw === "") continue;
      values[field] = raw;
      const upper = raw.toUpperCase();
      if (!/^[A-Z]{2}$/.test(upper)) {
        errors.push(COUNTRY_ERROR);
        continue;
      }
      patch[field] = upper;
    }

    // currency — stored uppercased; an invalid code is a row ERROR. Empty
    // cell: SEK on create, untouched on update.
    const currencyCell = record["currency"] ?? "";
    if (currencyCell !== "") {
      values["currency"] = currencyCell;
      const upper = currencyCell.toUpperCase();
      if (!CURRENCY_PATTERN.test(upper)) errors.push(`Ogiltig valutakod '${currencyCell}' — ange 3 bokstäver, t.ex. SEK`);
      else patch.currency = upper;
    }

    // discountPercent — normalizeDecimal handles Swedish "15,5"; 0–100.
    const discountCell = record["discountPercent"] ?? "";
    if (discountCell !== "") {
      values["discountPercent"] = discountCell;
      const parsed = normalizeDecimal(discountCell);
      if (parsed === null) {
        errors.push(`Ogiltig rabatt: "${discountCell}"`);
      } else if (parsed < 0 || parsed > 100) {
        errors.push("Kundrabatten måste vara mellan 0 och 100");
      } else {
        patch.discountPercent = parsed;
      }
    }

    // collectiveInvoicing / privatePerson — plain booleans stored directly
    // on the customer (unlike invoiceAddressDiffers, which is a control-only
    // field never written to the patch). Empty cell: unset key (leave
    // untouched on update / default false on create, same as every other
    // field).
    for (const field of ["collectiveInvoicing", "invoiceOnHold", "privatePerson"] as const) {
      const raw = record[field] ?? "";
      if (raw === "") continue;
      values[field] = raw;
      // Monitor's Samlingsfaktura is a MODE, not a checkbox: the Lista export
      // says "Nej" or "Per kund" (other modes read "Per …" as well). Every
      // "Per …" mode means the customer is on collective invoicing.
      const parsed =
        field === "collectiveInvoicing" && /^per\b/i.test(raw) ? true : parseBoolCell(raw);
      if (parsed === null) {
        errors.push(`Ogiltigt värde för '${FIELD_LABELS[field]}': "${raw}" (Ja/Nej)`);
      } else {
        patch[field] = parsed;
      }
    }

    // The four register lookups: id on a hit, name (queued for creation) on
    // a miss.
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

    const priceList = resolveRegisterCell(
      "priceList",
      record,
      values,
      errors,
      priceListLookup,
      newPriceLists
    );
    if (priceList.id !== undefined) patch.priceListId = priceList.id;
    else if (priceList.name !== undefined) patch.priceListName = priceList.name;

    // invoiceAddressDiffers — when mapped (any non-empty cell) and the row
    // parses to false, every invoice* key gathered above is dropped: Nav
    // falls back to the main address. invoiceEmail is NOT an invoice*
    // address field for this purpose and is left alone.
    const invoiceDiffersCell = record["invoiceAddressDiffers"] ?? "";
    if (invoiceDiffersCell !== "") {
      values["invoiceAddressDiffers"] = invoiceDiffersCell;
      const parsed = parseBoolCell(invoiceDiffersCell);
      if (parsed === null) {
        errors.push(
          `Ogiltigt värde för '${FIELD_LABELS.invoiceAddressDiffers}': "${invoiceDiffersCell}" (Ja/Nej/1/0/x/true/false)`
        );
      } else if (parsed === false) {
        delete patch.invoiceName;
        delete patch.invoiceAddress;
        delete patch.invoicePostalCode;
        delete patch.invoiceCity;
        delete patch.invoiceCountry;
      }
    }

    if (!existing && (record["name"] ?? "") === "") {
      errors.push("Namn saknas — obligatoriskt för ny kund");
    }

    rows.push({ rowNumber, action, errors, warnings, values });
    if (errors.length > 0) return; // an error row never contributes writes or a series bump

    bumpSeries(customerNumber);

    if (existing) {
      updates.push({ id: existing.id, patch });
    } else {
      // Error-free create rows always carry a non-empty name (checked
      // above), so the narrowing to CustomerCreatePlan is safe.
      creates.push({ customerNumber, ...patch } as CustomerCreatePlan);
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
      priceLists: [...newPriceLists.values()],
    },
    creates,
    updates,
    maxNumericNumber,
    hasErrors: rows.some((row) => row.errors.length > 0),
  };
}

// --- Register code generation (payment/delivery terms, carriers, price
// lists created by the import) ---

// Betalningsvillkor whose name starts with a day count ("30 dagar netto")
// get that number AS the code — it is what dueDateFromTerm
// (purchase/service/supplier-invoice.service.ts) parses back out to compute
// a due date. Anything else (including day-less terms like "Förskott") falls
// through to the generic slug.
export function generatePaymentTermCode(name: string): string {
  const match = /^(\d+)\s*dagar/i.exec(name.trim());
  if (match) return match[1]!;
  return slugifyRegisterCode(name);
}

// Generic register code: uppercased, Swedish å/ä->A ö->O (codes are
// varchar(20) and plain a-z0-9_ by convention), every other run of
// non-alphanumerics collapsed to one underscore, trimmed, capped at 20.
export function slugifyRegisterCode(name: string): string {
  let code = name
    .toUpperCase()
    .replace(/[ÅÄ]/g, "A")
    .replace(/Ö/g, "O")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (code.length > 20) code = code.slice(0, 20).replace(/_+$/g, "");
  return code === "" ? "X" : code;
}

// Assigns each name a unique code (in file order), given the codes already
// taken in the register (existingCodes, uppercased). A collision — with an
// existing row OR with a code already assigned earlier in this same batch —
// gets a numeric suffix (_2, _3, ...), truncating the base so the total never
// exceeds 20 characters.
export function assignRegisterCodes(
  names: string[],
  codeFor: (name: string) => string,
  existingCodes: ReadonlySet<string>
): Map<string, string> {
  const result = new Map<string, string>();
  const used = new Set(existingCodes);
  for (const name of names) {
    const base = codeFor(name);
    let candidate = base;
    let n = 2;
    while (used.has(candidate)) {
      const suffix = `_${n}`;
      candidate = base.length + suffix.length > 20 ? base.slice(0, 20 - suffix.length) + suffix : base + suffix;
      n++;
    }
    used.add(candidate);
    result.set(name, candidate);
  }
  return result;
}
