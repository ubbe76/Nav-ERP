// Customer price import (kundpriser — Monitor G5's "Prislista Försäljning"
// export). Sibling of supplier-prices.ts: the planner lives here, all
// database work in import.repository.ts.
//
// One row per (customer, article): Kund (the customer number), Pris and
// Rabatt. customer_prices stores EITHER a unit price OR a discount, so the
// import stores the net price Pris × (1 − Rabatt/100) and warns that the
// discount was baked in — the same rule as the supplier price import.
// Rows land as article rules at from_quantity 1 (Monitor's export carries no
// staffel); upsert by (customer, article), an update always clears
// discount_percent so the XOR check holds.
//
// Kundens artikelnummer (Kundens art.nr / art.nummer) lands in
// customer_article_numbers, upserted per (customer, article). Monitor's
// "Artikellista, Kundkopplingar" export lists EVERY article — those without a
// customer ("Kundkoppling saknas") are skipped, and a row may carry the
// customer's article number without a price.
import type { ImportCommitInput } from "@navet/shared";
import { normalizeDecimal } from "./csv.js";
import type { ExistingArticle } from "./articles.js";
import { netPrice } from "./supplier-prices.js";
import {
  resolveColumns,
  suggestMapping,
  skippedRow,
  summarize,
  type ImportRowResult,
  type ImportSummary,
} from "./import.service.js";

// Mappable target fields, in the order the wizard lists them.
export const CUSTOMER_PRICE_IMPORT_FIELDS = [
  "articleNumber",
  "customerNumber",
  "price",
  "discountPercent",
  "customerArticleNumber",
  // Ställpris — charged as a Ställkostnad row on new order rows.
  "setupPrice",
] as const;
export type CustomerPriceImportField = (typeof CUSTOMER_PRICE_IMPORT_FIELDS)[number];

// Pris is not a required COLUMN: a row may carry only Kundens artikelnummer.
// A row with neither is skipped (see the planner).
const REQUIRED_FIELDS: CustomerPriceImportField[] = ["articleNumber", "customerNumber"];

// customer_article_numbers.customer_article_number varchar(50).
const CUSTOMER_ARTICLE_NUMBER_MAX = 50;

// Normalized header -> target field. Namn, Prisdatum, Artikeltyp and
// Artikelkod have no target and stay unmapped.
export const CUSTOMER_PRICE_HEADER_ALIASES: Record<string, string> = {
  artikelnummer: "articleNumber",
  artikelnr: "articleNumber",
  artnr: "articleNumber",
  kund: "customerNumber",
  kundnummer: "customerNumber",
  kundnr: "customerNumber",
  pris: "price",
  forsaljningspris: "price",
  kundpris: "price",
  apris: "price",
  rabatt: "discountPercent",
  rabattprocent: "discountPercent",
  // "Kundens art.nr" (Kundkopplingar) / "Kundens art.nummer" (Prislista
  // Försäljning).
  kundensartnr: "customerArticleNumber",
  kundensartnummer: "customerArticleNumber",
  kundensartikelnummer: "customerArticleNumber",
  kundartikelnummer: "customerArticleNumber",
  stallpris: "setupPrice",
  stallkostnad: "setupPrice",
};

export function suggestCustomerPriceMapping(headers: string[]): Record<string, string | null> {
  return suggestMapping(headers, CUSTOMER_PRICE_HEADER_ALIASES);
}

// Narrow lookups the planner runs against — implemented structurally by
// createImportRepository, stubbed with Maps in tests.
export interface CustomerPriceImportDeps {
  articlesByNumber(numbers: string[]): Promise<Map<string, ExistingArticle>>;
  customersByNumber(numbers: string[]): Promise<Map<string, { id: string }>>;
  /** "<customerId>#<articleId>" -> the existing article rule at from_quantity 1. */
  customerArticlePrices(customerIds: string[]): Promise<Map<string, { id: string }>>;
  /** "<customerId>#<articleId>" -> the stored Kundens artikelnummer. */
  customerArticleNumbers(customerIds: string[]): Promise<Map<string, string>>;
}

export interface CustomerPriceCreatePlan {
  customerId: string;
  articleId: string;
  unitPrice: number;
  /** Ställpris; omitted/null = none. */
  setupPrice?: number | null;
}

export interface CustomerPriceUpdatePlan {
  id: string;
  unitPrice: number;
  /** Set only from a filled cell (0 clears); omitted = untouched. */
  setupPrice?: number | null;
}

/** Upserted on (customer, article) — only staged when the number changes. */
export interface CustomerArticleNumberPlan {
  customerId: string;
  articleId: string;
  customerArticleNumber: string;
}

export interface CustomerPriceImportPlan {
  rows: ImportRowResult[];
  summary: ImportSummary;
  // Always empty — this import creates nothing in any register.
  willCreate: { units: string[]; articleGroups: string[] };
  creates: CustomerPriceCreatePlan[];
  updates: CustomerPriceUpdatePlan[];
  /** Optional so hand-built plans in tests need not carry it. */
  articleNumbers?: CustomerArticleNumberPlan[];
  hasErrors: boolean;
}

// The SAME builder runs for preview and commit — commit never trusts the
// preview round-trip and re-plans from scratch.
export async function planCustomerPriceImport(
  input: ImportCommitInput,
  deps: CustomerPriceImportDeps
): Promise<CustomerPriceImportPlan> {
  const columns = resolveColumns(input.mapping, [...CUSTOMER_PRICE_IMPORT_FIELDS], REQUIRED_FIELDS);

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
  const customersByNumber = await deps.customersByNumber(
    records.map((r) => r["customerNumber"] ?? "").filter((n) => n !== "")
  );
  const customerIds = [...customersByNumber.values()].map((c) => c.id);
  const existing = await deps.customerArticlePrices(customerIds);
  const existingNumbers = columns.includes("customerArticleNumber")
    ? await deps.customerArticleNumbers(customerIds)
    : new Map<string, string>();

  const rows: ImportRowResult[] = [];
  const creates: CustomerPriceCreatePlan[] = [];
  const updates: CustomerPriceUpdatePlan[] = [];
  const articleNumbers: CustomerArticleNumberPlan[] = [];
  const seen = new Set<string>();

  records.forEach((record, index) => {
    const rowNumber = index + 2;
    const errors: string[] = [];
    const warnings: string[] = [];
    const values: Record<string, unknown> = {};

    const articleNumber = record["articleNumber"] ?? "";
    const customerNumber = record["customerNumber"] ?? "";
    const rawPrice = record["price"] ?? "";
    const rawCustomerArticleNumber = record["customerArticleNumber"] ?? "";

    // Nothing to import on this row: Kundkopplingar lists every article, and
    // one without a customer link ("Kundkoppling saknas") or with neither a
    // price nor the customer's number is skipped, never a row error.
    if (customerNumber === "" && rawPrice === "" && rawCustomerArticleNumber === "") {
      rows.push(skippedRow(rowNumber, "Ingen kundkoppling på raden", { ...record }));
      return;
    }
    if (customerNumber !== "" && rawPrice === "" && rawCustomerArticleNumber === "") {
      rows.push(skippedRow(rowNumber, "Varken pris eller kundens artikelnummer på raden", { ...record }));
      return;
    }

    values["articleNumber"] = articleNumber;
    const article = articlesByNumber.get(articleNumber);
    if (articleNumber === "") errors.push("Artikelnummer saknas");
    else if (!article) errors.push(`Artikeln ${articleNumber} finns inte i artikelregistret`);

    values["customerNumber"] = customerNumber;
    const customer = customersByNumber.get(customerNumber);
    if (customerNumber === "") errors.push("Kundnummer saknas");
    else if (!customer) errors.push(`Kunden ${customerNumber} finns inte i kundregistret`);

    const rawDiscount = record["discountPercent"] ?? "";
    values["discountPercent"] = rawDiscount;
    let discount = 0;
    if (rawDiscount !== "") {
      const parsed = normalizeDecimal(rawDiscount);
      if (parsed === null) errors.push(`Ogiltig rabatt: "${rawDiscount}"`);
      else if (parsed < 0 || parsed >= 100) errors.push("Rabatten måste vara mellan 0 och 100 procent");
      else discount = parsed;
    }

    values["price"] = rawPrice;
    let unitPrice: number | null = null;
    if (rawPrice !== "") {
      const parsed = normalizeDecimal(rawPrice);
      if (parsed === null) errors.push(`Ogiltigt pris: "${rawPrice}"`);
      else if (parsed < 0) errors.push("Priset kan inte vara negativt");
      else {
        unitPrice = discount > 0 ? netPrice(parsed, discount) : Math.round(parsed * 10000) / 10000;
        values["unitPrice"] = unitPrice;
        if (discount > 0) warnings.push(`Rabatten ${rawDiscount} % är inbakad i priset`);
      }
    } else if (rawDiscount !== "" && discount > 0) {
      warnings.push("Rabatten hoppas över — raden saknar pris");
    }

    // Ställpris rides on the price rule, so it needs the row's price; 0 is
    // Monitor's "none".
    const rawSetupPrice = record["setupPrice"] ?? "";
    let setupPrice: number | null | undefined;
    if (rawSetupPrice !== "") {
      values["setupPrice"] = rawSetupPrice;
      const parsed = normalizeDecimal(rawSetupPrice);
      if (parsed === null) errors.push(`Ogiltigt ställpris: "${rawSetupPrice}"`);
      else if (parsed < 0) errors.push("Ställpriset kan inte vara negativt");
      else if (rawPrice === "") {
        if (parsed > 0) warnings.push("Ställpriset hoppas över — raden saknar pris");
      } else setupPrice = parsed === 0 ? null : Math.round(parsed * 10000) / 10000;
    }

    let customerArticleNumber: string | null = null;
    if (rawCustomerArticleNumber !== "") {
      values["customerArticleNumber"] = rawCustomerArticleNumber;
      if (rawCustomerArticleNumber.length > CUSTOMER_ARTICLE_NUMBER_MAX) {
        errors.push(
          `Kundens artikelnummer är för långt (${rawCustomerArticleNumber.length} tecken, max ${CUSTOMER_ARTICLE_NUMBER_MAX})`
        );
      } else {
        customerArticleNumber = rawCustomerArticleNumber;
      }
    }

    if (article && customer) {
      const key = `${customer.id}#${article.id}`;
      if (seen.has(key)) errors.push(`Kundpriset för ${customerNumber} / ${articleNumber} förekommer flera gånger i filen`);
      seen.add(key);
    }

    if (errors.length > 0 || !article || !customer) {
      rows.push({ rowNumber, action: "create", errors, warnings, values });
      return;
    }

    const key = `${customer.id}#${article.id}`;
    const current = unitPrice !== null ? existing.get(key) : undefined;
    const currentNumber = customerArticleNumber !== null ? existingNumbers.get(key) : undefined;
    if (input.skipExisting && (current || currentNumber !== undefined)) {
      rows.push(
        skippedRow(rowNumber, `Kunden ${customerNumber} har redan en koppling till artikel ${articleNumber}`, { ...record })
      );
      return;
    }

    rows.push({ rowNumber, action: current || currentNumber !== undefined ? "update" : "create", errors, warnings, values });
    if (unitPrice !== null) {
      const setup = setupPrice !== undefined ? { setupPrice } : {};
      if (current) updates.push({ id: current.id, unitPrice, ...setup });
      else creates.push({ customerId: customer.id, articleId: article.id, unitPrice, ...setup });
    }
    // Re-importing an unchanged file stages no write.
    if (customerArticleNumber !== null && customerArticleNumber !== currentNumber) {
      articleNumbers.push({ customerId: customer.id, articleId: article.id, customerArticleNumber });
    }
  });

  return {
    rows,
    summary: summarize(rows),
    willCreate: { units: [], articleGroups: [] },
    creates,
    updates,
    articleNumbers,
    hasErrors: rows.some((row) => row.errors.length > 0),
  };
}
