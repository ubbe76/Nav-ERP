// Artikelkortets flik Försäljning: the customer prices, kundens artikelnummer
// and price list rows of ONE article — the same rows the customer card and
// the price list register edit, read and replaced per article.
//
// The two writers replace the whole staffel of one pair — (customer, article)
// or (price list, article) — in ONE transaction that starts with an advisory
// lock on the pair, so two saves of the same dialog serialise and the second
// diffs against what the first committed. The customer card's and the price
// list register's own POST/PATCH/DELETE do not take the lock: the existing
// rows are read FOR UPDATE (their PATCH/DELETE waits), and their POST of the
// same fromQuantity ends in the unique index (StaffelConflict).
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  articleGroups,
  articles,
  customerArticleNumbers,
  customerPrices,
  customers,
  priceListRows,
  priceLists,
  type Db,
  type Tx,
} from "@navet/db";
import { round2, round4, type ArticleCustomerPricesInput, type ArticlePriceListRowsInput } from "@navet/shared";
import { isUniqueViolation } from "../../system/service/db-errors.js";

export type ArticleCustomerPriceRow = {
  id: string;
  fromQuantity: string;
  unitPrice: string | null;
  discountPercent: string | null;
  setupPrice: string | null;
};

export type ArticleCustomerEntry = {
  customerId: string;
  customerNumber: string;
  customerName: string;
  currency: string;
  customerArticleNumber: string | null;
  prices: ArticleCustomerPriceRow[];
};

export type ArticlePriceListEntry = {
  priceListId: string;
  code: string;
  name: string;
  currency: string;
  rows: { id: string; fromQuantity: string; unitPrice: string }[];
};

export type ArticleGroupRuleEntry = {
  customerId: string;
  customerNumber: string;
  customerName: string;
  currency: string;
  hasArticlePrices: boolean;
  rules: ArticleCustomerPriceRow[];
};

export type ArticleSalesPrices = {
  customers: ArticleCustomerEntry[];
  priceLists: ArticlePriceListEntry[];
  articleGroup: { id: string; code: string; name: string } | null;
  groupRules: ArticleGroupRuleEntry[];
};

const priceRowColumns = {
  id: customerPrices.id,
  customerId: customerPrices.customerId,
  fromQuantity: customerPrices.fromQuantity,
  unitPrice: customerPrices.unitPrice,
  discountPercent: customerPrices.discountPercent,
  setupPrice: customerPrices.setupPrice,
};

// Customers by id, sorted on the customer number by the database (the
// column's collation, not JS string order).
async function customersByNumber(db: Db | Tx, ids: string[]) {
  if (ids.length === 0) return [];
  return db
    .select({
      customerId: customers.id,
      customerNumber: customers.customerNumber,
      customerName: customers.name,
      currency: customers.currency,
    })
    .from(customers)
    .where(inArray(customers.id, ids))
    .orderBy(asc(customers.customerNumber));
}

function groupByCustomer<T extends { customerId: string }>(rows: T[]): Map<string, Omit<T, "customerId">[]> {
  const map = new Map<string, Omit<T, "customerId">[]>();
  for (const { customerId, ...rest } of rows) {
    const list = map.get(customerId) ?? [];
    list.push(rest);
    map.set(customerId, list);
  }
  return map;
}

// The customers that have an article price OR an article number for the
// article — one entry per customer, the staffel ascending. `customerId`
// narrows to one customer (the PUT's answer).
async function customerEntries(db: Db | Tx, articleId: string, customerId?: string): Promise<ArticleCustomerEntry[]> {
  const [prices, numbers] = await Promise.all([
    db
      .select(priceRowColumns)
      .from(customerPrices)
      .where(
        and(eq(customerPrices.articleId, articleId), customerId ? eq(customerPrices.customerId, customerId) : undefined)
      )
      .orderBy(asc(customerPrices.fromQuantity)),
    db
      .select({ customerId: customerArticleNumbers.customerId, number: customerArticleNumbers.customerArticleNumber })
      .from(customerArticleNumbers)
      .where(
        and(
          eq(customerArticleNumbers.articleId, articleId),
          customerId ? eq(customerArticleNumbers.customerId, customerId) : undefined
        )
      ),
  ]);
  const pricesByCustomer = groupByCustomer(prices);
  const numberByCustomer = new Map(numbers.map((row) => [row.customerId, row.number]));
  const owners = await customersByNumber(db, [...new Set([...pricesByCustomer.keys(), ...numberByCustomer.keys()])]);
  return owners.map((customer) => ({
    ...customer,
    customerArticleNumber: numberByCustomer.get(customer.customerId) ?? null,
    prices: pricesByCustomer.get(customer.customerId) ?? [],
  }));
}

// Every price list (the register is small), with the article's rows — an
// empty array when the article is not in the list. `priceListId` narrows to
// one list (the PUT's answer).
async function priceListEntries(db: Db | Tx, articleId: string, priceListId?: string): Promise<ArticlePriceListEntry[]> {
  const [lists, rows] = await Promise.all([
    db
      .select({ priceListId: priceLists.id, code: priceLists.code, name: priceLists.name, currency: priceLists.currency })
      .from(priceLists)
      .where(priceListId ? eq(priceLists.id, priceListId) : undefined)
      .orderBy(asc(priceLists.code)),
    db
      .select({
        id: priceListRows.id,
        priceListId: priceListRows.priceListId,
        fromQuantity: priceListRows.fromQuantity,
        unitPrice: priceListRows.unitPrice,
      })
      .from(priceListRows)
      .where(
        and(eq(priceListRows.articleId, articleId), priceListId ? eq(priceListRows.priceListId, priceListId) : undefined)
      )
      .orderBy(asc(priceListRows.fromQuantity)),
  ]);
  return lists.map((list) => ({
    ...list,
    rows: rows
      .filter((row) => row.priceListId === list.priceListId)
      .map(({ id, fromQuantity, unitPrice }) => ({ id, fromQuantity, unitPrice })),
  }));
}

// The whole tab in one read; null = unknown article.
export async function readArticleSalesPrices(db: Db | Tx, articleId: string): Promise<ArticleSalesPrices | null> {
  const [article] = await db
    .select({
      id: articles.id,
      groupId: articles.groupId,
      groupCode: articleGroups.code,
      groupName: articleGroups.name,
    })
    .from(articles)
    .leftJoin(articleGroups, eq(articleGroups.id, articles.groupId))
    .where(eq(articles.id, articleId));
  if (!article) return null;

  const [customerList, lists, groupRows] = await Promise.all([
    customerEntries(db, articleId),
    priceListEntries(db, articleId),
    article.groupId
      ? db
          .select(priceRowColumns)
          .from(customerPrices)
          .where(eq(customerPrices.articleGroupId, article.groupId))
          .orderBy(asc(customerPrices.fromQuantity))
      : Promise.resolve([]),
  ]);
  const rulesByCustomer = groupByCustomer(groupRows);
  const ruleOwners = await customersByNumber(db, [...rulesByCustomer.keys()]);
  const withArticlePrices = new Set(customerList.filter((c) => c.prices.length > 0).map((c) => c.customerId));
  return {
    customers: customerList,
    priceLists: lists,
    articleGroup:
      article.groupId && article.groupCode !== null && article.groupName !== null
        ? { id: article.groupId, code: article.groupCode, name: article.groupName }
        : null,
    groupRules: ruleOwners.map((customer) => ({
      ...customer,
      hasArticlePrices: withArticlePrices.has(customer.customerId),
      rules: rulesByCustomer.get(customer.customerId) ?? [],
    })),
  };
}

// The staffel step as the column holds it: numeric(14,4) comes back as
// "1.0000" and arrives as 1 — the same step.
const stepKey = (fromQuantity: string | number) => round4(Number(fromQuantity));
const price4 = (value: number | null | undefined) => (value == null ? null : round4(value));
const numeric = (value: number | null) => (value === null ? null : String(value));
const stored4 = (value: string | null) => (value === null ? null : round4(Number(value)));
const stored2 = (value: string | null) => (value === null ? null : round2(Number(value)));

// The pair's lock, FIRST in the transaction (advisory → rows). Two int4 keys
// out of hashtext: the kind and the two ids.
export async function lockArticleSalesPair(tx: Tx, kind: "customer" | "price_list", ownerId: string, articleId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`article_sales_prices:${kind}`}), hashtext(${`${ownerId}:${articleId}`}))`
  );
}

// A step the transaction tried to insert already exists — the customer
// card's (or the price list register's) POST of the same fromQuantity
// committed between the diff's read and the insert. Thrown, so the
// transaction rolls back; the service maps it to its 409
// (DuplicateCustomerPriceError / DuplicatePriceListRowError). An internal
// signal, never sent — hence no "Error" suffix and no error code.
export class StaffelConflict extends Error {
  constructor(public fromQuantity: number) {
    super();
  }
}

export type CustomerPriceChange =
  | { kind: "created"; row: typeof customerPrices.$inferSelect }
  | { kind: "updated"; before: typeof customerPrices.$inferSelect; row: typeof customerPrices.$inferSelect }
  | { kind: "deleted"; row: typeof customerPrices.$inferSelect };

export type CustomerArticleNumberChange =
  | { kind: "created"; id: string; after: string }
  | { kind: "updated"; id: string; before: string; after: string }
  | { kind: "deleted"; id: string; before: string };

export type ReplaceArticleCustomerPricesResult =
  | { ok: false; reason: "customer_not_found" | "article_not_found" }
  | {
      ok: true;
      entry: ArticleCustomerEntry | null;
      priceChanges: CustomerPriceChange[];
      numberChange: CustomerArticleNumberChange | null;
    };

export async function replaceArticleCustomerPrices(
  db: Db,
  articleId: string,
  customerId: string,
  input: ArticleCustomerPricesInput
): Promise<ReplaceArticleCustomerPricesResult> {
  return db.transaction(async (tx) => {
    await lockArticleSalesPair(tx, "customer", customerId, articleId);
    // Nothing has been written when these return, so a plain return is fine.
    // KEY SHARE (what the inserts' FK checks take anyway): the article and
    // the customer cannot be deleted between the check and the writes.
    const [article] = await tx
      .select({ id: articles.id })
      .from(articles)
      .where(eq(articles.id, articleId))
      .for("key share");
    if (!article) return { ok: false as const, reason: "article_not_found" as const };
    const [customer] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.id, customerId))
      .for("key share");
    if (!customer) return { ok: false as const, reason: "customer_not_found" as const };

    const existing = await tx
      .select()
      .from(customerPrices)
      .where(and(eq(customerPrices.customerId, customerId), eq(customerPrices.articleId, articleId)))
      .orderBy(asc(customerPrices.id))
      .for("update");
    const wanted = new Map(
      input.prices.map((row) => [
        stepKey(row.fromQuantity),
        {
          unitPrice: price4(row.unitPrice),
          discountPercent: row.discountPercent == null ? null : round2(row.discountPercent),
          // 0 means none, like an empty field.
          setupPrice: row.setupPrice ? price4(row.setupPrice) : null,
        },
      ])
    );

    const priceChanges: CustomerPriceChange[] = [];
    // Deletes first, then updates (the step never moves), then inserts — no
    // statement can meet a step another statement of this diff still holds.
    for (const row of existing) {
      if (wanted.has(stepKey(row.fromQuantity))) continue;
      await tx.delete(customerPrices).where(eq(customerPrices.id, row.id));
      priceChanges.push({ kind: "deleted", row });
    }
    for (const row of existing) {
      const target = wanted.get(stepKey(row.fromQuantity));
      if (!target) continue;
      wanted.delete(stepKey(row.fromQuantity));
      if (
        stored4(row.unitPrice) === target.unitPrice &&
        stored2(row.discountPercent) === target.discountPercent &&
        stored4(row.setupPrice) === target.setupPrice
      )
        continue;
      const [updated] = await tx
        .update(customerPrices)
        .set({
          unitPrice: numeric(target.unitPrice),
          discountPercent: numeric(target.discountPercent),
          setupPrice: numeric(target.setupPrice),
        })
        .where(eq(customerPrices.id, row.id))
        .returning();
      priceChanges.push({ kind: "updated", before: row, row: updated! });
    }
    for (const [fromQuantity, target] of [...wanted].sort(([a], [b]) => a - b)) {
      try {
        const [created] = await tx
          .insert(customerPrices)
          .values({
            customerId,
            articleId,
            fromQuantity: String(fromQuantity),
            unitPrice: numeric(target.unitPrice),
            discountPercent: numeric(target.discountPercent),
            setupPrice: numeric(target.setupPrice),
          })
          .returning();
        priceChanges.push({ kind: "created", row: created! });
      } catch (err) {
        if (isUniqueViolation(err)) throw new StaffelConflict(fromQuantity);
        throw err;
      }
    }

    const [current] = await tx
      .select()
      .from(customerArticleNumbers)
      .where(and(eq(customerArticleNumbers.customerId, customerId), eq(customerArticleNumbers.articleId, articleId)))
      .for("update");
    let numberChange: CustomerArticleNumberChange | null = null;
    const number = input.customerArticleNumber;
    if (number === null) {
      if (current) {
        await tx.delete(customerArticleNumbers).where(eq(customerArticleNumbers.id, current.id));
        numberChange = { kind: "deleted", id: current.id, before: current.customerArticleNumber };
      }
    } else if (!current) {
      // Upsert: the customer card's POST for the same pair may have committed
      // since the read above — the number sent here wins instead of a 23505.
      const [created] = await tx
        .insert(customerArticleNumbers)
        .values({ customerId, articleId, customerArticleNumber: number })
        .onConflictDoUpdate({
          target: [customerArticleNumbers.customerId, customerArticleNumbers.articleId],
          set: { customerArticleNumber: number },
        })
        .returning();
      numberChange = { kind: "created", id: created!.id, after: number };
    } else if (current.customerArticleNumber !== number) {
      await tx
        .update(customerArticleNumbers)
        .set({ customerArticleNumber: number })
        .where(eq(customerArticleNumbers.id, current.id));
      numberChange = { kind: "updated", id: current.id, before: current.customerArticleNumber, after: number };
    }

    const [entry] = await customerEntries(tx, articleId, customerId);
    return { ok: true as const, entry: entry ?? null, priceChanges, numberChange };
  });
}

type PriceListRow = typeof priceListRows.$inferSelect;
export type PriceListRowChange =
  | { kind: "created"; row: PriceListRow }
  | { kind: "updated"; before: PriceListRow; row: PriceListRow }
  | { kind: "deleted"; row: PriceListRow };

export type ReplaceArticlePriceListRowsResult =
  | { ok: false; reason: "price_list_not_found" | "article_not_found" }
  | { ok: true; entry: ArticlePriceListEntry; articleNumber: string; changes: PriceListRowChange[] };

export async function replaceArticlePriceListRows(
  db: Db,
  articleId: string,
  priceListId: string,
  input: ArticlePriceListRowsInput
): Promise<ReplaceArticlePriceListRowsResult> {
  return db.transaction(async (tx) => {
    await lockArticleSalesPair(tx, "price_list", priceListId, articleId);
    const [article] = await tx
      .select({ id: articles.id, articleNumber: articles.articleNumber })
      .from(articles)
      .where(eq(articles.id, articleId))
      .for("key share");
    if (!article) return { ok: false as const, reason: "article_not_found" as const };
    const [list] = await tx
      .select({ id: priceLists.id })
      .from(priceLists)
      .where(eq(priceLists.id, priceListId))
      .for("key share");
    if (!list) return { ok: false as const, reason: "price_list_not_found" as const };

    const existing = await tx
      .select()
      .from(priceListRows)
      .where(and(eq(priceListRows.priceListId, priceListId), eq(priceListRows.articleId, articleId)))
      .orderBy(asc(priceListRows.id))
      .for("update");
    const wanted = new Map(input.rows.map((row) => [stepKey(row.fromQuantity), round4(row.unitPrice)]));

    const changes: PriceListRowChange[] = [];
    for (const row of existing) {
      if (wanted.has(stepKey(row.fromQuantity))) continue;
      await tx.delete(priceListRows).where(eq(priceListRows.id, row.id));
      changes.push({ kind: "deleted", row });
    }
    for (const row of existing) {
      const unitPrice = wanted.get(stepKey(row.fromQuantity));
      if (unitPrice === undefined) continue;
      wanted.delete(stepKey(row.fromQuantity));
      if (stored4(row.unitPrice) === unitPrice) continue;
      const [updated] = await tx
        .update(priceListRows)
        .set({ unitPrice: String(unitPrice) })
        .where(eq(priceListRows.id, row.id))
        .returning();
      changes.push({ kind: "updated", before: row, row: updated! });
    }
    for (const [fromQuantity, unitPrice] of [...wanted].sort(([a], [b]) => a - b)) {
      try {
        const [created] = await tx
          .insert(priceListRows)
          .values({ priceListId, articleId, fromQuantity: String(fromQuantity), unitPrice: String(unitPrice) })
          .returning();
        changes.push({ kind: "created", row: created! });
      } catch (err) {
        if (isUniqueViolation(err)) throw new StaffelConflict(fromQuantity);
        throw err;
      }
    }

    const [entry] = await priceListEntries(tx, articleId, priceListId);
    return { ok: true as const, entry: entry!, articleNumber: article.articleNumber, changes };
  });
}
