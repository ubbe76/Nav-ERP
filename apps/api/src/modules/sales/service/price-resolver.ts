import { and, desc, eq, sql } from "drizzle-orm";
import { articles, configuratorVariants, customerPrices, customers, priceListRows, priceLists, type Db, type Tx } from "@navet/db";
import { fromSek, SEK, type CalculatedPriceDetail, type CalculatedPriceUnavailable, type PriceQuoteQuery, type PriceSource } from "@navet/shared";

// setupPrice: the matched customer rule's ställpris (> 0 only), in the same
// currency as unitPrice — a customer rule only applies in the customer's own
// currency, so it never needs converting.
export type ResolvedPrice = { unitPrice: number; discountPercent: number; source: PriceSource; setupPrice?: number };
// null = unknown article. Kalkylpris (#16): `calculated` is the step's basis
// when it priced the row (source "calculated"); `calculatedPriceUnavailable`
// says why the step could not be used although the customer (or order) has
// a price markup of its own — the chain then went on to the article's price.
export type PriceResolution = {
  articleNumber: string;
  price: ResolvedPrice | null;
  calculated?: CalculatedPriceDetail;
  calculatedPriceUnavailable?: CalculatedPriceUnavailable;
} | null;

// A level's two price markups as the Kalkylpris reads them: null = inherit.
export type PriceMarkups = { generalMarkupPercent: number | null; materialMarkupPercent: number | null };

// What the sales service asks the bound chain (app.ts's salesPriceChain):
// the price quote, plus the order's own markups (#16 etapp 3) when the row
// is on an order that has one — omitted otherwise, so every reader stub
// sees the call it saw before.
export type PriceChainQuery = PriceQuoteQuery & { orderMarkups?: PriceMarkups | null };

// Kalkylpris (#16 etapp 2): the costing module's reader (costingService.
// calculatedPrice, bound in app.ts). null = the step does not apply (no
// price markup of the customer's or the order's own); otherwise the SEK
// price per unit with its basis, or why it is unavailable. Takes the chain's
// own handle, so a caller inside a transaction reads through it. The
// configurator's own price binding has no reader — a beställningsvara and a
// template's chain never get a Kalkylpris (their price model is base price
// plus additions).
export type CalculatedPriceReader = (
  dbc: Db | Tx,
  q: { articleId: string; customer: PriceMarkups | null; order?: PriceMarkups | null }
) => Promise<{ unitPrice: number; calculated: CalculatedPriceDetail } | { unavailable: CalculatedPriceUnavailable } | null>;

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
// group rule → customer's price list → Kalkylpris (#16) → the article's base
// price. Each level picks the highest from_quantity <= quantity. A
// discount-form rule needs an underlying list/base price — without one the
// result is null, never 0. The customer's blanket discount
// (customers.discount_percent, Monitor's "Rabatt" on the customer card) is
// the last fallback: it applies on the list/base price only when no
// customer-specific rule matched — never on the Kalkylpris.
//
// Kalkylpris (#16 etapp 2–3): only when the customer or the order
// (`orderMarkups`, order → kund → varugrupp → företaget field by field) has
// a price markup of its own and neither a
// customer rule nor the price list priced the row: agreed prices go before a
// computed one. The article's latest saved förkalkyl re-priced with the
// row's markups (opts.calculatedPrice), in SEK and converted with the
// order's rate like the article's price; discount 0 and no ställpris (that
// only comes from a matched customer rule). Without a calculation (or base)
// the chain goes on to the article's price and says why
// (calculatedPriceUnavailable). A discount-form customer rule still takes
// the list/article price as its base, never the Kalkylpris.
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
    orderMarkups,
  }: { customerId: string; articleId: string; quantity: number; orderMarkups?: PriceMarkups | null } & PriceCurrency,
  opts: { variantPrice?: VariantPriceReader; calculatedPrice?: CalculatedPriceReader } = {}
): Promise<PriceResolution> {
  const currency = currencyInput ?? SEK;
  const rate = currency === SEK ? 1 : exchangeRate;
  if (rate === undefined || !(rate > 0)) throw new Error(`Pricing in ${currency} needs the order's exchange rate`);
  const [article] = await dbc
    .select({
      articleNumber: articles.articleNumber,
      salesPrice: articles.salesPrice,
      groupId: articles.groupId,
      // The variant step below runs only for a variant — an ordinary article
      // no longer costs a configurator lookup per pricing.
      isVariant: sql<boolean>`exists (select 1 from ${configuratorVariants} cv where cv.article_id = ${articles.id})`,
    })
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
      generalMarkupPercent: customers.generalMarkupPercent,
      materialMarkupPercent: customers.materialMarkupPercent,
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
      .select({
        unitPrice: customerPrices.unitPrice,
        discountPercent: customerPrices.discountPercent,
        setupPrice: customerPrices.setupPrice,
      })
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
  if (!articleRule && listPrice === null && opts.variantPrice && article.isVariant) {
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
    const setup = rule.setupPrice !== null && Number(rule.setupPrice) > 0 ? { setupPrice: Number(rule.setupPrice) } : {};
    if (rule.unitPrice !== null) {
      return { articleNumber: article.articleNumber, price: { unitPrice: Number(rule.unitPrice), discountPercent: 0, source, ...setup } };
    }
    if (basePrice === null) return none;
    return {
      articleNumber: article.articleNumber,
      price: { unitPrice: basePrice, discountPercent: Number(rule.discountPercent), source, ...setup },
    };
  }

  // Step 4, Kalkylpris: after every agreement (customer rules above, the
  // price list), before the article's price. The reader answers null when
  // neither the customer nor the order has a markup of its own.
  let calculatedPriceUnavailable: CalculatedPriceUnavailable | undefined;
  if (listPrice === null && opts.calculatedPrice && customer) {
    const outcome = await opts.calculatedPrice(dbc, {
      articleId,
      customer: {
        generalMarkupPercent: customer.generalMarkupPercent === null ? null : Number(customer.generalMarkupPercent),
        materialMarkupPercent: customer.materialMarkupPercent === null ? null : Number(customer.materialMarkupPercent),
      },
      order: orderMarkups ?? null,
    });
    if (outcome && "unitPrice" in outcome) {
      return {
        articleNumber: article.articleNumber,
        price: {
          unitPrice: currency === SEK ? outcome.unitPrice : fromSek(outcome.unitPrice, rate),
          discountPercent: 0,
          source: "calculated",
        },
        calculated: outcome.calculated,
      };
    }
    if (outcome) calculatedPriceUnavailable = outcome.unavailable;
  }
  const unavailable = calculatedPriceUnavailable ? { calculatedPriceUnavailable } : {};

  if (basePrice === null) return { ...none, ...unavailable };
  const customerDiscount = customer ? Number(customer.discountPercent) : 0;
  if (customerDiscount > 0) {
    return {
      articleNumber: article.articleNumber,
      price: { unitPrice: basePrice, discountPercent: customerDiscount, source: "customer_discount" },
      ...unavailable,
    };
  }
  return { articleNumber: article.articleNumber, price: { unitPrice: basePrice, discountPercent: 0, source: baseSource }, ...unavailable };
}
