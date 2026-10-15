// Production group import (Monitor G5 "Avdelning" = Nav's produktionsgrupp).
// Monitor has no avdelning list of its own; the codes and names ride along
// on the Produktionsgruppslista (one row per RESOURCE), so the file mentions
// each avdelning many times — the first occurrence wins, the rest are
// skipped. "Produktionsgrupp" is deliberately NOT an alias for the code:
// in Monitor that column is the resource number (see work-centers.ts).
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

export const PRODUCTION_GROUP_IMPORT_FIELDS = ["code", "name", "description"] as const;
export type ProductionGroupImportField = (typeof PRODUCTION_GROUP_IMPORT_FIELDS)[number];

// Keep in sync with PRODUCTION_GROUP_IMPORT_FIELDS in apps/web/lib/importFields.ts.
const FIELD_LABELS: Record<ProductionGroupImportField, string> = {
  code: "Kod",
  name: "Namn",
  description: "Beskrivning",
};

// Mirrors production_groups (packages/db/src/schema/manufacturing.ts).
const MAX_LENGTHS: Record<ProductionGroupImportField, number> = { code: 20, name: 100, description: 2000 };

export const PRODUCTION_GROUP_HEADER_ALIASES: Record<string, string> = {
  avdelning: "code",
  avdelningskod: "code",
  kod: "code",
  benamning: "name",
  avdelningsnamn: "name",
  namn: "name",
  beskrivning: "description",
};

export function suggestProductionGroupMapping(headers: string[]): Record<string, string | null> {
  // In Monitor's Produktionsgruppslista "Namn" is the RESOURCE's name and
  // "Benämning" the avdelning's — when the file carries an "Avdelning"
  // column, "Namn" must not be suggested as the group name. A generic
  // Kod/Namn CSV keeps the plain suggestion.
  const normalized = headers.map((h) => normalizeHeader(h.replace(/ \(\d+\)$/, "")));
  let aliases = PRODUCTION_GROUP_HEADER_ALIASES;
  if (normalized.includes("avdelning")) {
    const { namn: _namn, ...rest } = aliases;
    aliases = rest;
  }
  return suggestMapping(headers, aliases);
}

export interface ProductionGroupImportDeps {
  productionGroupsByCode(): Promise<Map<string, { id: string; name: string }>>;
}

export interface ProductionGroupCreatePlan {
  code: string;
  name: string;
  description?: string;
}

export interface ProductionGroupUpdatePlan {
  id: string;
  patch: Partial<Omit<ProductionGroupCreatePlan, "code">>;
}

export interface ProductionGroupImportPlan {
  rows: ImportRowResult[];
  summary: ImportSummary;
  willCreate: { units: string[]; articleGroups: string[] };
  creates: ProductionGroupCreatePlan[];
  updates: ProductionGroupUpdatePlan[];
  hasErrors: boolean;
}

export async function planProductionGroupImport(
  input: ImportCommitInput,
  deps: ProductionGroupImportDeps
): Promise<ProductionGroupImportPlan> {
  const columns = resolveColumns(input.mapping, [...PRODUCTION_GROUP_IMPORT_FIELDS], ["code"]);

  const records = input.rows.map((row) => {
    const record: Record<string, string> = {};
    columns.forEach((field, i) => {
      if (field) record[field] = (row[i] ?? "").trim();
    });
    return record;
  });

  const existingByCode = await deps.productionGroupsByCode();

  const rows: ImportRowResult[] = [];
  const creates: ProductionGroupCreatePlan[] = [];
  const updates: ProductionGroupUpdatePlan[] = [];
  const seenCodes = new Set<string>();

  records.forEach((record, index) => {
    const rowNumber = index + 2;
    const errors: string[] = [];
    const values: Record<string, unknown> = {};

    const code = record["code"] ?? "";
    values["code"] = code;
    if (code === "") {
      rows.push({ rowNumber, action: "create", errors: ["Kod saknas"], warnings: [], values });
      return;
    }
    const key = code.toLowerCase();
    // One row per resource in Monitor's file: the same avdelning repeats.
    if (seenCodes.has(key)) {
      rows.push(skippedRow(rowNumber, "Avdelningen förekommer flera gånger i filen", { ...record }));
      return;
    }
    seenCodes.add(key);
    if (code.length > MAX_LENGTHS.code) errors.push(`Fältet '${FIELD_LABELS.code}' är för långt (max ${MAX_LENGTHS.code} tecken)`);

    const existing = existingByCode.get(key);
    if (existing && input.skipExisting) {
      rows.push(skippedRow(rowNumber, `Produktionsgruppen ${code} finns redan i registret`, { ...record }));
      return;
    }
    const action: "create" | "update" = existing ? "update" : "create";

    const patch: Partial<Omit<ProductionGroupCreatePlan, "code">> = {};
    for (const field of ["name", "description"] as const) {
      const raw = record[field] ?? "";
      if (raw === "") continue;
      values[field] = raw;
      if (raw.length > MAX_LENGTHS[field]) errors.push(`Fältet '${FIELD_LABELS[field]}' är för långt (max ${MAX_LENGTHS[field]} tecken)`);
      else patch[field] = raw;
    }

    rows.push({ rowNumber, action, errors, warnings: [], values });
    if (errors.length > 0) return;

    if (existing) updates.push({ id: existing.id, patch });
    // A new group without a mapped/filled name is named after its code.
    else creates.push({ code, name: patch.name ?? code, ...(patch.description ? { description: patch.description } : {}) });
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
