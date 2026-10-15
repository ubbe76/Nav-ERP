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
// discount_percent so the XOR check holds. "Kundens art.nummer" has no field
// in Nav and stays unmapped.
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
export const CUSTOMER_PRICE_IMPORT_FIELDS = ["articleNumber", "customerNumber", "price", "discountPercent"] as const;
export type CustomerPriceImportField = (typeof CUSTOMER_PRICE_IMPORT_FIELDS)[number];

const REQUIRED_FIELDS: CustomerPriceImportField[] = ["articleNumber", "customerNumber", "price"];

// Normalized header -> target field. Namn, Ställpris, Prisdatum, Artikeltyp,
// Artikelkod and Kundens art.nummer have no target and stay unmapped.
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
}

export interface CustomerPriceCreatePlan {
  customerId: string;
  articleId: string;
  unitPrice: number;
}

export interface CustomerPriceUpdatePlan {
  id: string;
  unitPrice: number;
}

export interface CustomerPriceImportPlan {
  rows: ImportRowResult[];
  summary: ImportSummary;
  // Always empty — this import creates nothing in any register.
  willCreate: { units: string[]; articleGroups: string[] };
  creates: CustomerPriceCreatePlan[];
  updates: CustomerPriceUpdatePlan[];
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
  const existing = await deps.customerArticlePrices([...customersByNumber.values()].map((c) => c.id));

  const rows: ImportRowResult[] = [];
  const creates: CustomerPriceCreatePlan[] = [];
  const updates: CustomerPriceUpdatePlan[] = [];
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

    const customerNumber = record["customerNumber"] ?? "";
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

    const rawPrice = record["price"] ?? "";
    values["price"] = rawPrice;
    let unitPrice: number | null = null;
    if (rawPrice === "") {
      errors.push("Pris saknas");
    } else {
      const parsed = normalizeDecimal(rawPrice);
      if (parsed === null) errors.push(`Ogiltigt pris: "${rawPrice}"`);
      else if (parsed < 0) errors.push("Priset kan inte vara negativt");
      else {
        unitPrice = discount > 0 ? netPrice(parsed, discount) : Math.round(parsed * 10000) / 10000;
        values["unitPrice"] = unitPrice;
        if (discount > 0) warnings.push(`Rabatten ${rawDiscount} % är inbakad i priset`);
      }
    }

    if (article && customer) {
      const key = `${customer.id}#${article.id}`;
      if (seen.has(key)) errors.push(`Kundpriset för ${customerNumber} / ${articleNumber} förekommer flera gånger i filen`);
      seen.add(key);
    }

    if (errors.length > 0 || !article || !customer || unitPrice === null) {
      rows.push({ rowNumber, action: "create", errors, warnings, values });
      return;
    }

    const current = existing.get(`${customer.id}#${article.id}`);
    if (current && input.skipExisting) {
      rows.push(
        skippedRow(rowNumber, `Kunden ${customerNumber} har redan ett pris på artikel ${articleNumber}`, { ...record })
      );
      return;
    }
    if (current) {
      rows.push({ rowNumber, action: "update", errors, warnings, values });
      updates.push({ id: current.id, unitPrice });
    } else {
      rows.push({ rowNumber, action: "create", errors, warnings, values });
      creates.push({ customerId: customer.id, articleId: article.id, unitPrice });
    }
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
