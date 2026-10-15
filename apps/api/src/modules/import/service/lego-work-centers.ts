// Lego resource import (Monitor G5 "Produktionsgruppslista – Lego"). A
// legoresurs is a work center of type "subcontract" whose default supplier
// is resolved from Monitor's "Leverantör" column (the supplier NUMBER) —
// suppliers must be imported first, same rule as the contact imports.
import type { ImportCommitInput } from "@navet/shared";
import {
  resolveColumns,
  suggestMapping,
  skippedRow,
  summarize,
  type ImportRowResult,
  type ImportSummary,
} from "./import.service.js";
import { parseNumberCell, type ExistingWorkCenter } from "./work-centers.js";

export const LEGO_WORK_CENTER_IMPORT_FIELDS = [
  "code",
  "name",
  "supplierNumber",
  "leadTimeDays",
  "queueTimeDays",
  "orderLeadTimeDays",
] as const;
export type LegoWorkCenterImportField = (typeof LEGO_WORK_CENTER_IMPORT_FIELDS)[number];

// Keep in sync with LEGO_WORK_CENTER_IMPORT_FIELDS in apps/web/lib/importFields.ts.
const FIELD_LABELS: Record<LegoWorkCenterImportField, string> = {
  code: "Nummer",
  name: "Namn",
  supplierNumber: "Leverantörsnummer",
  leadTimeDays: "Ledtid (dagar)",
  queueTimeDays: "Kötid (dagar)",
  orderLeadTimeDays: "Ledtid beställning (dagar)",
};

const WORK_CENTER_CODE_PATTERN = /^[0-9]{3}$/;
const NAME_MAX = 100;

// "Ledtid beställning" -> "ledtidbestallning" must be listed — the plain
// "ledtid" alias would otherwise not match it (different normalized key).
// Monitor's Lego file repeats "Namn" for the supplier's name and contact;
// those repeats get no secondary alias and stay unmapped on purpose.
export const LEGO_WORK_CENTER_HEADER_ALIASES: Record<string, string> = {
  prodgrupp: "code",
  produktionsgrupp: "code",
  resurs: "code",
  resursnr: "code",
  resursnummer: "code",
  legoresurs: "code",
  nummer: "code",
  namn: "name",
  leverantor: "supplierNumber",
  leverantorsnr: "supplierNumber",
  leverantorsnummer: "supplierNumber",
  levnr: "supplierNumber",
  ledtid: "leadTimeDays",
  ledtiddagar: "leadTimeDays",
  kotid: "queueTimeDays",
  kotiddagar: "queueTimeDays",
  ledtidbestallning: "orderLeadTimeDays",
  bestallningsledtid: "orderLeadTimeDays",
};

export function suggestLegoWorkCenterMapping(headers: string[]): Record<string, string | null> {
  return suggestMapping(headers, LEGO_WORK_CENTER_HEADER_ALIASES);
}

export interface LegoWorkCenterImportDeps {
  workCentersByCodeDetailed(): Promise<Map<string, ExistingWorkCenter>>;
  suppliersByNumber(numbers: string[]): Promise<Map<string, { id: string }>>;
}

export interface LegoWorkCenterCreatePlan {
  code: string;
  name: string;
  supplierId?: string;
  leadTimeDays?: number;
  queueTimeDays?: number;
  orderLeadTimeDays?: number;
}

export interface LegoWorkCenterUpdatePlan {
  id: string;
  patch: Partial<Omit<LegoWorkCenterCreatePlan, "code">>;
}

export interface LegoWorkCenterImportPlan {
  rows: ImportRowResult[];
  summary: ImportSummary;
  willCreate: { units: string[]; articleGroups: string[] };
  creates: LegoWorkCenterCreatePlan[];
  updates: LegoWorkCenterUpdatePlan[];
  hasErrors: boolean;
}

const NUMERIC_FIELDS = ["leadTimeDays", "queueTimeDays", "orderLeadTimeDays"] as const;

export async function planLegoWorkCenterImport(
  input: ImportCommitInput,
  deps: LegoWorkCenterImportDeps
): Promise<LegoWorkCenterImportPlan> {
  const columns = resolveColumns(input.mapping, [...LEGO_WORK_CENTER_IMPORT_FIELDS], ["code"]);

  const records = input.rows.map((row) => {
    const record: Record<string, string> = {};
    columns.forEach((field, i) => {
      if (field) record[field] = (row[i] ?? "").trim();
    });
    return record;
  });

  const existingByCode = await deps.workCentersByCodeDetailed();
  const supplierNumbers = records.map((r) => r["supplierNumber"] ?? "").filter((n) => n !== "");
  const suppliersByNumber = await deps.suppliersByNumber(supplierNumbers);

  const rows: ImportRowResult[] = [];
  const creates: LegoWorkCenterCreatePlan[] = [];
  const updates: LegoWorkCenterUpdatePlan[] = [];
  const seenCodes = new Set<string>();

  records.forEach((record, index) => {
    const rowNumber = index + 2;
    const errors: string[] = [];
    const warnings: string[] = [];
    const values: Record<string, unknown> = {};

    const code = record["code"] ?? "";
    values["code"] = code;
    if (code === "") {
      errors.push("Nummer saknas");
    } else {
      if (!WORK_CENTER_CODE_PATTERN.test(code)) errors.push("Resursnumret ska vara exakt tre siffror");
      if (seenCodes.has(code)) errors.push("Resursnumret förekommer flera gånger i filen");
      seenCodes.add(code);
    }

    const existing = existingByCode.get(code);
    if (existing && existing.type !== "subcontract") {
      errors.push(`Numret ${code} används av en resurs av typen ${existing.type === "machine" ? "maskin" : "personal"}`);
    }
    if (existing && input.skipExisting) {
      rows.push(skippedRow(rowNumber, `Legoresursen ${code} finns redan i registret`, { ...record }));
      return;
    }
    const action: "create" | "update" = existing ? "update" : "create";

    const patch: Partial<Omit<LegoWorkCenterCreatePlan, "code">> = {};

    const name = record["name"] ?? "";
    if (name !== "") {
      values["name"] = name;
      if (name.length > NAME_MAX) errors.push(`Fältet '${FIELD_LABELS.name}' är för långt (max ${NAME_MAX} tecken)`);
      else patch.name = name;
    } else if (!existing) {
      errors.push("Namn saknas — obligatoriskt för ny legoresurs");
    }

    const supplierNumber = record["supplierNumber"] ?? "";
    if (supplierNumber !== "") {
      values["supplierNumber"] = supplierNumber;
      const supplier = suppliersByNumber.get(supplierNumber);
      if (!supplier) errors.push(`Leverantören ${supplierNumber} finns inte — importera leverantörerna först`);
      else patch.supplierId = supplier.id;
    }

    for (const field of NUMERIC_FIELDS) {
      const raw = record[field] ?? "";
      if (raw === "") continue;
      values[field] = raw;
      const n = parseNumberCell(raw);
      if (n === null) errors.push(`Ogiltigt tal i '${FIELD_LABELS[field]}': "${raw}"`);
      else if (n < 0) errors.push(`'${FIELD_LABELS[field]}' får inte vara negativt`);
      else patch[field] = n;
    }

    rows.push({ rowNumber, action, errors, warnings, values });
    if (errors.length > 0) return;

    if (existing) updates.push({ id: existing.id, patch });
    else creates.push({ code, ...patch } as LegoWorkCenterCreatePlan);
  });

  return {
    rows,
    summary: summarize(rows),
    willCreate: { units: [], articleGroups: [] },
    creates,
    updates,
    hasErrors: rows.some((row) => row.errors.length > 0),
  };
}
