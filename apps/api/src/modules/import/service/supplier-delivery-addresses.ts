// Supplier delivery address import (Monitor G5 "Leveransadress" export).
// Sibling of supplier-contacts.ts: create-only, no update path — a row whose
// address matches something already on record (the supplier's own address
// or an existing delivery address) is skipped, never merged.
import type { ImportCommitInput } from "@navet/shared";
import {
  resolveColumns,
  suggestMapping,
  skippedRow,
  summarize,
  type ImportRowResult,
  type ImportSummary,
} from "./import.service.js";

// Mappable target fields, in the order the wizard lists them. address2/
// address3 are folded into `address` at plan time (same join as the
// customer card's address lines) — the table only stores one address
// column. Unlike the customer mirror, there is no `country` field:
// supplier_delivery_addresses (and suppliers) has no country column at all.
export const SUPPLIER_DELIVERY_ADDRESS_IMPORT_FIELDS = [
  "supplierNumber",
  "label",
  "address",
  "address2",
  "address3",
  "postalCode",
  "city",
] as const;
export type SupplierDeliveryAddressImportField = (typeof SUPPLIER_DELIVERY_ADDRESS_IMPORT_FIELDS)[number];

// Max lengths mirror supplier_delivery_addresses (packages/db/src/schema/purchase.ts).
// address/address2/address3 join into the text column `address` — no cap.
const MAX_LENGTHS: Partial<Record<SupplierDeliveryAddressImportField, number>> = {
  label: 100,
  postalCode: 20,
  city: 100,
};

// Swedish labels for row errors — keep in sync with
// SUPPLIER_DELIVERY_ADDRESS_IMPORT_FIELDS in apps/web/lib/importFields.ts.
const FIELD_LABELS: Record<SupplierDeliveryAddressImportField, string> = {
  supplierNumber: "Leverantörsnummer",
  label: "Namn",
  address: "Adressrad 1",
  address2: "Adressrad 2",
  address3: "Adressrad 3",
  postalCode: "Postnummer",
  city: "Stad",
};

// Normalized header -> target field (see import.service.ts's normalizeHeader:
// "Leveransadress – Namn" -> "leveransadressnamn"). "Adressrad 4", "Land"
// and the bare "Namn" column are deliberately left without an alias — Nav
// has no fourth address line or supplier country field, and the bare Namn
// column is not the delivery address's own name (that is
// "Leveransadress – Namn"). Monitor's supplier export carries no postal
// code/city columns at all, but the aliases are kept in case a future
// export (or a hand-edited file) adds them.
export const SUPPLIER_DELIVERY_ADDRESS_HEADER_ALIASES: Record<string, string> = {
  leverantor: "supplierNumber",
  leverantorsnummer: "supplierNumber",
  levnr: "supplierNumber",
  leveransadressnamn: "label",
  // The Excel template's heading (field-help.ts).
  adressnamn: "label",
  adressrad1: "address",
  adressrad2: "address2",
  adressrad3: "address3",
  postnummer: "postalCode",
  stad: "city",
  ort: "city",
  postort: "city",
  // Monitor prefixes every column with the block name ("Leveransadress –
  // Adressrad 1" -> "leveransadressadressrad1").
  leveransadressadressrad1: "address",
  leveransadressadressrad2: "address2",
  leveransadressadressrad3: "address3",
  leveransadresspostnummer: "postalCode",
  leveransadressstad: "city",
};

export function suggestSupplierDeliveryAddressMapping(headers: string[]): Record<string, string | null> {
  return suggestMapping(headers, SUPPLIER_DELIVERY_ADDRESS_HEADER_ALIASES);
}

// What the plan builder needs about a supplier's own address — loaded once
// per supplier number that occurs in the file, so a row can be compared
// against it (skip rule: "same as the supplier's address").
export interface ExistingSupplierAddress {
  id: string;
  address: string | null;
  postalCode: string | null;
  city: string | null;
}

// What the plan builder needs about a delivery address already on record.
export interface ExistingSupplierDeliveryAddress {
  address: string;
  postalCode: string | null;
  city: string | null;
  isDefault: boolean;
}

// Narrow lookups the planner runs against — implemented structurally by
// createImportRepository, stubbed with Maps in tests.
export interface SupplierDeliveryAddressImportDeps {
  supplierAddressesByNumber(numbers: string[]): Promise<Map<string, ExistingSupplierAddress>>;
  deliveryAddressesBySupplier(supplierIds: string[]): Promise<Map<string, ExistingSupplierDeliveryAddress[]>>;
}

export interface SupplierDeliveryAddressCreatePlan {
  supplierId: string;
  label: string;
  address: string;
  postalCode?: string;
  city?: string;
  isDefault: boolean;
}

export interface SupplierDeliveryAddressImportPlan {
  rows: ImportRowResult[];
  summary: ImportSummary;
  // Always empty — the preview/commit response shape is shared with the
  // article import.
  willCreate: { units: string[]; articleGroups: string[] };
  creates: SupplierDeliveryAddressCreatePlan[];
  hasErrors: boolean;
}

// Comparison key for the skip rules: address with line breaks folded to
// single spaces (Adressrad 1/2/3 are joined with \n), whitespace collapsed,
// case-insensitive; postal code with internal spaces stripped; city
// case-insensitive. No country component — the supplier tables carry none.
// Not exported — purely an internal dedupe key, never stored or shown.
function addressKey(address: string, postalCode: string, city: string): string {
  const normalizedAddress = address
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const normalizedPostal = postalCode.replace(/\s+/g, "");
  const normalizedCity = city.trim().toLowerCase();
  return `${normalizedAddress}|${normalizedPostal}|${normalizedCity}`;
}

// The SAME builder runs for preview and commit — commit never trusts the
// preview round-trip and re-plans from scratch (same shape as
// planSupplierImport).
export async function planSupplierDeliveryAddressImport(
  input: ImportCommitInput,
  deps: SupplierDeliveryAddressImportDeps
): Promise<SupplierDeliveryAddressImportPlan> {
  const columns = resolveColumns(
    input.mapping,
    [...SUPPLIER_DELIVERY_ADDRESS_IMPORT_FIELDS],
    ["supplierNumber"]
  );
  // "Sätt som förvald leveransadress" — top-level flag, default true when
  // omitted (see importCommitSchema in packages/shared/src/import.ts).
  const setAsDefault = input.setAsDefault ?? true;

  // One record per CSV row: target field -> trimmed cell (mapped columns only).
  const records = input.rows.map((row) => {
    const record: Record<string, string> = {};
    columns.forEach((field, i) => {
      if (field) record[field] = (row[i] ?? "").trim();
    });
    return record;
  });

  const numbers = records.map((r) => r["supplierNumber"] ?? "").filter((n) => n !== "");
  const existingSuppliers = await deps.supplierAddressesByNumber(numbers);
  const supplierIds = [...new Set([...existingSuppliers.values()].map((s) => s.id))];
  const existingBySupplier = await deps.deliveryAddressesBySupplier(supplierIds);

  // supplierId -> address keys already on record (claimed as rows in this
  // file are processed too, so two new rows creating the "same" address
  // both get caught), and the set of suppliers that already have a default
  // delivery address.
  const claimedKeysBySupplier = new Map<string, Set<string>>();
  const hasDefault = new Set<string>();
  for (const [supplierId, addresses] of existingBySupplier) {
    claimedKeysBySupplier.set(
      supplierId,
      new Set(addresses.map((a) => addressKey(a.address, a.postalCode ?? "", a.city ?? "")))
    );
    if (addresses.some((a) => a.isDefault)) hasDefault.add(supplierId);
  }

  const rows: ImportRowResult[] = [];
  const creates: SupplierDeliveryAddressCreatePlan[] = [];

  records.forEach((record, index) => {
    // 1-based data rows, +1 for the header line — matches what the user sees
    // when the file is open in Excel.
    const rowNumber = index + 2;
    const errors: string[] = [];
    const warnings: string[] = [];
    const values: Record<string, unknown> = {};

    const supplierNumber = record["supplierNumber"] ?? "";
    values["supplierNumber"] = supplierNumber;
    if (supplierNumber === "") errors.push("Leverantörsnummer saknas");

    const existingSupplier = supplierNumber !== "" ? existingSuppliers.get(supplierNumber) : undefined;
    if (supplierNumber !== "" && !existingSupplier) {
      errors.push(`Leverantören ${supplierNumber} finns inte — importera leverantörerna först`);
    }

    const line1 = record["address"] ?? "";
    const line2 = record["address2"] ?? "";
    const line3 = record["address3"] ?? "";
    const address = [line1, line2, line3].filter((line) => line !== "").join("\n");
    if (address !== "") values["address"] = address;

    const labelCell = record["label"] ?? "";
    if (labelCell !== "") {
      if (labelCell.length > (MAX_LENGTHS.label ?? Infinity)) {
        errors.push(`Fältet '${FIELD_LABELS.label}' är för långt (max ${MAX_LENGTHS.label} tecken)`);
      } else {
        values["label"] = labelCell;
      }
    }
    const label = labelCell !== "" ? labelCell : "Leveransadress";

    const postalCode = record["postalCode"] ?? "";
    if (postalCode !== "") {
      if (postalCode.length > (MAX_LENGTHS.postalCode ?? Infinity)) {
        errors.push(`Fältet '${FIELD_LABELS.postalCode}' är för långt (max ${MAX_LENGTHS.postalCode} tecken)`);
      } else {
        values["postalCode"] = postalCode;
      }
    }

    const city = record["city"] ?? "";
    if (city !== "") {
      if (city.length > (MAX_LENGTHS.city ?? Infinity)) {
        errors.push(`Fältet '${FIELD_LABELS.city}' är för långt (max ${MAX_LENGTHS.city} tecken)`);
      } else {
        values["city"] = city;
      }
    }

    if (errors.length > 0) {
      rows.push({ rowNumber, action: "create", errors, warnings, values });
      return;
    }

    // Monitor exports one row per supplier whether or not a delivery
    // address is filled in — a supplier without one comes through as a
    // bare name with empty address lines. Nothing to import, so the row is
    // skipped rather than blocking the whole file with an error.
    if (address === "") {
      rows.push(skippedRow(rowNumber, "Adress saknas", { ...record }));
      return;
    }

    const supplierId = existingSupplier!.id;
    const key = addressKey(address, postalCode, city);

    // Skip rule 1: same as the supplier's own (visiting) address. Monitor's
    // supplier "Leveransadress" export has no postal code/city columns, so
    // for the overwhelming majority of rows postalCode and city are both
    // empty — comparing the full key against the supplier's full address
    // would then almost never match (the supplier's own postal code/city
    // are usually filled in) even though the row IS the supplier's address.
    // When the row carries neither postal code nor city, also compare an
    // address-only key against the supplier's address-only key, so a plain
    // "Adressrad 1" match is still recognized as "same as the supplier's
    // address" instead of creating a redundant delivery address for every
    // supplier in the file.
    const mainKey = addressKey(
      existingSupplier!.address ?? "",
      existingSupplier!.postalCode ?? "",
      existingSupplier!.city ?? ""
    );
    const addressOnlyMatch =
      postalCode === "" &&
      city === "" &&
      addressKey(address, "", "") === addressKey(existingSupplier!.address ?? "", "", "");
    if (key === mainKey || addressOnlyMatch) {
      rows.push(skippedRow(rowNumber, "Samma som leverantörens adress", { ...record }));
      return;
    }

    // Skip rule 2: already a delivery address on the supplier, in the
    // database or claimed by an earlier row in this file.
    const claimedKeys = claimedKeysBySupplier.get(supplierId) ?? new Set<string>();
    if (claimedKeys.has(key)) {
      rows.push(skippedRow(rowNumber, "Leveransadressen finns redan", { ...record }));
      return;
    }
    claimedKeys.add(key);
    claimedKeysBySupplier.set(supplierId, claimedKeys);

    let isDefault = false;
    if (setAsDefault) {
      if (hasDefault.has(supplierId)) {
        warnings.push("Leverantören har redan en förvald leveransadress");
      } else {
        isDefault = true;
        hasDefault.add(supplierId);
      }
    }

    rows.push({ rowNumber, action: "create", errors, warnings, values });

    creates.push({
      supplierId,
      label,
      address,
      ...(postalCode !== "" ? { postalCode } : {}),
      ...(city !== "" ? { city } : {}),
      isDefault,
    });
  });

  return {
    rows,
    summary: summarize(rows),
    willCreate: { units: [], articleGroups: [] },
    creates,
    hasErrors: rows.some((row) => row.errors.length > 0),
  };
}
