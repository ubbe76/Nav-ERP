// Customer price import (kundpriser — Monitor G5's "Prislista Försäljning"
// export). Sibling of supplier-prices.ts: the planner lives here, all
// database work in import.repository.ts.
//
// Kund (the customer number), Pris and Rabatt per (customer, article).
// customer_prices stores EITHER a unit price OR a discount, so the import
// stores the net price Pris × (1 − Rabatt/100) and warns that the discount
// was baked in — the same rule as the supplier price import. The price lands
// as the article rule at from_quantity 1; upsert by (customer, article), an
// update always clears discount_percent so the XOR check holds.
//
// TWO price files feed this entity, like the supplier side:
//   - "Prislista Försäljning, Lista": one row per (customer, article); the
//     same pair twice is a row error.
//   - "Prislista Försäljning, Stafflade": a row per staffelsteg carrying
//     "Gränsvärde antal" and "Pris (staffling)", the base Pris repeated on
//     every row. Rows are grouped by (customer, article); each step becomes
//     an article rule at from_quantity = Gränsvärde (the price chain picks
//     the highest from_quantity <= the order quantity). A Gränsvärde ≤ 1 IS
//     the price at antal 1 and wins over Pris. Pris 0 on a pair with steps
//     means "no own price below the first step" (user decision 2026-11-02):
//     no rule at antal 1, an existing one is deleted, and the chain falls
//     through to the price list / the article's base price. When the step
//     column is mapped, a pair's steps are replaced as a whole set (no step
//     rows = no staffel), like replacePriceBreaks on the supplier side.
//   Ställpris belongs to the agreement, not to a step: the resolver reads
//   the MATCHED rule's setup_price, so every step carries it too.
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
import { round4 } from "@navet/shared";

// Mappable target fields, in the order the wizard lists them.
export const CUSTOMER_PRICE_IMPORT_FIELDS = [
  "articleNumber",
  "customerNumber",
  "price",
  "discountPercent",
  "customerArticleNumber",
  // Ställpris — charged as a Ställkostnad row on new order rows.
  "setupPrice",
  "breakQuantity",
  "breakPrice",
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
  // "Gränsvärde antal" / "Pris (staffling)" (Stafflade) and the template's
  // "Staffel: från antal" / "Staffel: pris".
  gransvardeantal: "breakQuantity",
  gransvarde: "breakQuantity",
  franantal: "breakQuantity",
  staffelfranantal: "breakQuantity",
  staffelantal: "breakQuantity",
  prisstaffling: "breakPrice",
  staffling: "breakPrice",
  staffelpris: "breakPrice",
  stafflatpris: "breakPrice",
};

// Second chance for a heading that LOST the alias contest: a file whose step
// price is a second "Pris" column (parse() renames it "Pris (2)"), like the
// supplier side's stafflat file.
export const CUSTOMER_PRICE_SECONDARY_HEADER_ALIASES: Record<string, string> = {
  pris: "breakPrice",
};

export function suggestCustomerPriceMapping(headers: string[]): Record<string, string | null> {
  return suggestMapping(headers, CUSTOMER_PRICE_HEADER_ALIASES, CUSTOMER_PRICE_SECONDARY_HEADER_ALIASES);
}

// Narrow lookups the planner runs against — implemented structurally by
// createImportRepository, stubbed with Maps in tests.
export interface CustomerPriceImportDeps {
  articlesByNumber(numbers: string[]): Promise<Map<string, ExistingArticle>>;
  customersByNumber(numbers: string[]): Promise<Map<string, { id: string }>>;
  /** "<customerId>#<articleId>" -> the existing article rule at from_quantity 1. */
  customerArticlePrices(customerIds: string[]): Promise<Map<string, { id: string; setupPrice?: number | null }>>;
  /**
   * "<customerId>#<articleId>" -> from_quantity -> the existing article rules
   * ABOVE antal 1 (the staffelsteg). Only asked when the step column is mapped.
   */
  customerArticlePriceBreaks(customerIds: string[]): Promise<Map<string, Map<number, { id: string }>>>;
  /** "<customerId>#<articleId>" -> the stored Kundens artikelnummer. */
  customerArticleNumbers(customerIds: string[]): Promise<Map<string, string>>;
}

export interface CustomerPriceCreatePlan {
  customerId: string;
  articleId: string;
  /** Staffelsteg; omitted = antal 1. */
  fromQuantity?: number;
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
  /**
   * customer_prices ids to delete — steps no longer in the file, and the
   * antal-1 rule of a pair whose Pris 0 means "no own price below the first
   * step". Optional so hand-built plans in tests need not carry it.
   */
  deletes?: string[];
  /** Optional so hand-built plans in tests need not carry it. */
  articleNumbers?: CustomerArticleNumberPlan[];
  hasErrors: boolean;
}

interface Group {
  customerId: string;
  articleId: string;
  existingBase: { id: string; setupPrice?: number | null } | undefined;
  existingBreaks: Map<number, { id: string }>;
  existingNumber: string | undefined;
  skipReason: string | null;
  /** The first row's net Pris; null = empty cell (leave the antal-1 rule alone). */
  price: number | null;
  /** Filled Ställpris cell (0 ⇒ null); undefined = empty cell. */
  setupPrice: number | null | undefined;
  /** Whether the Ställpris applies at all — some row carries a price or a step. */
  priced: boolean;
  customerArticleNumber: string | null;
  /** A step at Gränsvärde ≤ 1 — the price at antal 1. */
  baseStep: { price: number; row: ImportRowResult } | null;
  steps: Map<number, number>;
  plainRows: number;
  firstRow: ImportRowResult;
}

function formatNumber(n: number): string {
  return String(n).replace(".", ",");
}

// The SAME builder runs for preview and commit — commit never trusts the
// preview round-trip and re-plans from scratch.
export async function planCustomerPriceImport(
  input: ImportCommitInput,
  deps: CustomerPriceImportDeps
): Promise<CustomerPriceImportPlan> {
  const columns = resolveColumns(input.mapping, [...CUSTOMER_PRICE_IMPORT_FIELDS], REQUIRED_FIELDS);
  const breaksMapped = columns.includes("breakQuantity");

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
  const existingBreaks = breaksMapped
    ? await deps.customerArticlePriceBreaks(customerIds)
    : new Map<string, Map<number, { id: string }>>();
  const existingNumbers = columns.includes("customerArticleNumber")
    ? await deps.customerArticleNumbers(customerIds)
    : new Map<string, string>();

  const rows: ImportRowResult[] = [];
  const groups = new Map<string, Group>();

  records.forEach((record, index) => {
    const rowNumber = index + 2;
    const errors: string[] = [];
    const warnings: string[] = [];
    const values: Record<string, unknown> = {};

    const articleNumber = record["articleNumber"] ?? "";
    const customerNumber = record["customerNumber"] ?? "";
    const rawPrice = record["price"] ?? "";
    const rawCustomerArticleNumber = record["customerArticleNumber"] ?? "";
    const rawBreakQuantity = record["breakQuantity"] ?? "";
    const rawBreakPrice = record["breakPrice"] ?? "";

    // Nothing to import on this row: Kundkopplingar lists every article, and
    // one without a customer link ("Kundkoppling saknas") or with neither a
    // price nor the customer's number is skipped, never a row error.
    if (customerNumber === "" && rawPrice === "" && rawCustomerArticleNumber === "" && rawBreakQuantity === "") {
      rows.push(skippedRow(rowNumber, "Ingen kundkoppling på raden", { ...record }));
      return;
    }
    if (customerNumber !== "" && rawPrice === "" && rawCustomerArticleNumber === "" && rawBreakQuantity === "") {
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

    // Rabatt — a percentage off Monitor's gross price, baked into every price
    // on the row, the step price included.
    const rawDiscount = record["discountPercent"] ?? "";
    values["discountPercent"] = rawDiscount;
    let discount = 0;
    if (rawDiscount !== "") {
      const parsed = normalizeDecimal(rawDiscount);
      if (parsed === null) errors.push(`Ogiltig rabatt: "${rawDiscount}"`);
      else if (parsed < 0 || parsed >= 100) errors.push("Rabatten måste vara mellan 0 och 100 procent");
      else discount = parsed;
    }
    const net = (gross: number) => (discount > 0 ? netPrice(gross, discount) : round4(gross));

    values["price"] = rawPrice;
    let unitPrice: number | null = null;
    if (rawPrice !== "") {
      const parsed = normalizeDecimal(rawPrice);
      if (parsed === null) errors.push(`Ogiltigt pris: "${rawPrice}"`);
      else if (parsed < 0) errors.push("Priset kan inte vara negativt");
      else {
        unitPrice = net(parsed);
        values["unitPrice"] = unitPrice;
      }
    }

    // Staffelsteg: Gränsvärde antal + the step price. ≤ 1 is the price at
    // antal 1 itself.
    let step: { fromQuantity: number; price: number } | null = null;
    if (rawBreakQuantity !== "") {
      values["breakQuantity"] = rawBreakQuantity;
      values["breakPrice"] = rawBreakPrice;
      const quantity = normalizeDecimal(rawBreakQuantity);
      if (quantity === null || quantity < 0) {
        errors.push(`Ogiltigt gränsvärde: "${rawBreakQuantity}"`);
      } else if (rawBreakPrice === "") {
        errors.push(`Staffelpris saknas för gränsvärdet ${rawBreakQuantity}`);
      } else {
        const gross = normalizeDecimal(rawBreakPrice);
        if (gross === null) errors.push(`Ogiltigt staffelpris: "${rawBreakPrice}"`);
        else if (gross < 0) errors.push("Staffelpriset kan inte vara negativt");
        else step = { fromQuantity: quantity <= 1 ? 1 : round4(quantity), price: net(gross) };
      }
    }

    if (discount > 0 && (unitPrice !== null || step !== null)) {
      warnings.push(`Rabatten ${rawDiscount} % är inbakad i priset`);
    } else if (discount > 0 && rawPrice === "" && rawBreakQuantity === "") {
      warnings.push("Rabatten hoppas över — raden saknar pris");
    }

    // Ställpris rides on the price rules, so it needs a price or a step on
    // the row; 0 is Monitor's "none".
    const rawSetupPrice = record["setupPrice"] ?? "";
    let setupPrice: number | null | undefined;
    if (rawSetupPrice !== "") {
      values["setupPrice"] = rawSetupPrice;
      const parsed = normalizeDecimal(rawSetupPrice);
      if (parsed === null) errors.push(`Ogiltigt ställpris: "${rawSetupPrice}"`);
      else if (parsed < 0) errors.push("Ställpriset kan inte vara negativt");
      else if (rawPrice === "" && rawBreakQuantity === "") {
        if (parsed > 0) warnings.push("Ställpriset hoppas över — raden saknar pris");
      } else setupPrice = parsed === 0 ? null : round4(parsed);
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

    // A row with an error contributes nothing to its pair (the commit refuses
    // the whole file anyway, but the preview's plan stays honest).
    const row: ImportRowResult = { rowNumber, action: "create", errors, warnings, values };
    if (!article || !customer || errors.length > 0) {
      rows.push(row);
      return;
    }

    const key = `${customer.id}#${article.id}`;
    const priced = unitPrice !== null || rawBreakQuantity !== "";
    let group = groups.get(key);
    if (!group) {
      const existingBase = existing.get(key);
      const breaks = existingBreaks.get(key) ?? new Map<number, { id: string }>();
      const existingNumber = existingNumbers.get(key);
      const priceExists = priced && (existingBase !== undefined || breaks.size > 0);
      const numberExists = customerArticleNumber !== null && existingNumber !== undefined;
      group = {
        customerId: customer.id,
        articleId: article.id,
        existingBase,
        existingBreaks: breaks,
        existingNumber,
        skipReason:
          input.skipExisting && (priceExists || numberExists)
            ? `Kunden ${customerNumber} har redan en koppling till artikel ${articleNumber}`
            : null,
        price: null,
        setupPrice: undefined,
        priced: false,
        customerArticleNumber: null,
        baseStep: null,
        steps: new Map(),
        plainRows: 0,
        firstRow: row,
      };
      groups.set(key, group);
    } else if (!breaksMapped) {
      errors.push(`Kundpriset för ${customerNumber} / ${articleNumber} förekommer flera gånger i filen`);
    }

    // skipExisting covers the whole pair — its step rows too.
    if (group.skipReason !== null) {
      rows.push(skippedRow(rowNumber, group.skipReason, { ...record }));
      return;
    }

    if (step === null) {
      if (breaksMapped && group.plainRows > 0) {
        errors.push(`Kundpriset för ${customerNumber} / ${articleNumber} förekommer flera gånger i filen`);
      }
    } else if (step.fromQuantity === 1 ? group.baseStep !== null : group.steps.has(step.fromQuantity)) {
      errors.push(`Gränsvärdet ${rawBreakQuantity} förekommer flera gånger för kund ${customerNumber} och artikel ${articleNumber}`);
    }
    if (errors.length > 0) {
      rows.push(row);
      return;
    }
    if (step === null) group.plainRows++;
    else if (step.fromQuantity === 1) group.baseStep = { price: step.price, row };
    else group.steps.set(step.fromQuantity, step.price);

    // The pair's own fields come from its first row that carries them.
    if (group.price === null && unitPrice !== null) group.price = unitPrice;
    if (group.setupPrice === undefined && setupPrice !== undefined) group.setupPrice = setupPrice;
    if (group.customerArticleNumber === null && customerArticleNumber !== null) {
      group.customerArticleNumber = customerArticleNumber;
    }
    if (priced) group.priced = true;

    const priceExists = priced && (group.existingBase !== undefined || group.existingBreaks.size > 0);
    const numberExists = customerArticleNumber !== null && group.existingNumber !== undefined;
    row.action = priceExists || numberExists ? "update" : "create";
    rows.push(row);
  });

  const creates: CustomerPriceCreatePlan[] = [];
  const updates: CustomerPriceUpdatePlan[] = [];
  const deletes: string[] = [];
  const articleNumbers: CustomerArticleNumberPlan[] = [];

  for (const group of groups.values()) {
    if (group.skipReason !== null) continue;
    const setup = group.setupPrice !== undefined ? { setupPrice: group.setupPrice } : {};

    // The price at antal 1: a step at Gränsvärde ≤ 1 wins over Pris; Pris 0
    // on a pair with steps is "no own price below the first step"; an empty
    // Pris leaves a stored rule alone.
    let base: number | null = null;
    let removeBase = false;
    if (group.baseStep !== null) {
      base = group.baseStep.price;
      if (group.price !== null && group.price > 0 && group.price !== base) {
        group.baseStep.row.warnings.push(
          `Staffelpriset ${formatNumber(base)} vid antal 1 gäller i stället för Pris ${formatNumber(group.price)}`
        );
      }
    } else if (group.price === 0 && group.steps.size > 0) {
      removeBase = true;
      group.firstRow.warnings.push(
        group.existingBase
          ? "Pris 0 med staffel betyder inget eget pris under första steget — kundpriset från antal 1 tas bort"
          : "Pris 0 med staffel betyder inget eget pris under första steget"
      );
    } else {
      base = group.price;
    }

    if (base !== null) {
      if (group.existingBase) updates.push({ id: group.existingBase.id, unitPrice: base, ...setup });
      else creates.push({ customerId: group.customerId, articleId: group.articleId, unitPrice: base, ...setup });
    } else if (removeBase && group.existingBase) {
      deletes.push(group.existingBase.id);
    }

    // The steps replace the pair's stored steps as a whole set — only when
    // the step column is mapped. Each step carries the agreement's ställpris:
    // the filled cell, else the stored antal-1 rule's.
    if (breaksMapped && group.priced) {
      const stepSetup =
        group.setupPrice !== undefined ? group.setupPrice : (group.existingBase?.setupPrice ?? null);
      for (const [fromQuantity, unitPrice] of [...group.steps].sort((a, b) => a[0] - b[0])) {
        const stored = group.existingBreaks.get(fromQuantity);
        if (stored) updates.push({ id: stored.id, unitPrice, ...setup });
        else {
          creates.push({
            customerId: group.customerId,
            articleId: group.articleId,
            fromQuantity,
            unitPrice,
            ...(stepSetup !== null ? { setupPrice: stepSetup } : {}),
          });
        }
      }
      for (const [fromQuantity, stored] of group.existingBreaks) {
        if (!group.steps.has(fromQuantity)) deletes.push(stored.id);
      }
    }

    // Re-importing an unchanged file stages no write.
    if (group.customerArticleNumber !== null && group.customerArticleNumber !== group.existingNumber) {
      articleNumbers.push({
        customerId: group.customerId,
        articleId: group.articleId,
        customerArticleNumber: group.customerArticleNumber,
      });
    }
  }

  return {
    rows,
    summary: summarize(rows),
    willCreate: { units: [], articleGroups: [] },
    creates,
    updates,
    deletes,
    articleNumbers,
    hasErrors: rows.some((row) => row.errors.length > 0),
  };
}
