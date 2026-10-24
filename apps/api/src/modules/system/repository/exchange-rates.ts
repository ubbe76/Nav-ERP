import { and, asc, count, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import { exchangeRates, systemSettings, users, type Db, type Tx } from "@navet/db";
import type { ExchangeRateSource, ListExchangeRatesQuery } from "@navet/shared";

// Valutakurser — the DB leaf of system/service/exchange-rates.ts. Db | Tx
// throughout (the same composable seam as posting-settings.ts and
// resolveStockLocation), so a lookup can run inside a caller's transaction.

export type StoredRate = { date: string; rate: number; source: ExchangeRateSource };

export const EXCHANGE_RATE_SETTING_KEYS = {
  source: "exchange_rate_source",
  apiKey: "riksbank_api_key",
} as const;

// Every stored rate for the currency in [from, to], oldest first.
export async function ratesInRange(executor: Db | Tx, currency: string, from: string, to: string): Promise<StoredRate[]> {
  const rows = await executor
    .select({ date: exchangeRates.date, rate: exchangeRates.rate, source: exchangeRates.source })
    .from(exchangeRates)
    .where(and(eq(exchangeRates.currency, currency), gte(exchangeRates.date, from), lte(exchangeRates.date, to)))
    .orderBy(asc(exchangeRates.date));
  return rows.map((row) => ({ date: row.date, rate: Number(row.rate), source: row.source as ExchangeRateSource }));
}

// Riksbanken's observations are a cache: a re-fetched day overwrites the
// stored value (Riksbanken may correct a published rate).
export async function upsertRiksbankRates(
  executor: Db | Tx,
  currency: string,
  observations: { date: string; value: number }[]
): Promise<void> {
  if (observations.length === 0) return;
  await executor
    .insert(exchangeRates)
    .values(
      observations.map((observation) => ({
        currency,
        date: observation.date,
        rate: String(observation.value),
        source: "riksbank",
      }))
    )
    .onConflictDoUpdate({
      target: [exchangeRates.currency, exchangeRates.date, exchangeRates.source],
      set: { rate: sql`excluded.rate`, updatedAt: new Date() },
    });
}

// A manual rate replaces an earlier manual rate for the same day. `created`
// tells the audit trail whether this was a new rate or a correction.
export async function upsertManualRate(
  executor: Db | Tx,
  input: { currency: string; date: string; rate: number },
  userId: string | null
): Promise<{ id: string; created: boolean; previousRate: number | null }> {
  const [existing] = await executor
    .select({ id: exchangeRates.id, rate: exchangeRates.rate })
    .from(exchangeRates)
    .where(and(eq(exchangeRates.currency, input.currency), eq(exchangeRates.date, input.date), eq(exchangeRates.source, "manual")));
  const [row] = await executor
    .insert(exchangeRates)
    .values({ currency: input.currency, date: input.date, rate: String(input.rate), source: "manual", createdBy: userId })
    .onConflictDoUpdate({
      target: [exchangeRates.currency, exchangeRates.date, exchangeRates.source],
      set: { rate: String(input.rate), createdBy: userId, updatedAt: new Date() },
    })
    .returning({ id: exchangeRates.id });
  return { id: row!.id, created: !existing, previousRate: existing ? Number(existing.rate) : null };
}

const rateColumns = {
  id: exchangeRates.id,
  currency: exchangeRates.currency,
  date: exchangeRates.date,
  rate: exchangeRates.rate,
  source: exchangeRates.source,
  createdBy: exchangeRates.createdBy,
  createdByName: users.name,
  createdAt: exchangeRates.createdAt,
  updatedAt: exchangeRates.updatedAt,
};

function toRateRow(row: {
  id: string;
  currency: string;
  date: string;
  rate: string;
  source: string;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return { ...row, rate: Number(row.rate), source: row.source as ExchangeRateSource };
}

export async function findRateById(executor: Db | Tx, id: string) {
  const [row] = await executor
    .select(rateColumns)
    .from(exchangeRates)
    .leftJoin(users, eq(users.id, exchangeRates.createdBy))
    .where(eq(exchangeRates.id, id));
  return row ? toRateRow(row) : null;
}

// The list mönster: newest day first, then currency, then source.
export async function listRates(executor: Db | Tx, query: ListExchangeRatesQuery) {
  const conditions: SQL[] = [];
  if (query.currency) conditions.push(eq(exchangeRates.currency, query.currency));
  if (query.from) conditions.push(gte(exchangeRates.date, query.from));
  if (query.to) conditions.push(lte(exchangeRates.date, query.to));
  if (query.source) conditions.push(eq(exchangeRates.source, query.source));
  if (query.search) conditions.push(eq(exchangeRates.currency, query.search.trim().toUpperCase()));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const [rows, totalRows] = await Promise.all([
    executor
      .select(rateColumns)
      .from(exchangeRates)
      .leftJoin(users, eq(users.id, exchangeRates.createdBy))
      .where(where)
      .orderBy(desc(exchangeRates.date), asc(exchangeRates.currency), asc(exchangeRates.source))
      .limit(query.limit)
      .offset(query.offset),
    executor.select({ total: count() }).from(exchangeRates).where(where),
  ]);
  return { rows: rows.map(toRateRow), total: totalRows[0]!.total };
}

export async function readExchangeRateSettings(executor: Db | Tx): Promise<Map<string, string>> {
  const rows = await executor
    .select({ key: systemSettings.key, value: systemSettings.value })
    .from(systemSettings)
    .where(inArray(systemSettings.key, Object.values(EXCHANGE_RATE_SETTING_KEYS)));
  return new Map(rows.map((row) => [row.key, row.value] as const));
}

export async function writeExchangeRateSetting(executor: Db | Tx, key: string, value: string | null): Promise<void> {
  if (value === null) {
    await executor.delete(systemSettings).where(eq(systemSettings.key, key));
    return;
  }
  await executor.insert(systemSettings).values({ key, value }).onConflictDoUpdate({ target: systemSettings.key, set: { value } });
}
