// Supplier price import (leverantörskatalogen — Monitor G5's "Prislista
// Inköp" exports). Sibling of articles.ts/routing.ts: the planner lives here,
// all database work in import.repository.ts.
//
// TWO Monitor files feed this one entity:
//   - "Prislista-Inköp, Lista": one row per (article, supplier) with Förvald,
//     Leverantör (the supplier number), Lev. art.nr, Pris, Rabatt.
//   - "Prislista-Inköp, stafflat": the same rows LEFT-JOINED with the price
//     breaks — a row per break carrying "Gränsvärde antal" and a SECOND
//     "Pris" column (parse() renames it "Pris (2)"), the base Pris repeated on
//     every row, and plain rows with an empty Gränsvärde. Förvald is absent.
// The rows are grouped by (article, supplier): the first row of a group is
// the catalog row, every row's break cells feed the staffel. Prices are the
// NET price — Monitor's Pris is gross and Rabatt a percentage off it, so the
// import stores Pris × (1 − Rabatt/100) and warns that the discount was
// baked in (article_suppliers has no discount column).
//
// Upsert by (article, supplier). Breaks are replaced as a whole set ONLY when
// the break column is mapped (the stafflat file is a full left join, so "no
// break rows" there means "no staffel"); the plain list never touches them.
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
export const SUPPLIER_PRICE_IMPORT_FIELDS = [
  "articleNumber",
  "supplierNumber",
  "supplierArticleNumber",
  "price",
  "discountPercent",
  "isPrimary",
  "breakQuantity",
  "breakPrice",
] as const;
export type SupplierPriceImportField = (typeof SUPPLIER_PRICE_IMPORT_FIELDS)[number];

const REQUIRED_FIELDS: SupplierPriceImportField[] = ["articleNumber", "supplierNumber"];

// Normalized header -> target field. Namn (the supplier's name), Ställpris,
// Prisdatum, Artikeltyp and Artikelkod have no target and stay unmapped.
export const SUPPLIER_PRICE_HEADER_ALIASES: Record<string, string> = {
  artikelnummer: "articleNumber",
  artikelnr: "articleNumber",
  artnr: "articleNumber",
  leverantor: "supplierNumber",
  leverantorsnummer: "supplierNumber",
  leverantorsnr: "supplierNumber",
  levnr: "supplierNumber",
  levartnr: "supplierArticleNumber",
  levartikelnr: "supplierArticleNumber",
  levartikelnummer: "supplierArticleNumber",
  leverantorensartikelnummer: "supplierArticleNumber",
  leverantorsartikelnummer: "supplierArticleNumber",
  pris: "price",
  inkopspris: "price",
  grundpris: "price",
  apris: "price",
  rabatt: "discountPercent",
  rabattprocent: "discountPercent",
  forvald: "isPrimary",
  huvudleverantor: "isPrimary",
  primar: "isPrimary",
  gransvardeantal: "breakQuantity",
  gransvarde: "breakQuantity",
  franantal: "breakQuantity",
  // The template's heading "Staffel: från antal".
  staffelfranantal: "breakQuantity",
  staffelantal: "breakQuantity",
  staffelpris: "breakPrice",
  stafflatpris: "breakPrice",
};

// Second chance for a heading that LOST the alias contest: the stafflat
// file's second "Pris" column is the break price. Same mechanism as the
// Materiallista's repeated "Artikelnummer" (see suggestMapping).
export const SUPPLIER_PRICE_SECONDARY_HEADER_ALIASES: Record<string, string> = {
  pris: "breakPrice",
};

export function suggestSupplierPriceMapping(headers: string[]): Record<string, string | null> {
  return suggestMapping(headers, SUPPLIER_PRICE_HEADER_ALIASES, SUPPLIER_PRICE_SECONDARY_HEADER_ALIASES);
}

function parseFlag(raw: string): boolean | null {
  const value = raw.trim().toLowerCase();
  if (value === "") return false;
  if (["ja", "j", "1", "true", "sant", "x"].includes(value)) return true;
  if (["nej", "n", "0", "false", "falskt"].includes(value)) return false;
  return null;
}

// numeric(14,4) — the price columns' scale.
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// Pris × (1 − Rabatt/100). Exported for the customer price import, which
// applies the same rule.
export function netPrice(gross: number, discountPercent: number): number {
  return round4(gross * (1 - discountPercent / 100));
}

// Narrow lookups the planner runs against — implemented structurally by
// createImportRepository, stubbed with Maps in tests.
export interface SupplierPriceImportDeps {
  articlesByNumber(numbers: string[]): Promise<Map<string, ExistingArticle>>;
  suppliersByNumber(numbers: string[]): Promise<Map<string, { id: string }>>;
  /** articleId -> supplierId -> the existing catalog row. */
  articleSuppliersByArticle(
    articleIds: string[]
  ): Promise<Map<string, Map<string, { id: string; isPrimary: boolean }>>>;
}

export interface SupplierPriceBreakPlan {
  fromQuantity: number;
  price: number;
}

export interface SupplierPriceCreatePlan {
  articleId: string;
  supplierId: string;
  supplierArticleNumber: string | null;
  price: number | null;
  isPrimary: boolean;
  breaks: SupplierPriceBreakPlan[];
}

export interface SupplierPriceUpdatePlan {
  id: string;
  articleId: string;
  // Empty cell = key absent = leave the stored value untouched; price is
  // patched to null only when the Pris column is mapped and empty? No —
  // an empty Pris cell leaves the stored price alone too (same rule as
  // every other import), so price is never null here.
  patch: {
    supplierArticleNumber?: string;
    price?: number;
    isPrimary?: boolean;
  };
  breaks: SupplierPriceBreakPlan[];
}

export interface SupplierPriceImportPlan {
  rows: ImportRowResult[];
  summary: ImportSummary;
  // Always empty — this import creates nothing in any register.
  willCreate: { units: string[]; articleGroups: string[] };
  creates: SupplierPriceCreatePlan[];
  updates: SupplierPriceUpdatePlan[];
  /** True iff the break-quantity column is mapped — only then are breaks replaced. */
  breaksMapped: boolean;
  /** Articles whose primary supplier the file sets — demoted first in the tx. */
  primaryArticleIds: string[];
  hasErrors: boolean;
}

interface Group {
  articleId: string;
  articleNumber: string;
  supplierId: string;
  existing: { id: string; isPrimary: boolean } | undefined;
  supplierArticleNumber: string | null;
  price: number | null;
  isPrimary: boolean | null;
  breaks: SupplierPriceBreakPlan[];
  breakQuantities: Set<number>;
  rowIndexes: number[];
}

// The SAME builder runs for preview and commit — commit never trusts the
// preview round-trip and re-plans from scratch.
export async function planSupplierPriceImport(
  input: ImportCommitInput,
  deps: SupplierPriceImportDeps
): Promise<SupplierPriceImportPlan> {
  const columns = resolveColumns(input.mapping, [...SUPPLIER_PRICE_IMPORT_FIELDS], REQUIRED_FIELDS);
  const breaksMapped = columns.includes("breakQuantity");
  const primaryMapped = columns.includes("isPrimary");

  const records = input.rows.map((row) => {
    const record: Record<string, string> = {};
    columns.forEach((field, i) => {
      if (field) record[field] = (row[i] ?? "").trim();
    });
    return record;
  });

  const articlesByNumber = await deps.articlesByNumber(
    records.map((r) => r["articleNumber"] ?? "").filter((n) => n !== "")
  );
  const suppliersByNumber = await deps.suppliersByNumber(
    records.map((r) => r["supplierNumber"] ?? "").filter((n) => n !== "")
  );
  const existingCatalog = await deps.articleSuppliersByArticle([...articlesByNumber.values()].map((a) => a.id));

  const rows: ImportRowResult[] = [];
  const groups = new Map<string, Group>();
  // articleId -> the supplier number the file marked Förvald first.
  const primaryByArticle = new Map<string, string>();

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

    const supplierNumber = record["supplierNumber"] ?? "";
    values["supplierNumber"] = supplierNumber;
    const supplier = suppliersByNumber.get(supplierNumber);
    if (supplierNumber === "") errors.push("Leverantörsnummer saknas");
    else if (!supplier) errors.push(`Leverantören ${supplierNumber} finns inte i leverantörsregistret`);

    const supplierArticleNumber = record["supplierArticleNumber"] ?? "";
    values["supplierArticleNumber"] = supplierArticleNumber;
    if (supplierArticleNumber.length > 100) errors.push("Leverantörens artikelnummer är för långt (max 100 tecken)");

    // Rabatt — a percentage off Monitor's gross price, baked into every price
    // on the row (the catalog has no discount column).
    const rawDiscount = record["discountPercent"] ?? "";
    values["discountPercent"] = rawDiscount;
    let discount = 0;
    if (rawDiscount !== "") {
      const parsed = normalizeDecimal(rawDiscount);
      if (parsed === null) errors.push(`Ogiltig rabatt: "${rawDiscount}"`);
      else if (parsed < 0 || parsed >= 100) errors.push("Rabatten måste vara mellan 0 och 100 procent");
      else discount = parsed;
    }

    const rawPrice = record["price"] ?? "";
    values["price"] = rawPrice;
    let price: number | null = null;
    if (rawPrice !== "") {
      const parsed = normalizeDecimal(rawPrice);
      if (parsed === null) errors.push(`Ogiltigt pris: "${rawPrice}"`);
      else if (parsed < 0) errors.push("Priset kan inte vara negativt");
      else price = discount > 0 ? netPrice(parsed, discount) : round4(parsed);
    }

    const rawPrimary = record["isPrimary"] ?? "";
    values["isPrimary"] = rawPrimary;
    let isPrimary: boolean | null = null;
    if (primaryMapped) {
      isPrimary = parseFlag(rawPrimary);
      if (isPrimary === null) errors.push(`Ogiltigt värde för Förvald: "${rawPrimary}" (Ja/Nej/1/0/true/false)`);
    }

    // Staffelsteg: Gränsvärde antal + the second price. ≤ 1 is the base price
    // by definition (article_supplier_price_breaks CHECK from_quantity > 1)
    // and is ignored with a warning rather than refused.
    const rawBreakQuantity = record["breakQuantity"] ?? "";
    const rawBreakPrice = record["breakPrice"] ?? "";
    values["breakQuantity"] = rawBreakQuantity;
    values["breakPrice"] = rawBreakPrice;
    let breakStep: SupplierPriceBreakPlan | null = null;
    if (rawBreakQuantity !== "") {
      const quantity = normalizeDecimal(rawBreakQuantity);
      if (quantity === null) {
        errors.push(`Ogiltigt gränsvärde: "${rawBreakQuantity}"`);
      } else if (quantity <= 1) {
        warnings.push(`Gränsvärde ${rawBreakQuantity} ignoreras (antal 1 är grundpriset)`);
      } else if (rawBreakPrice === "") {
        errors.push(`Staffelpris saknas för gränsvärdet ${rawBreakQuantity}`);
      } else {
        const gross = normalizeDecimal(rawBreakPrice);
        if (gross === null) errors.push(`Ogiltigt staffelpris: "${rawBreakPrice}"`);
        else if (gross < 0) errors.push("Staffelpriset kan inte vara negativt");
        else breakStep = { fromQuantity: quantity, price: discount > 0 ? netPrice(gross, discount) : round4(gross) };
      }
    }
    if (discount > 0 && (price !== null || breakStep !== null)) {
      warnings.push(`Rabatten ${rawDiscount} % är inbakad i priset`);
    }

    let action: ImportRowResult["action"] = "create";
    if (article && supplier && errors.length === 0) {
      const key = `${article.id}#${supplier.id}`;
      let group = groups.get(key);
      if (!group) {
        const existing = existingCatalog.get(article.id)?.get(supplier.id);
        if (existing && input.skipExisting) {
          rows.push(
            skippedRow(
              rowNumber,
              `Leverantören ${supplierNumber} finns redan i katalogen för artikel ${articleNumber}`,
              { ...record }
            )
          );
          // Remember the group so its break rows are skipped the same way.
          groups.set(key, {
            articleId: article.id,
            articleNumber,
            supplierId: supplier.id,
            existing,
            supplierArticleNumber: null,
            price: null,
            isPrimary: null,
            breaks: [],
            breakQuantities: new Set(),
            rowIndexes: [-1],
          });
          return;
        }
        group = {
          articleId: article.id,
          articleNumber,
          supplierId: supplier.id,
          existing,
          supplierArticleNumber: supplierArticleNumber === "" ? null : supplierArticleNumber,
          price,
          isPrimary,
          breaks: [],
          breakQuantities: new Set(),
          rowIndexes: [],
        };
        groups.set(key, group);
        if (isPrimary === true) {
          const already = primaryByArticle.get(article.id);
          if (already !== undefined && already !== supplierNumber) {
            errors.push(`Artikel ${articleNumber} har flera leverantörer markerade Förvald i filen`);
          } else {
            primaryByArticle.set(article.id, supplierNumber);
          }
        }
      } else if (group.rowIndexes[0] === -1) {
        // A break row of a skipped catalog row.
        rows.push(
          skippedRow(
            rowNumber,
            `Leverantören ${supplierNumber} finns redan i katalogen för artikel ${articleNumber}`,
            { ...record }
          )
        );
        return;
      }
      if (breakStep !== null) {
        if (group.breakQuantities.has(breakStep.fromQuantity)) {
          errors.push(`Gränsvärdet ${rawBreakQuantity} förekommer flera gånger för artikel ${articleNumber} och leverantör ${supplierNumber}`);
        } else {
          group.breakQuantities.add(breakStep.fromQuantity);
          group.breaks.push(breakStep);
        }
      }
      group.rowIndexes.push(index);
      action = group.existing ? "update" : "create";
    }

    rows.push({ rowNumber, action, errors, warnings, values });
  });

  const creates: SupplierPriceCreatePlan[] = [];
  const updates: SupplierPriceUpdatePlan[] = [];
  const primaryArticleIds = new Set<string>();
  const hasErrors = rows.some((row) => row.errors.length > 0);
  if (!hasErrors) {
    for (const group of groups.values()) {
      if (group.rowIndexes[0] === -1) continue;
      const breaks = [...group.breaks].sort((a, b) => a.fromQuantity - b.fromQuantity);
      if (group.isPrimary === true) primaryArticleIds.add(group.articleId);
      if (group.existing) {
        const patch: SupplierPriceUpdatePlan["patch"] = {};
        if (group.supplierArticleNumber !== null) patch.supplierArticleNumber = group.supplierArticleNumber;
        if (group.price !== null) patch.price = group.price;
        if (group.isPrimary !== null) patch.isPrimary = group.isPrimary;
        updates.push({ id: group.existing.id, articleId: group.articleId, patch, breaks });
      } else {
        creates.push({
          articleId: group.articleId,
          supplierId: group.supplierId,
          supplierArticleNumber: group.supplierArticleNumber,
          price: group.price,
          isPrimary: group.isPrimary ?? false,
          breaks,
        });
      }
    }
  }

  return {
    rows,
    summary: summarize(rows),
    willCreate: { units: [], articleGroups: [] },
    creates,
    updates,
    breaksMapped,
    primaryArticleIds: [...primaryArticleIds],
    hasErrors,
  };
}
