import { and, desc, eq, sql } from "drizzle-orm";
import { articles, customerPrices, customers, priceListRows, type Db, type Tx } from "@navet/db";
import type { PriceSource } from "@navet/shared";

export type ResolvedPrice = { unitPrice: number; discountPercent: number; source: PriceSource };
export type PriceResolution = { articleNumber: string; price: ResolvedPrice | null } | null; // null = unknown article

// Konfigurator 4a (beslut C): the variant step. `undefined` = the article is
// not a variant; `null` = it is, but the engine could not price it (the stored
// selection no longer validates, the template has no base price) — both fall
// through to the article's own chain. Injected from app.ts; the configurator's
// own price binding has no reader, which ends the recursion (a template is
// never a variant).
export type VariantPriceReader = (q: { customerId: string; variantArticleId: string; quantity: number }) => Promise<ResolvedPrice | null | undefined>;

// C3 price chain (most specific wins): customer article price → customer
// group rule → customer's price list → the article's base price. Each level
// picks the highest from_quantity <= quantity. A discount-form rule needs an
// underlying list/base price — without one the result is null, never 0.
// The customer's blanket discount (customers.discount_percent, Monitor's
// "Rabatt" on the customer card) is the last fallback: it applies on the
// list/base price only when no customer-specific rule matched.
// A variant without agreements of its own (article rule, price list row)
// takes the template's chain plus the configuration's additions instead —
// see VariantPriceReader.
export async function resolvePrice(
  dbc: Db | Tx,
  { customerId, articleId, quantity }: { customerId: string; articleId: string; quantity: number },
  opts: { variantPrice?: VariantPriceReader } = {}
): Promise<PriceResolution> {
  const [article] = await dbc
    .select({ articleNumber: articles.articleNumber, salesPrice: articles.salesPrice, groupId: articles.groupId })
    .from(articles)
    .where(eq(articles.id, articleId));
  if (!article) return null;
  const none = { articleNumber: article.articleNumber, price: null };

  const [customer] = await dbc
    .select({ priceListId: customers.priceListId, discountPercent: customers.discountPercent })
    .from(customers)
    .where(eq(customers.id, customerId));

  // Chain levels 3-4 first — they are the base a discount-form rule needs.
  let listPrice: number | null = null;
  if (customer?.priceListId) {
    const [row] = await dbc
      .select({ unitPrice: priceListRows.unitPrice })
      .from(priceListRows)
      .where(
        and(
          eq(priceListRows.priceListId, customer.priceListId),
          eq(priceListRows.articleId, articleId),
          sql`${priceListRows.fromQuantity} <= ${quantity}`
        )
      )
      .orderBy(desc(priceListRows.fromQuantity))
      .limit(1);
    listPrice = row ? Number(row.unitPrice) : null;
  }
  const basePrice = listPrice ?? (article.salesPrice !== null ? Number(article.salesPrice) : null);
  const baseSource: PriceSource = listPrice !== null ? "price_list" : "article";

  const ruleFor = async (where: ReturnType<typeof and>) => {
    const [rule] = await dbc
      .select({ unitPrice: customerPrices.unitPrice, discountPercent: customerPrices.discountPercent })
      .from(customerPrices)
      .where(where)
      .orderBy(desc(customerPrices.fromQuantity))
      .limit(1);
    return rule;
  };
  const articleRule = await ruleFor(
    and(eq(customerPrices.customerId, customerId), eq(customerPrices.articleId, articleId), sql`${customerPrices.fromQuantity} <= ${quantity}`)
  );

  // Variant step: only when the variant has no agreement of its own.
  if (!articleRule && listPrice === null && opts.variantPrice) {
    const viaTemplate = await opts.variantPrice({ customerId, variantArticleId: articleId, quantity });
    if (viaTemplate) return { articleNumber: article.articleNumber, price: viaTemplate };
  }

  // Levels 1-2: article rule, then group rule (only looked up when no
  // article rule matched). A matching rule WINS the chain even when its
  // discount form cannot produce a price (spec: no silent fall-through past
  // a matching customer agreement).
  const groupRule = !articleRule && article.groupId
    ? await ruleFor(
        and(eq(customerPrices.customerId, customerId), eq(customerPrices.articleGroupId, article.groupId), sql`${customerPrices.fromQuantity} <= ${quantity}`)
      )
    : undefined;
  const matched: [typeof articleRule, PriceSource][] = [[articleRule, "customer_article"], [groupRule, "customer_group"]];
  for (const [rule, source] of matched) {
    if (!rule) continue;
    if (rule.unitPrice !== null) {
      return { articleNumber: article.articleNumber, price: { unitPrice: Number(rule.unitPrice), discountPercent: 0, source } };
    }
    if (basePrice === null) return none;
    return { articleNumber: article.articleNumber, price: { unitPrice: basePrice, discountPercent: Number(rule.discountPercent), source } };
  }

  if (basePrice === null) return none;
  const customerDiscount = customer ? Number(customer.discountPercent) : 0;
  if (customerDiscount > 0) {
    return { articleNumber: article.articleNumber, price: { unitPrice: basePrice, discountPercent: customerDiscount, source: "customer_discount" } };
  }
  return { articleNumber: article.articleNumber, price: { unitPrice: basePrice, discountPercent: 0, source: baseSource } };
}
