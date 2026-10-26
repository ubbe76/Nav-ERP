// Types and small helpers shared by ImportWizard (one file, one entity) and
// MultiFileImportWizard (every Monitor article export at once). Mirrors the
// API's response shapes — the web app cannot import @navet/shared.
import type { ImportFieldConfig } from "../../lib/importFields";

export interface ParseResponse {
  headers: string[];
  rows: string[][];
  suggestedMapping: Record<string, string | null>;
  meta: {
    format: "csv" | "xlsx";
    // Both null for xlsx — a workbook has neither.
    delimiter: string | null;
    encoding: string | null;
    // Both null for csv.
    sheetName: string | null;
    sheetCount: number | null;
    rowCount: number;
  };
}

// POST /imports/detect — parse() plus the entity recognised from the header
// row (null = unknown file; suggestedMapping is then empty).
export interface DetectResponse extends ParseResponse {
  detectedEntity: string | null;
}

export interface PreviewRow {
  rowNumber: number;
  // "skip" = the record already exists and Hoppa över befintliga is ticked.
  action: "create" | "update" | "skip";
  errors: string[];
  warnings: string[];
  values: Record<string, unknown>;
  skipReason?: string;
}

export interface PreviewResponse {
  rows: PreviewRow[];
  summary: { create: number; update: number; skip: number; error: number; warning: number };
  willCreate: Record<string, string[]>;
}

// The commit 400 carries the same shape as /preview — narrow it before
// rendering, since ApiError.body is whatever the server sent.
export function isPreviewResponse(body: unknown): body is PreviewResponse {
  return typeof body === "object" && body !== null && Array.isArray((body as PreviewResponse).rows);
}

export interface SkippedRow {
  rowNumber: number;
  reason: string;
  values: Record<string, unknown>;
}

export interface CommitResponse {
  created: number;
  updated: number;
  skipped: number;
  // The WHOLE list, uncapped — saving or printing it is the point of the
  // option. Only the on-screen table is capped.
  skippedRows: SkippedRow[];
  registersCreated: Record<string, string[]>;
}

export const ACTION_LABELS: Record<PreviewRow["action"], string> = {
  create: "Ny",
  update: "Uppdateras",
  skip: "Hoppas över",
};

// Labels for the auto-created register lists (willCreate/registersCreated
// keys) — later entity imports add their own keys here.
export const REGISTER_LABELS: Record<string, string> = {
  units: "Enheter",
  articleGroups: "Varugrupper",
  articleCodes: "Artikelkoder",
  articles: "Artiklar",
  paymentTerms: "Betalningsvillkor",
  deliveryTerms: "Leveransvillkor",
  carriers: "Speditörer",
  priceLists: "Prislistor",
};

// A Monitor structure file can bring 179 new components with it — spelling all
// of them out turns the notice into a wall of text.
const WILL_CREATE_PREVIEW = 20;

export function formatCodes(codes: string[]): string {
  return codes.length <= WILL_CREATE_PREVIEW
    ? codes.join(", ")
    : `${codes.slice(0, WILL_CREATE_PREVIEW).join(", ")} … och ${codes.length - WILL_CREATE_PREVIEW} till`;
}

// Selects rendered for the keys present in the `defaults` prop. The value is
// sent as-is in the request body's `defaults` object. Later entity imports
// add their own entries.
export const DEFAULT_SELECTS: Record<
  string,
  { label: string; hint: string; options: { value: string; label: string }[] }
> = {
  articleType: {
    label: "Standardtyp",
    hint: "Används för nya artiklar när kolumnen Artikeltyp inte är mappad eller cellen är tom.",
    options: [
      { value: "purchased", label: "Köpt" },
      { value: "manufactured", label: "Tillverkad" },
      { value: "service", label: "Tjänst" },
    ],
  },
};

// The printout is written into a blank window as raw HTML, so every value
// from the imported file has to be escaped on the way in. Both quote
// characters are covered even though the template interpolates into element
// text only: the day someone adds an attribute to it, this must already be
// safe rather than quietly one replace short.
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const PREVIEW_ROW_LIMIT = 200;

// Swedish file-name stems for the saved list of skipped rows — the entity keys
// are the API's English ones.
export const ENTITY_FILE_STEMS: Record<string, string> = {
  articles: "artiklar",
  customers: "kunder",
  suppliers: "leverantorer",
  bom: "struktur",
  routing: "operationer",
  customerContacts: "kontakter",
  customerDeliveryAddresses: "leveransadresser",
  articleUnits: "enheter",
  supplierPrices: "inkopspriser",
  customerPrices: "kundpriser",
};

// The mapping's KEY ORDER is the column order the API maps rows by — always
// build it from the headers array, in order, never by merging keys.
export function buildInitialMapping(
  headers: string[],
  suggested: Record<string, string | null>
): Record<string, string | null> {
  const initial: Record<string, string | null> = {};
  for (const header of headers) initial[header] = suggested[header] ?? null;
  return initial;
}

// Client-side check before /preview: every required field mapped, no field
// mapped twice. Returns the message to show, or null when the mapping is fine.
export function validateMapping(mapping: Record<string, string | null>, fields: ImportFieldConfig[]): string | null {
  const mapped = Object.values(mapping).filter((field): field is string => field !== null);
  for (const field of fields) {
    if (field.required && !mapped.includes(field.field)) {
      return `En kolumn måste mappas mot ${field.label}`;
    }
  }
  const seen = new Set<string>();
  for (const field of mapped) {
    if (seen.has(field)) {
      const label = fields.find((f) => f.field === field)?.label ?? field;
      return `Fältet ${label} är mappat mot två kolumner`;
    }
    seen.add(field);
  }
  return null;
}

// Problem rows first so they are visible without scrolling; skipped rows
// next, since they are the other thing the user came to look at.
export function sortPreviewRows(rows: PreviewRow[]): PreviewRow[] {
  return [...rows].sort(
    (a, b) =>
      Number(b.errors.length > 0) - Number(a.errors.length > 0) ||
      Number(b.warnings.length > 0) - Number(a.warnings.length > 0) ||
      Number(b.action === "skip") - Number(a.action === "skip") ||
      a.rowNumber - b.rowNumber
  );
}
