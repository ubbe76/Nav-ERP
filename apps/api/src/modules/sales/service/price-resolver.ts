import { and, desc, eq, sql } from "drizzle-orm";
import { articles, customerPrices, customers, priceListRows, priceLists, type Db, type Tx } from "@navet/db";
import { fromSek, SEK, type PriceSource } from "@navet/shared";

export type ResolvedPrice = { unitPrice: number; discountPercent: number; source: PriceSource };
export type PriceResolution = { articleNumber: string; price: ResolvedPrice | null } | null; // null = unknown article

// Konfigurator 4a (beslut C): the variant step. `undefined` = the article is
// not a variant; `null` = it is, but the engine could not price it (the stored
// selection no longer validates, the template has no base price) — both fall
// through to the article's own chain. Injected from app.ts; the configurator's
// own price binding has no reader, which ends the recursion (a template is
// never a variant).
export type VariantPriceReader = (q: {
  customerId: string;
  variantArticleId: string;
  quantity: number;
  // Valuta: the order's currency and rate — the template's chain runs in the
  // same currency and the configuration's SEK additions are converted.
  currency?: string;
  exchangeRate?: number;
}) => Promise<ResolvedPrice | null | undefined>;

// Valuta: what the chain prices in. Omitted = SEK at rate 1 — exactly the
// chain before the feature.
export type PriceCurrency = { currency?: string; exchangeRate?: number };

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
//
// Valuta: the chain prices in the ORDER's currency. The customer's own rules
// (customer_prices — särpriser in the customer's currency) only apply when
// the order is in the customer's currency; the customer's price list only
// when the list is in the order's currency (a list in another currency is
// skipped); the article's försäljningspris (SEK) is converted with the
// order's rate, to the öre (fromSek). The blanket customer discount is a
// percentage and applies either way. A SEK order (the default) is priced
// exactly as before — the SEK base price is never rounded.
export async function resolvePrice(
  dbc: Db | Tx,
  {
    customerId,
    articleId,
    quantity,
    currency: currencyInput,
    exchangeRate,
  }: { customerId: string; articleId: string; quantity: number } & PriceCurrency,
  opts: { variantPrice?: VariantPriceReader } = {}
): Promise<PriceResolution> {
  const currency = currencyInput ?? SEK;
  const rate = currency === SEK ? 1 : exchangeRate;
  if (rate === undefined || !(rate > 0)) throw new Error(`Pricing in ${currency} needs the order's exchange rate`);
  const [article] = await dbc
    .select({ articleNumber: articles.articleNumber, salesPrice: articles.salesPrice, groupId: articles.groupId })
    .from(articles)
    .where(eq(articles.id, articleId));
  if (!article) return null;
  const none = { articleNumber: article.articleNumber, price: null };

  const [customer] = await dbc
    .select({
      priceListId: customers.priceListId,
      discountPercent: customers.discountPercent,
      currency: customers.currency,
      priceListCurrency: priceLists.currency,
    })
    .from(customers)
    .leftJoin(priceLists, eq(priceLists.id, customers.priceListId))
    .where(eq(customers.id, customerId));
  // Valuta: the customer's särpriser are in the customer's currency.
  const customerRulesApply = (customer?.currency ?? SEK) === currency;

  // Chain levels 3-4 first — they are the base a discount-form rule needs.
  let listPrice: number | null = null;
  if (customer?.priceListId && customer.priceListCurrency === currency) {
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
  const articlePrice =
    article.salesPrice === null ? null : currency === SEK ? Number(article.salesPrice) : fromSek(Number(article.salesPrice), rate);
  const basePrice = listPrice ?? articlePrice;
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
  const articleRule = customerRulesApply
    ? await ruleFor(
        and(eq(customerPrices.customerId, customerId), eq(customerPrices.articleId, articleId), sql`${customerPrices.fromQuantity} <= ${quantity}`)
      )
    : undefined;

  // Variant step: only when the variant has no agreement of its own.
  if (!articleRule && listPrice === null && opts.variantPrice) {
    const viaTemplate = await opts.variantPrice({
      customerId,
      variantArticleId: articleId,
      quantity,
      ...(currency === SEK ? {} : { currency, exchangeRate: rate }),
    });
    if (viaTemplate) return { articleNumber: article.articleNumber, price: viaTemplate };
  }

  // Levels 1-2: article rule, then group rule (only looked up when no
  // article rule matched). A matching rule WINS the chain even when its
  // discount form cannot produce a price (spec: no silent fall-through past
  // a matching customer agreement).
  const groupRule = customerRulesApply && !articleRule && article.groupId
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
