// Customer delivery address import (Monitor G5 "Leveransadress" export).
// Sibling of customer-contacts.ts: create-only, no update path — a row whose
// address matches something already on record (the customer's own address
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
// column.
export const CUSTOMER_DELIVERY_ADDRESS_IMPORT_FIELDS = [
  "customerNumber",
  "label",
  "address",
  "address2",
  "address3",
  "postalCode",
  "city",
  "country",
] as const;
export type CustomerDeliveryAddressImportField = (typeof CUSTOMER_DELIVERY_ADDRESS_IMPORT_FIELDS)[number];

// Max lengths mirror customer_delivery_addresses (packages/db/src/schema/sales.ts).
// address/address2/address3 join into the text column `address` — no cap.
const MAX_LENGTHS: Partial<Record<CustomerDeliveryAddressImportField, number>> = {
  label: 100,
  postalCode: 20,
  city: 100,
};

// Swedish labels for row errors — keep in sync with
// CUSTOMER_DELIVERY_ADDRESS_IMPORT_FIELDS in apps/web/lib/importFields.ts.
const FIELD_LABELS: Record<CustomerDeliveryAddressImportField, string> = {
  customerNumber: "Kundnummer",
  label: "Namn",
  address: "Adressrad 1",
  address2: "Adressrad 2",
  address3: "Adressrad 3",
  postalCode: "Postnummer",
  city: "Stad",
  country: "Land",
};

// Normalized header -> target field (see import.service.ts's normalizeHeader:
// "Leveransadress – Namn" -> "leveransadressnamn"). "Adressrad 4" and the
// bare "Namn" column are deliberately left without an alias — Nav has no
// fourth address line, and the bare Namn column is not the delivery
// address's own name (that is "Leveransadress – Namn").
export const CUSTOMER_DELIVERY_ADDRESS_HEADER_ALIASES: Record<string, string> = {
  kund: "customerNumber",
  // The Excel template's headings (field-help.ts).
  kundnummer: "customerNumber",
  kundnr: "customerNumber",
  adressnamn: "label",
  leveransadressnamn: "label",
  adressrad1: "address",
  adressrad2: "address2",
  adressrad3: "address3",
  postnummer: "postalCode",
  stad: "city",
  land: "country",
  // Monitor prefixes every column with the block name ("Leveransadress –
  // Adressrad 1" -> "leveransadressadressrad1").
  leveransadressadressrad1: "address",
  leveransadressadressrad2: "address2",
  leveransadressadressrad3: "address3",
  leveransadresspostnummer: "postalCode",
  leveransadressstad: "city",
  leveransadressland: "country",
};

export function suggestCustomerDeliveryAddressMapping(headers: string[]): Record<string, string | null> {
  return suggestMapping(headers, CUSTOMER_DELIVERY_ADDRESS_HEADER_ALIASES);
}

const COUNTRY_PATTERN = /^[A-Z]{2}$/;

// What the plan builder needs about a customer's own address — loaded once
// per customer number that occurs in the file, so a row can be compared
// against it (skip rule: "same as the customer's address").
export interface ExistingCustomerAddress {
  id: string;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  country: string;
}

// What the plan builder needs about a delivery address already on record.
export interface ExistingDeliveryAddress {
  address: string;
  postalCode: string | null;
  city: string | null;
  country: string;
  isDefault: boolean;
}

// Narrow lookups the planner runs against — implemented structurally by
// createImportRepository, stubbed with Maps in tests.
export interface CustomerDeliveryAddressImportDeps {
  customerAddressesByNumber(numbers: string[]): Promise<Map<string, ExistingCustomerAddress>>;
  deliveryAddressesByCustomer(customerIds: string[]): Promise<Map<string, ExistingDeliveryAddress[]>>;
}

export interface CustomerDeliveryAddressCreatePlan {
  customerId: string;
  label: string;
  address: string;
  postalCode?: string;
  city?: string;
  country: string;
  isDefault: boolean;
}

export interface CustomerDeliveryAddressImportPlan {
  rows: ImportRowResult[];
  summary: ImportSummary;
  // Always empty — the preview/commit response shape is shared with the
  // article import.
  willCreate: { units: string[]; articleGroups: string[] };
  creates: CustomerDeliveryAddressCreatePlan[];
  hasErrors: boolean;
}

// Comparison key for the two skip rules: address with line breaks folded to
// single spaces (Adressrad 1/2/3 are joined with \n), whitespace collapsed,
// case-insensitive; postal code with internal spaces stripped; city
// case-insensitive; country uppercased. Not exported — purely an internal
// dedupe key, never stored or shown.
function addressKey(address: string, postalCode: string, city: string, country: string): string {
  const normalizedAddress = address
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const normalizedPostal = postalCode.replace(/\s+/g, "");
  const normalizedCity = city.trim().toLowerCase();
  const normalizedCountry = country.trim().toUpperCase();
  return `${normalizedAddress}|${normalizedPostal}|${normalizedCity}|${normalizedCountry}`;
}

// The SAME builder runs for preview and commit — commit never trusts the
// preview round-trip and re-plans from scratch (same shape as
// planCustomerImport).
export async function planCustomerDeliveryAddressImport(
  input: ImportCommitInput,
  deps: CustomerDeliveryAddressImportDeps
): Promise<CustomerDeliveryAddressImportPlan> {
  const columns = resolveColumns(
    input.mapping,
    [...CUSTOMER_DELIVERY_ADDRESS_IMPORT_FIELDS],
    ["customerNumber"]
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

  const numbers = records.map((r) => r["customerNumber"] ?? "").filter((n) => n !== "");
  const existingCustomers = await deps.customerAddressesByNumber(numbers);
  const customerIds = [...new Set([...existingCustomers.values()].map((c) => c.id))];
  const existingByCustomer = await deps.deliveryAddressesByCustomer(customerIds);

  // customerId -> address keys already on record (claimed as rows in this
  // file are processed too, so two new rows creating the "same" address
  // both get caught), and the set of customers that already have a default
  // delivery address.
  const claimedKeysByCustomer = new Map<string, Set<string>>();
  const hasDefault = new Set<string>();
  for (const [customerId, addresses] of existingByCustomer) {
    claimedKeysByCustomer.set(
      customerId,
      new Set(addresses.map((a) => addressKey(a.address, a.postalCode ?? "", a.city ?? "", a.country)))
    );
    if (addresses.some((a) => a.isDefault)) hasDefault.add(customerId);
  }

  const rows: ImportRowResult[] = [];
  const creates: CustomerDeliveryAddressCreatePlan[] = [];

  records.forEach((record, index) => {
    // 1-based data rows, +1 for the header line — matches what the user sees
    // when the file is open in Excel.
    const rowNumber = index + 2;
    const errors: string[] = [];
    const warnings: string[] = [];
    const values: Record<string, unknown> = {};

    const customerNumber = record["customerNumber"] ?? "";
    values["customerNumber"] = customerNumber;
    if (customerNumber === "") errors.push("Kundnummer saknas");

    const existingCustomer = customerNumber !== "" ? existingCustomers.get(customerNumber) : undefined;
    if (customerNumber !== "" && !existingCustomer) {
      errors.push(`Kunden ${customerNumber} finns inte — importera kunderna först`);
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

    const countryCell = record["country"] ?? "";
    let country = "SE";
    if (countryCell !== "") {
      const normalized = countryCell.trim().toUpperCase();
      if (!COUNTRY_PATTERN.test(normalized)) {
        errors.push(`Ogiltig landskod '${countryCell}' — ange två bokstäver, t.ex. SE`);
      } else {
        country = normalized;
        values["country"] = country;
      }
    }

    if (errors.length > 0) {
      rows.push({ rowNumber, action: "create", errors, warnings, values });
      return;
    }

    // Monitor exports one row per customer whether or not a delivery
    // address is filled in — a customer without one comes through as a
    // bare name with empty address lines. Nothing to import, so the row is
    // skipped rather than blocking the whole file with an error.
    if (address === "") {
      rows.push(skippedRow(rowNumber, "Adress saknas", { ...record }));
      return;
    }

    const customerId = existingCustomer!.id;
    const key = addressKey(address, postalCode, city, country);

    // Skip rule 1: same as the customer's own (visiting) address.
    const mainKey = addressKey(
      existingCustomer!.address ?? "",
      existingCustomer!.postalCode ?? "",
      existingCustomer!.city ?? "",
      existingCustomer!.country
    );
    if (key === mainKey) {
      rows.push(skippedRow(rowNumber, "Samma som kundens adress", { ...record }));
      return;
    }

    // Skip rule 2: already a delivery address on the customer, in the
    // database or claimed by an earlier row in this file.
    const claimedKeys = claimedKeysByCustomer.get(customerId) ?? new Set<string>();
    if (claimedKeys.has(key)) {
      rows.push(skippedRow(rowNumber, "Leveransadressen finns redan", { ...record }));
      return;
    }
    claimedKeys.add(key);
    claimedKeysByCustomer.set(customerId, claimedKeys);

    let isDefault = false;
    if (setAsDefault) {
      if (hasDefault.has(customerId)) {
        warnings.push("Kunden har redan en förvald leveransadress");
      } else {
        isDefault = true;
        hasDefault.add(customerId);
      }
    }

    rows.push({ rowNumber, action: "create", errors, warnings, values });

    creates.push({
      customerId,
      label,
      address,
      ...(postalCode !== "" ? { postalCode } : {}),
      ...(city !== "" ? { city } : {}),
      country,
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
