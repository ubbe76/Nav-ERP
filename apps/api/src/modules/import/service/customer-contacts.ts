// Customer contact import (Monitor G5 "Referenser" export). Sibling of
// customers.ts, but create-only: a (customer, name) pair that already
// exists is ALWAYS skipped — never updated, regardless of skipExisting —
// since there is no reasonable "which field wins" rule for a contact.
import { z } from "zod";
import type { ImportCommitInput } from "@navet/shared";
import {
  resolveColumns,
  suggestMapping,
  skippedRow,
  summarize,
  type ImportRowResult,
  type ImportSummary,
} from "./import.service.js";

// Mappable target fields, in the order the wizard lists them.
export const CUSTOMER_CONTACT_IMPORT_FIELDS = [
  "customerNumber",
  "name",
  "isPrimary",
  "phone",
  "mobile",
  "email",
  "comment",
  "fax",
] as const;
export type CustomerContactImportField = (typeof CUSTOMER_CONTACT_IMPORT_FIELDS)[number];

// Max lengths mirror customer_contacts (packages/db/src/schema/sales.ts).
// comment is a text column — no cap; fax is folded into comment (see below)
// and never stored on its own, so it gets the same soft cap as phone/mobile
// purely to catch obviously garbled cells.
const MAX_LENGTHS: Partial<Record<CustomerContactImportField, number>> = {
  name: 255,
  phone: 50,
  mobile: 50,
  email: 255,
  fax: 50,
};

// Swedish labels for row errors — keep in sync with CUSTOMER_CONTACT_IMPORT_FIELDS
// in apps/web/lib/importFields.ts.
const FIELD_LABELS: Record<CustomerContactImportField, string> = {
  customerNumber: "Kundnummer",
  name: "Namn",
  isPrimary: "Förvald",
  phone: "Telefon",
  mobile: "Mobiltelefon",
  email: "E-post",
  comment: "Anmärkning",
  fax: "Faxnummer",
};

const emailSchema = z.string().email();

// Normalized header -> target field (see import.service.ts's normalizeHeader:
// "Referens – Namn" -> "referensnamn"). Only the Referenser export's exact
// Monitor headings — "Kommentar", "F" and "Referenskategori" are
// deliberately left without an alias, same as the plan's omitted columns.
export const CUSTOMER_CONTACT_HEADER_ALIASES: Record<string, string> = {
  kund: "customerNumber",
  forvald: "isPrimary",
  referensnamn: "name",
  telefon: "phone",
  mobiltelefon: "mobile",
  epost: "email",
  faxnummer: "fax",
  anmarkning: "comment",
};

export function suggestCustomerContactMapping(headers: string[]): Record<string, string | null> {
  return suggestMapping(headers, CUSTOMER_CONTACT_HEADER_ALIASES);
}

// Boolparser in the style of articles.ts's parseActive, widened with "x" —
// Monitor's Förvald column is commonly ticked with a bare X.
function parseBoolCell(cell: string): boolean | null {
  const value = cell.trim().toLowerCase();
  if (value === "ja" || value === "1" || value === "true" || value === "x") return true;
  if (value === "nej" || value === "0" || value === "false") return false;
  return null;
}

// What the plan builder needs about a contact already on record — loaded
// once per customer id that occurs in the file.
export interface ExistingCustomerContact {
  id: string;
  name: string;
  isPrimary: boolean;
}

// Narrow lookups the planner runs against — implemented structurally by
// createImportRepository, stubbed with Maps in tests.
export interface CustomerContactImportDeps {
  customersByNumber(numbers: string[]): Promise<Map<string, { id: string }>>;
  contactsByCustomer(customerIds: string[]): Promise<Map<string, ExistingCustomerContact[]>>;
}

export interface CustomerContactCreatePlan {
  customerId: string;
  name: string;
  isPrimary: boolean;
  phone?: string;
  mobile?: string;
  email?: string;
  comment?: string;
}

export interface CustomerContactImportPlan {
  rows: ImportRowResult[];
  summary: ImportSummary;
  // Always empty — the preview/commit response shape is shared with the
  // article import.
  willCreate: { units: string[]; articleGroups: string[] };
  creates: CustomerContactCreatePlan[];
  hasErrors: boolean;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

// The SAME builder runs for preview and commit — commit never trusts the
// preview round-trip and re-plans from scratch (same shape as
// planCustomerImport).
export async function planCustomerContactImport(
  input: ImportCommitInput,
  deps: CustomerContactImportDeps
): Promise<CustomerContactImportPlan> {
  const columns = resolveColumns(
    input.mapping,
    [...CUSTOMER_CONTACT_IMPORT_FIELDS],
    ["customerNumber", "name"]
  );

  // One record per CSV row: target field -> trimmed cell (mapped columns only).
  const records = input.rows.map((row) => {
    const record: Record<string, string> = {};
    columns.forEach((field, i) => {
      if (field) record[field] = (row[i] ?? "").trim();
    });
    return record;
  });

  const numbers = records.map((r) => r["customerNumber"] ?? "").filter((n) => n !== "");
  const existingCustomers = await deps.customersByNumber(numbers);
  const customerIds = [...new Set([...existingCustomers.values()].map((c) => c.id))];
  const contactsByCustomerId = await deps.contactsByCustomer(customerIds);

  // customerId -> normalized names already on record, and the set of
  // customers that already have a primary contact (DB state; rows in this
  // file that claim the primary slot are added as they are processed).
  const existingNamesByCustomer = new Map<string, Set<string>>();
  const hasPrimary = new Set<string>();
  for (const [customerId, contacts] of contactsByCustomerId) {
    existingNamesByCustomer.set(customerId, new Set(contacts.map((c) => normalizeName(c.name))));
    if (contacts.some((c) => c.isPrimary)) hasPrimary.add(customerId);
  }

  const rows: ImportRowResult[] = [];
  const creates: CustomerContactCreatePlan[] = [];
  // customerId::normalizedName -> claimed by an earlier NEW row in this file
  // (only tracked for pairs that don't already exist in the database).
  const seenPairs = new Set<string>();

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

    const name = record["name"] ?? "";
    values["name"] = name;
    if (name === "") errors.push("Namn saknas");
    else if (name.length > (MAX_LENGTHS.name ?? Infinity)) {
      errors.push(`Fältet '${FIELD_LABELS.name}' är för långt (max ${MAX_LENGTHS.name} tecken)`);
    }

    const customerId = existingCustomer?.id ?? null;
    const nameIsUsable = name !== "" && name.length <= (MAX_LENGTHS.name ?? Infinity);

    // Existing (customer, name) match -> always skipped, never updated.
    // Only meaningful once both the customer and the name resolved cleanly.
    if (customerId !== null && nameIsUsable) {
      const normalizedName = normalizeName(name);
      const existingNames = existingNamesByCustomer.get(customerId) ?? new Set<string>();
      if (existingNames.has(normalizedName)) {
        rows.push(skippedRow(rowNumber, "Kontakten finns redan", { ...record }));
        return;
      }
    }

    // In-file duplicate: the same (customer, name) pair claimed by an
    // earlier NEW row in this file. Skipped, not an error — Monitor's
    // Referenser export carries genuine duplicates (the same person listed
    // twice on a customer), and one such pair should not block the other
    // thousand rows. The first occurrence wins, same as the database match.
    if (customerId !== null && nameIsUsable) {
      const dupKey = `${customerId}::${normalizeName(name)}`;
      if (seenPairs.has(dupKey)) {
        rows.push(skippedRow(rowNumber, "Kontakten förekommer flera gånger i filen", { ...record }));
        return;
      }
      seenPairs.add(dupKey);
    }

    const primaryCell = record["isPrimary"] ?? "";
    let isPrimary = false;
    if (primaryCell !== "") {
      const parsed = parseBoolCell(primaryCell);
      if (parsed === null) {
        errors.push(`Ogiltigt värde för Förvald: "${primaryCell}" (Ja/Nej/X/1/0/true/false)`);
      } else {
        isPrimary = parsed;
      }
      values["isPrimary"] = isPrimary;
    }
    if (isPrimary && customerId !== null) {
      if (hasPrimary.has(customerId)) {
        warnings.push(`Kunden har redan en huvudkontakt — ${name} importeras som vanlig kontakt`);
        isPrimary = false;
      } else {
        hasPrimary.add(customerId);
      }
    }

    const phone = record["phone"] ?? "";
    if (phone !== "") {
      if (phone.length > (MAX_LENGTHS.phone ?? Infinity)) {
        errors.push(`Fältet '${FIELD_LABELS.phone}' är för långt (max ${MAX_LENGTHS.phone} tecken)`);
      } else {
        values["phone"] = phone;
      }
    }

    const mobile = record["mobile"] ?? "";
    if (mobile !== "") {
      if (mobile.length > (MAX_LENGTHS.mobile ?? Infinity)) {
        errors.push(`Fältet '${FIELD_LABELS.mobile}' är för långt (max ${MAX_LENGTHS.mobile} tecken)`);
      } else {
        values["mobile"] = mobile;
      }
    }

    // E-mail policy: an invalid address never blocks the row — the value is
    // dropped (comment/fax and other fields still import) with a row
    // warning, same as the customer import.
    const emailCell = record["email"] ?? "";
    let email = "";
    if (emailCell !== "") {
      if (!emailSchema.safeParse(emailCell).success) {
        warnings.push(`Ogiltig e-postadress '${emailCell}' — fältet lämnades tomt`);
      } else if (emailCell.length > (MAX_LENGTHS.email ?? Infinity)) {
        errors.push(`Fältet '${FIELD_LABELS.email}' är för långt (max ${MAX_LENGTHS.email} tecken)`);
      } else {
        email = emailCell;
        values["email"] = emailCell;
      }
    }

    const commentCell = record["comment"] ?? "";
    const faxCell = record["fax"] ?? "";
    if (commentCell !== "") values["comment"] = commentCell;
    if (faxCell !== "") {
      if (faxCell.length > (MAX_LENGTHS.fax ?? Infinity)) {
        errors.push(`Fältet '${FIELD_LABELS.fax}' är för långt (max ${MAX_LENGTHS.fax} tecken)`);
      } else {
        values["fax"] = faxCell;
      }
    }
    // Fax is not its own column — Monitor's Faxnummer rides along inside
    // the free-text comment, joined with " · " when both are present.
    const faxValid = faxCell === "" || faxCell.length <= (MAX_LENGTHS.fax ?? Infinity);
    const comment = [commentCell, faxValid && faxCell !== "" ? `Fax ${faxCell}` : ""]
      .filter((part) => part !== "")
      .join(" · ");

    rows.push({ rowNumber, action: "create", errors, warnings, values });
    if (errors.length > 0) return;

    creates.push({
      customerId: customerId!,
      name,
      isPrimary,
      ...(phone !== "" ? { phone } : {}),
      ...(mobile !== "" ? { mobile } : {}),
      ...(email !== "" ? { email } : {}),
      ...(comment !== "" ? { comment } : {}),
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
