// Alternative-unit import (alternativa enheter — Monitor G5's
// "Artikellista, Enheter" export). Sibling of articles.ts/routing.ts: the
// planner lives here, all database work in import.repository.ts.
//
// One row per (article, unit). Monitor's Omr.faktor is "base units per ONE
// alternative unit" (Ø12 rod with base kg: the m row says 0,89 = 0,89 kg/m),
// while article_units.quantity_per_base is "alternative units per ONE base
// unit" — so the stored factor is 1 / Omr.faktor. The row whose factor is 1
// is the base unit itself: it is verified against the article's base unit
// and reported as skipped, never imported. Inköpsorder/Kundorder = true on
// an alternative row makes it the article's default purchase/sales unit.
//
// Upsert by (article, unit): an existing alternative unit gets its factor
// updated, with skipExisting it is left alone instead.
import type { ImportCommitInput } from "@navet/shared";
import { normalizeDecimal } from "./csv.js";
import type { ExistingArticle } from "./articles.js";
import {
  resolveColumns,
  suggestMapping,
  skippedRow,
  summarize,
  type ImportRowResult,
  type ImportSummary,
} from "./import.service.js";

// Mappable target fields, in the order the wizard lists them.
export const ARTICLE_UNIT_IMPORT_FIELDS = [
  "articleNumber",
  "unitCode",
  "factor",
  "isPurchaseUnit",
  "isSalesUnit",
] as const;
export type ArticleUnitImportField = (typeof ARTICLE_UNIT_IMPORT_FIELDS)[number];

const REQUIRED_FIELDS: ArticleUnitImportField[] = ["articleNumber", "unitCode", "factor"];

// Normalized header -> target field. Monitor's Enheter export heads the
// columns "Enh." (→ enh), "Omr.faktor" (→ omrfaktor), "Inköpsorder" and
// "Kundorder"; its other flag columns (Materialuttag, Rapportera inleverans,
// Packa för leverans, Lagerrapportering, Statistik, Förvald) have no target
// here and stay unmapped.
export const ARTICLE_UNIT_HEADER_ALIASES: Record<string, string> = {
  artikelnummer: "articleNumber",
  artikelnr: "articleNumber",
  artnr: "articleNumber",
  enh: "unitCode",
  enhet: "unitCode",
  enhetskod: "unitCode",
  alternativenhet: "unitCode",
  omrfaktor: "factor",
  omrakningsfaktor: "factor",
  omraknfaktor: "factor",
  omrakning: "factor",
  faktor: "factor",
  inkopsorder: "isPurchaseUnit",
  inkopsenhet: "isPurchaseUnit",
  kundorder: "isSalesUnit",
  forsaljningsenhet: "isSalesUnit",
  saljenhet: "isSalesUnit",
};

export function suggestArticleUnitMapping(headers: string[]): Record<string, string | null> {
  return suggestMapping(headers, ARTICLE_UNIT_HEADER_ALIASES);
}

// The xlsx reader stringifies Excel booleans to "true"/"false"; a CSV from a
// Swedish spreadsheet says Ja/Nej or 1/0. Empty = false.
function parseFlag(raw: string): boolean | null {
  const value = raw.trim().toLowerCase();
  if (value === "") return false;
  if (["ja", "j", "1", "true", "sant", "x"].includes(value)) return true;
  if (["nej", "n", "0", "false", "falskt"].includes(value)) return false;
  return null;
}

// Narrow lookups the planner runs against — implemented structurally by
// createImportRepository, stubbed with Maps in tests.
export interface ArticleUnitImportDeps {
  articlesByNumber(numbers: string[]): Promise<Map<string, ExistingArticle>>;
  /** Keyed by LOWERCASED code — units.code is case-sensitive in the DB. */
  unitsByCode(): Promise<Map<string, { id: string; code: string }>>;
  /** articleId -> unitId -> quantity_per_base, for the article's alternative units. */
  articleUnitFactors(articleIds: string[]): Promise<Map<string, Map<string, number>>>;
}

// unitCode rather than unitId: the unit may not exist yet (willCreate.units)
// and is resolved inside the commit transaction, like the article import.
export interface ArticleUnitCreatePlan {
  articleId: string;
  unitCode: string;
  quantityPerBase: number;
}

export interface ArticleUnitUpdatePlan {
  articleId: string;
  unitId: string;
  quantityPerBase: number;
}

// Default purchase/sales unit per article, from the Inköpsorder/Kundorder
// flags on alternative rows. Codes, resolved in the transaction.
export interface ArticleUnitDefaultsPlan {
  articleId: string;
  purchaseUnitCode?: string;
  salesUnitCode?: string;
}

export interface ArticleUnitImportPlan {
  rows: ImportRowResult[];
  summary: ImportSummary;
  // Unknown unit codes are created like the article import does; the
  // articleGroups half is always empty (shared response shape).
  willCreate: { units: string[]; articleGroups: string[] };
  creates: ArticleUnitCreatePlan[];
  updates: ArticleUnitUpdatePlan[];
  articleDefaults: ArticleUnitDefaultsPlan[];
  hasErrors: boolean;
}

// quantity_per_base is numeric(16,6).
function invertFactor(factor: number): number {
  return Math.round((1 / factor) * 1_000_000) / 1_000_000;
}

// The SAME builder runs for preview and commit — commit never trusts the
// preview round-trip and re-plans from scratch.
export async function planArticleUnitImport(
  input: ImportCommitInput,
  deps: ArticleUnitImportDeps
): Promise<ArticleUnitImportPlan> {
  const columns = resolveColumns(input.mapping, [...ARTICLE_UNIT_IMPORT_FIELDS], REQUIRED_FIELDS);

  const records = input.rows.map((row) => {
    const record: Record<string, string> = {};
    columns.forEach((field, i) => {
      if (field) record[field] = (row[i] ?? "").trim();
    });
    return record;
  });

  const numbers = records.map((r) => r["articleNumber"] ?? "").filter((n) => n !== "");
  const articlesByNumber = await deps.articlesByNumber(numbers);
  const unitMap = await deps.unitsByCode();
  const existingFactors = await deps.articleUnitFactors([...articlesByNumber.values()].map((a) => a.id));

  const rows: ImportRowResult[] = [];
  const creates: ArticleUnitCreatePlan[] = [];
  const updates: ArticleUnitUpdatePlan[] = [];
  const defaultsByArticle = new Map<string, ArticleUnitDefaultsPlan>();
  // Lowercased code -> the first-seen original casing (what gets created).
  const newUnits = new Map<string, string>();
  // "<articleId>#<lowercased unit code>" — recorded even for failed rows.
  const seen = new Set<string>();

  records.forEach((record, index) => {
    const rowNumber = index + 2;
    const errors: string[] = [];
    const warnings: string[] = [];
    const values: Record<string, unknown> = {};

    const articleNumber = record["articleNumber"] ?? "";
    values["articleNumber"] = articleNumber;
    const article = articlesByNumber.get(articleNumber);
    if (articleNumber === "") errors.push("Artikelnummer saknas");
    else if (!article) errors.push(`Artikeln ${articleNumber} finns inte i artikelregistret`);

    const unitCode = record["unitCode"] ?? "";
    values["unitCode"] = unitCode;
    if (unitCode === "") errors.push("Enhet saknas");
    else if (unitCode.length > 20) errors.push("Enhetskoden är för lång (max 20 tecken)");

    const rawFactor = record["factor"] ?? "";
    values["factor"] = rawFactor;
    let factor: number | null = null;
    if (rawFactor === "") {
      errors.push("Omräkningsfaktor saknas");
    } else {
      factor = normalizeDecimal(rawFactor);
      if (factor === null) errors.push(`Ogiltig omräkningsfaktor: "${rawFactor}"`);
      else if (factor <= 0) {
        errors.push("Omräkningsfaktorn måste vara större än 0");
        factor = null;
      }
    }

    const flags: Partial<Record<"isPurchaseUnit" | "isSalesUnit", boolean>> = {};
    const flagLabels = { isPurchaseUnit: "Inköpsorder", isSalesUnit: "Kundorder" } as const;
    for (const field of ["isPurchaseUnit", "isSalesUnit"] as const) {
      const raw = record[field] ?? "";
      values[field] = raw;
      const parsed = parseFlag(raw);
      if (parsed === null) errors.push(`Ogiltigt värde för ${flagLabels[field]}: "${raw}" (Ja/Nej/1/0/true/false)`);
      else flags[field] = parsed;
    }

    if (article && unitCode !== "" && errors.length === 0 && factor !== null) {
      const key = `${article.id}#${unitCode.toLowerCase()}`;
      if (seen.has(key)) errors.push(`Enheten ${unitCode} för artikel ${articleNumber} förekommer flera gånger i filen`);
      seen.add(key);

      const isBaseCode = unitCode.toLowerCase() === article.unitCode.toLowerCase();
      if (errors.length === 0 && factor === 1) {
        // The base-unit row. Monitor always lists it; it is verified, never
        // imported — article_units holds alternative units only.
        if (!isBaseCode) {
          warnings.push(`Grundenheten i filen (${unitCode}) avviker från artikelns grundenhet (${article.unitCode})`);
        }
        rows.push({
          ...skippedRow(rowNumber, "Grundenhet (faktor 1) — ingen alternativ enhet", { ...record }),
          warnings,
        });
        return;
      }
      if (errors.length === 0 && isBaseCode) {
        errors.push(`Enheten ${unitCode} är artikelns grundenhet och kan inte vara en alternativ enhet`);
      }
    }

    if (errors.length > 0 || !article || factor === null) {
      rows.push({ rowNumber, action: "create", errors, warnings, values });
      return;
    }

    const quantityPerBase = invertFactor(factor);
    values["quantityPerBase"] = quantityPerBase;
    const unit = unitMap.get(unitCode.toLowerCase());
    const existingFactor = unit ? existingFactors.get(article.id)?.get(unit.id) : undefined;

    if (existingFactor !== undefined && input.skipExisting) {
      rows.push(
        skippedRow(rowNumber, `Enheten ${unitCode} finns redan på artikel ${articleNumber}`, { ...record })
      );
      return;
    }

    // Default purchase/sales unit — at most one of each per article.
    const defaults = defaultsByArticle.get(article.id) ?? { articleId: article.id };
    if (flags.isPurchaseUnit) {
      if (defaults.purchaseUnitCode !== undefined) {
        errors.push(`Artikel ${articleNumber} har flera enheter markerade Inköpsorder i filen`);
      } else {
        defaults.purchaseUnitCode = unitCode;
      }
    }
    if (flags.isSalesUnit) {
      if (defaults.salesUnitCode !== undefined) {
        errors.push(`Artikel ${articleNumber} har flera enheter markerade Kundorder i filen`);
      } else {
        defaults.salesUnitCode = unitCode;
      }
    }
    if (errors.length > 0) {
      rows.push({ rowNumber, action: "create", errors, warnings, values });
      return;
    }
    if (defaults.purchaseUnitCode !== undefined || defaults.salesUnitCode !== undefined) {
      defaultsByArticle.set(article.id, defaults);
    }

    if (unit && existingFactor !== undefined) {
      rows.push({ rowNumber, action: "update", errors, warnings, values });
      updates.push({ articleId: article.id, unitId: unit.id, quantityPerBase });
      return;
    }
    if (!unit && !newUnits.has(unitCode.toLowerCase())) newUnits.set(unitCode.toLowerCase(), unitCode);
    rows.push({ rowNumber, action: "create", errors, warnings, values });
    creates.push({ articleId: article.id, unitCode, quantityPerBase });
  });

  return {
    rows,
    summary: summarize(rows),
    willCreate: { units: [...newUnits.values()], articleGroups: [] },
    creates,
    updates,
    articleDefaults: [...defaultsByArticle.values()],
    hasErrors: rows.some((row) => row.errors.length > 0),
  };
}
