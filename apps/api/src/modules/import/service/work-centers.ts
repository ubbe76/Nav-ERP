// Resource import (Monitor G5 "Produktionsgruppslista" — NOTES.md #7).
// Monitor's Produktionsgrupp IS Nav's resource (work center, three-digit
// number); Monitor's Avdelning is Nav's production group. Sibling of
// suppliers.ts: entity-specific planning here, shared machinery in
// import.service.ts, database work in import.repository.ts.
//
// Two Monitor files feed this planner: "Kostnader" (number, name, type,
// avdelning + its name, the hourly cost on the "Ordinarie" cost row — the
// file has one row per cost row, Ordinarie/Undantag 1/Undantag 2) and
// "Lista" (förvald ställtid, op. benämning). Lego resources are imported by
// lego-work-centers.ts from the "Lego" file; a Lista row typed as lego is
// skipped here with a pointer to that tab.
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
export const WORK_CENTER_IMPORT_FIELDS = [
  "code",
  "name",
  "type",
  "productionGroupCode",
  "productionGroupName",
  "hourlyRate",
  "calcRate1",
  "calcRate2",
  "rateAppliesToSetup",
  "rateAppliesToRun",
  "defaultSetupTime",
  "defaultOperationName",
  // Control column (Kostnader's second "Namn": Ordinarie / Undantag n) —
  // decides which rows count, never stored.
  "costRowName",
] as const;
export type WorkCenterImportField = (typeof WORK_CENTER_IMPORT_FIELDS)[number];

// Swedish labels for row errors — keep in sync with WORK_CENTER_IMPORT_FIELDS
// in apps/web/lib/importFields.ts.
const FIELD_LABELS: Record<WorkCenterImportField, string> = {
  code: "Nummer",
  name: "Namn",
  type: "Typ",
  productionGroupCode: "Avdelning (produktionsgrupp)",
  productionGroupName: "Avdelningens namn",
  hourlyRate: "Timkostnad",
  calcRate1: "Kalkylpris 1",
  calcRate2: "Kalkylpris 2",
  rateAppliesToSetup: "Gäller ställ",
  rateAppliesToRun: "Gäller styck",
  defaultSetupTime: "Förvald ställtid",
  defaultOperationName: "Förvald operationsbenämning",
  costRowName: "Kostnadsrad",
};

// Mirrors work_centers (packages/db/src/schema/manufacturing.ts) and
// production_groups.code.
const MAX_LENGTHS = { name: 100, defaultOperationName: 100, productionGroupCode: 20, productionGroupName: 100 } as const;

// Same rule as routing.ts / workCenterCodeSchema: exactly three digits.
const WORK_CENTER_CODE_PATTERN = /^[0-9]{3}$/;

// Excel stores 007 as the NUMBER 7 unless the column is text-formatted, and
// the xlsx reader then hands us "7". Pad 1–2 digits back to three — that is
// the spreadsheet's doing, not the user's, so it warrants no warning. Shared
// by the resource, lego resource and routing imports.
export function padWorkCenterCode(raw: string): string {
  return /^[0-9]{1,2}$/.test(raw) ? raw.padStart(3, "0") : raw;
}

// Normalized header -> target field (see import.service.ts's normalizeHeader:
// "Prod.grupp" -> "prodgrupp", "Aktuell, STD" -> "aktuellstd", "Förv. ställ"
// -> "forvstall", "Op. benämning" -> "opbenamning"). "Benämning" is the
// AVDELNING's name in Monitor's Kostnader export (the resource's own name is
// "Namn") — hence productionGroupName, not name.
export const WORK_CENTER_HEADER_ALIASES: Record<string, string> = {
  prodgrupp: "code",
  produktionsgrupp: "code",
  resurs: "code",
  resursnr: "code",
  resursnummer: "code",
  resurskod: "code",
  nummer: "code",
  namn: "name",
  typ: "type",
  avdelning: "productionGroupCode",
  avdelningskod: "productionGroupCode",
  benamning: "productionGroupName",
  avdelningsnamn: "productionGroupName",
  // The Excel template's headings (field-help.ts).
  avdelningensnamn: "productionGroupName",
  gallerstall: "rateAppliesToSetup",
  gallerstyck: "rateAppliesToRun",
  forvaldoperationsbenamning: "defaultOperationName",
  aktuellstd: "hourlyRate",
  timkostnad: "hourlyRate",
  aktuellkpris1: "calcRate1",
  aktuellkpris2: "calcRate2",
  kalkylpris1: "calcRate1",
  kalkylpris2: "calcRate2",
  forvstall: "rateAppliesToSetup",
  forvstyck: "rateAppliesToRun",
  forvaldstalltid: "defaultSetupTime",
  stalltid: "defaultSetupTime",
  opbenamning: "defaultOperationName",
  operationsbenamning: "defaultOperationName",
  kostnadsrad: "costRowName",
};

// The Kostnader file repeats "Namn" (and "Typ"): the SECOND "Namn" is the
// cost row's name (Ordinarie / Undantag n). suggestMapping hands a repeated
// heading to this dictionary; "Typ (2)" has no entry and stays unmapped.
const WORK_CENTER_SECONDARY_ALIASES: Record<string, string> = {
  namn: "costRowName",
};

export function suggestWorkCenterMapping(headers: string[]): Record<string, string | null> {
  return suggestMapping(headers, WORK_CENTER_HEADER_ALIASES, WORK_CENTER_SECONDARY_ALIASES);
}

export type WorkCenterKind = "machine" | "personnel" | "subcontract";

export interface ExistingWorkCenter {
  id: string;
  code: string;
  type: WorkCenterKind;
}

// Narrow lookups the planner runs against — implemented structurally by
// createImportRepository, stubbed with Maps in tests. productionGroupsByCode
// keys the LOWERCASED code.
export interface WorkCenterImportDeps {
  workCentersByCodeDetailed(): Promise<Map<string, ExistingWorkCenter>>;
  productionGroupsByCode(): Promise<Map<string, { id: string; name: string }>>;
}

export interface WorkCenterCreatePlan {
  code: string;
  name: string;
  type?: "machine" | "personnel";
  // Resolved id (group exists) XOR the code (group queued in
  // willCreate.productionGroups — the repository swaps it for the id).
  productionGroupId?: string;
  productionGroupCode?: string;
  hourlyRate?: number;
  calcRate1?: number;
  calcRate2?: number;
  rateAppliesToSetup?: boolean;
  rateAppliesToRun?: boolean;
  defaultSetupTime?: number;
  defaultOperationName?: string;
}

export interface WorkCenterUpdatePlan {
  id: string;
  // Empty cell = key absent = leave the stored value untouched.
  patch: Partial<Omit<WorkCenterCreatePlan, "code">>;
}

export interface WorkCenterImportPlan {
  rows: ImportRowResult[];
  summary: ImportSummary;
  // units/articleGroups stay empty (shared response shape). productionGroups
  // = display labels ("100 · Kapar") of the avdelningar the file mentions
  // that don't exist yet — the wizard lists willCreate.* as plain strings.
  willCreate: { units: string[]; articleGroups: string[]; productionGroups: string[] };
  // The same avdelningar as data for the repository's create step, deduped
  // by code; the name comes from "Benämning" when mapped, else the code.
  newProductionGroups: { code: string; name: string }[];
  creates: WorkCenterCreatePlan[];
  updates: WorkCenterUpdatePlan[];
  hasErrors: boolean;
}

// Monitor's "Typ": Maskin -> machine; Manuellt arbete / Personal -> personnel;
// a lego type belongs on the other tab; anything else is unknown.
export function parseWorkCenterType(raw: string): "machine" | "personnel" | "subcontract" | null {
  const value = raw.trim().toLowerCase();
  if (value === "") return null;
  if (value.includes("lego") || value.includes("underlev") || value.includes("extern")) return "subcontract";
  if (value.includes("maskin") || value === "machine") return "machine";
  if (value.includes("manuell") || value.includes("person") || value.includes("operat")) return "personnel";
  return null;
}

// Numbers as Monitor/Excel deliver them: "375", "0.1", "1 250,50".
export function parseNumberCell(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, "").replace(",", ".");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Same vocabulary as the customer/contact imports; Excel booleans arrive as
// "true"/"false".
export function parseBoolCell(raw: string): boolean | null {
  const value = raw.trim().toLowerCase();
  if (value === "ja" || value === "1" || value === "true" || value === "x") return true;
  if (value === "nej" || value === "0" || value === "false") return false;
  return null;
}

const NUMERIC_FIELDS = ["hourlyRate", "calcRate1", "calcRate2", "defaultSetupTime"] as const;
const BOOLEAN_FIELDS = ["rateAppliesToSetup", "rateAppliesToRun"] as const;

// The SAME builder runs for preview and commit — commit never trusts the
// preview round-trip and re-plans from scratch.
export async function planWorkCenterImport(
  input: ImportCommitInput,
  deps: WorkCenterImportDeps
): Promise<WorkCenterImportPlan> {
  const columns = resolveColumns(input.mapping, [...WORK_CENTER_IMPORT_FIELDS], ["code"]);
  const costRowMapped = columns.includes("costRowName");

  const records = input.rows.map((row) => {
    const record: Record<string, string> = {};
    columns.forEach((field, i) => {
      if (field) record[field] = (row[i] ?? "").trim();
    });
    if (record["code"] !== undefined) record["code"] = padWorkCenterCode(record["code"]);
    return record;
  });

  const existingByCode = await deps.workCentersByCodeDetailed();
  const groupsByCode = await deps.productionGroupsByCode();

  // Kostnader: one row per cost row (Ordinarie / Undantag n / custom names
  // like "Ordinarie 1000" or "Kostnadsfaktor 1"). Per resource, the row
  // whose name starts with "Ordinarie" carries the standard cost; a resource
  // with no such row falls back to its FIRST cost row (with a warning) so no
  // resource silently drops out of the import.
  const chosenRowByCode = new Map<string, number>();
  if (costRowMapped) {
    const firstRowByCode = new Map<string, number>();
    records.forEach((record, index) => {
      const code = record["code"] ?? "";
      if (code === "") return;
      if (!firstRowByCode.has(code)) firstRowByCode.set(code, index);
      const costRow = (record["costRowName"] ?? "").toLowerCase();
      if (costRow.startsWith("ordinarie") && !chosenRowByCode.has(code)) chosenRowByCode.set(code, index);
    });
    for (const [code, first] of firstRowByCode) {
      if (!chosenRowByCode.has(code)) chosenRowByCode.set(code, first);
    }
  }

  const rows: ImportRowResult[] = [];
  const creates: WorkCenterCreatePlan[] = [];
  const updates: WorkCenterUpdatePlan[] = [];
  const seenCodes = new Set<string>();
  // Lowercased avdelning code -> { code, name } queued for creation.
  const newGroups = new Map<string, { code: string; name: string }>();

  records.forEach((record, index) => {
    const rowNumber = index + 2;
    const errors: string[] = [];
    const warnings: string[] = [];
    const values: Record<string, unknown> = {};

    const code = record["code"] ?? "";
    values["code"] = code;

    // Kostnader: only the chosen cost row per resource (see chosenRowByCode)
    // is imported — Undantag rows are alternative rates, skipped not merged.
    const costRow = record["costRowName"] ?? "";
    if (costRowMapped && code !== "" && chosenRowByCode.get(code) !== index) {
      rows.push(skippedRow(rowNumber, `Kostnadsrad "${costRow}" — bara Ordinarie-raden importeras`, { ...record }));
      return;
    }
    if (costRowMapped && costRow !== "" && !costRow.toLowerCase().startsWith("ordinarie")) {
      warnings.push(`Ingen Ordinarie-rad för resursen — kostnadsraden "${costRow}" användes`);
    }

    const typeCell = record["type"] ?? "";
    const parsedType = parseWorkCenterType(typeCell);
    if (parsedType === "subcontract") {
      rows.push(skippedRow(rowNumber, "Legoresurs — importeras på fliken Legoresurser", { ...record }));
      return;
    }

    if (code === "") {
      errors.push("Nummer saknas");
    } else {
      if (!WORK_CENTER_CODE_PATTERN.test(code)) errors.push("Resursnumret ska vara exakt tre siffror");
      if (seenCodes.has(code)) errors.push("Resursnumret förekommer flera gånger i filen");
      seenCodes.add(code);
    }

    const existing = existingByCode.get(code);
    if (existing?.type === "subcontract") {
      errors.push(`Numret ${code} används av en legoresurs — importera den på fliken Legoresurser`);
    }
    if (existing && input.skipExisting) {
      rows.push(skippedRow(rowNumber, `Resursen ${code} finns redan i registret`, { ...record }));
      return;
    }
    const action: "create" | "update" = existing ? "update" : "create";

    const patch: Partial<Omit<WorkCenterCreatePlan, "code">> = {};

    const name = record["name"] ?? "";
    if (name !== "") {
      values["name"] = name;
      if (name.length > MAX_LENGTHS.name) errors.push(`Fältet '${FIELD_LABELS.name}' är för långt (max ${MAX_LENGTHS.name} tecken)`);
      else patch.name = name;
    } else if (!existing) {
      errors.push("Namn saknas — obligatoriskt för ny resurs");
    }

    if (typeCell !== "") {
      values["type"] = typeCell;
      if (parsedType === null) {
        warnings.push(`Okänd typ "${typeCell}" — ${existing ? "typen lämnades oförändrad" : "resursen importeras som Maskin"}`);
      } else {
        patch.type = parsedType;
      }
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

    for (const field of BOOLEAN_FIELDS) {
      const raw = record[field] ?? "";
      if (raw === "") continue;
      values[field] = raw;
      const b = parseBoolCell(raw);
      if (b === null) errors.push(`Ogiltigt värde för '${FIELD_LABELS[field]}': "${raw}" (Ja/Nej)`);
      else patch[field] = b;
    }

    const opName = record["defaultOperationName"] ?? "";
    if (opName !== "") {
      values["defaultOperationName"] = opName;
      if (opName.length > MAX_LENGTHS.defaultOperationName) {
        errors.push(`Fältet '${FIELD_LABELS.defaultOperationName}' är för långt (max ${MAX_LENGTHS.defaultOperationName} tecken)`);
      } else {
        patch.defaultOperationName = opName;
      }
    }

    // Avdelning -> production group: id on a hit, code queued for creation
    // on a miss (named from "Benämning" when that column is mapped and
    // filled — a later row may supply the name an earlier one lacked).
    const groupCode = record["productionGroupCode"] ?? "";
    const groupName = record["productionGroupName"] ?? "";
    if (groupCode !== "") {
      values["productionGroupCode"] = groupCode;
      if (groupName !== "") values["productionGroupName"] = groupName;
      if (groupCode.length > MAX_LENGTHS.productionGroupCode) {
        errors.push(`Fältet '${FIELD_LABELS.productionGroupCode}' är för långt (max ${MAX_LENGTHS.productionGroupCode} tecken)`);
      } else if (groupName.length > MAX_LENGTHS.productionGroupName) {
        errors.push(`Fältet '${FIELD_LABELS.productionGroupName}' är för långt (max ${MAX_LENGTHS.productionGroupName} tecken)`);
      } else {
        const key = groupCode.toLowerCase();
        const hit = groupsByCode.get(key);
        if (hit) {
          patch.productionGroupId = hit.id;
        } else {
          const queued = newGroups.get(key);
          if (!queued) newGroups.set(key, { code: groupCode, name: groupName || groupCode });
          else if (queued.name === queued.code && groupName !== "") queued.name = groupName;
          patch.productionGroupCode = groupCode;
        }
      }
    }

    rows.push({ rowNumber, action, errors, warnings, values });
    if (errors.length > 0) return;

    if (existing) {
      updates.push({ id: existing.id, patch });
    } else {
      // Error-free create rows always carry a name (checked above).
      creates.push({ code, ...patch } as WorkCenterCreatePlan);
    }
  });

  return {
    rows,
    summary: summarize(rows),
    willCreate: {
      units: [],
      articleGroups: [],
      productionGroups: [...newGroups.values()].map((g) => (g.name === g.code ? g.code : `${g.code} · ${g.name}`)),
    },
    newProductionGroups: [...newGroups.values()],
    creates,
    updates,
    hasErrors: rows.some((row) => row.errors.length > 0),
  };
}
