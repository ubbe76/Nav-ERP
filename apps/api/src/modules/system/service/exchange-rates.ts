import type { Db } from "@navet/db";
import {
  SEK,
  type CreateExchangeRateInput,
  type ExchangeRateMode,
  type ExchangeRateSource,
  type FetchExchangeRatesInput,
  type ListExchangeRatesQuery,
  type UpdateExchangeRateSettingsInput,
} from "@navet/shared";
import type { AuditWriter } from "../repository/audit.repository.js";
import {
  deleteReferenceRateRow,
  findReferenceRateById,
  listReferenceRates,
  referenceRatesFor,
  upsertManualReferenceRate,
  upsertRiksbankReferenceRate,
  type ReferenceRateRow,
} from "../repository/reference-rates.js";
import { halfYearStart, halfYearStartsBetween, previousHalfYearStart } from "./half-years.js";
import {
  EXCHANGE_RATE_SETTING_KEYS,
  findRateById,
  listRates,
  ratesInRange,
  readExchangeRateSettings,
  upsertManualRate,
  upsertRiksbankRates,
  writeExchangeRateSetting,
  type StoredRate,
} from "../repository/exchange-rates.js";
import { addDays, stockholmToday } from "./delivery-days.js";

// Valutakurser (Valuta, spec §1) — the ONLY file that knows Sveriges
// Riksbank's API (SWEA). Rates are SEK per 1 unit of the currency (Riksbanken
// quotes every currency per 1 unit since 2023-11-27) and are ECB's reference
// rates converted to kronor, which ML 8 kap. 21 § accepts.
//
// "The rate for day D" = the latest banking day ≤ D: Riksbanken publishes
// nothing for weekends and holidays (a single day answers 204), so a lookup
// always asks for the interval [D−10, D] in ONE call and stores every day in
// the answer. Today's rate is published around 16:15 — before that the
// latest is yesterday's. Anonymous callers get 5 calls a minute and 1000 a
// day per IP, so every answer is cached in exchange_rates and a lookup that
// the table can already answer never calls out; an optional API key
// (riksbank_api_key, write-only, header Ocp-Apim-Subscription-Key) raises
// the limit.
//
// Transport failures are never described by err.message (Node's fetch can
// echo a header VALUE — the API key — in it): the log gets the error's name
// and the cause's code only, the caller a fixed Swedish message.

export const RIKSBANK_BASE_URL = "https://api.riksbank.se/swea/v1";
// Referensränta (räntelagen 9 §): the SWEA series of Riksbankens
// referensränta, in percent. Verified 2026-10-25:
// /Observations/SECBREFEFF/2026-07-01/2026-07-11 → [{ date, value }]. The
// first observation on or after a half-year start is that half-year's rate;
// an empty answer (204) means it is not published (yet).
export const REFERENCE_RATE_SERIES = "SECBREFEFF";
const REFERENCE_RATE_WINDOW_DAYS = 10;
// How many half-years Hämta från Riksbanken takes by default.
const REFERENCE_RATE_DEFAULT_HALF_YEARS = 4;
const TIMEOUT_MS = 10_000;
// How far back the interval reaches: longer than any run of Swedish
// non-banking days (Christmas–New Year is at most five in a row).
export const LOOKBACK_DAYS = 10;
// A fetch that answered is not repeated for the same currency and day within
// this window — the cache keeps the observations, this remembers that the
// interval was asked for (a holiday is otherwise indistinguishable from a
// day not yet fetched). Today's interval is asked again sooner, since
// today's rate appears at 16:15.
const FETCHED_TTL_PAST_MS = 6 * 60 * 60 * 1000;
const FETCHED_TTL_TODAY_MS = 10 * 60 * 1000;
const FETCHED_MEMO_MAX = 2000;

export const RIKSBANK_MESSAGES = {
  unavailable: "Riksbanken svarar inte — försök igen eller ange kursen själv",
  rate_limited: "Riksbanken tar inte emot fler anrop just nu — försök igen om en minut eller ange kursen själv",
  unauthorized: "Riksbanken godkände inte API-nyckeln — kontrollera den under Ekonomi → Valutakurser",
  unexpected: "Riksbanken gav ett oväntat svar — försök igen eller ange kursen själv",
} as const;

export type RiksbankFailure = keyof typeof RIKSBANK_MESSAGES;

// No rate for the currency on the day: Riksbanken does not publish the
// currency, did not answer, and no manual rate covers the day. 409
// exchange-rate-unavailable — the document then needs a rate typed in.
export class ExchangeRateUnavailableError extends Error {
  constructor(
    public currency: string,
    public date: string
  ) {
    super(`Ingen kurs för ${currency} ${date} — ange kursen själv`);
    this.name = "ExchangeRateUnavailableError";
  }
}

// Hämta från Riksbanken (the explicit fetch) could not get an answer. 502
// riksbank-unavailable, or 409 for a key Riksbanken refused.
export class RiksbankUnavailableError extends Error {
  constructor(public reason: RiksbankFailure) {
    super(RIKSBANK_MESSAGES[reason]);
    this.name = "RiksbankUnavailableError";
  }
}

// DELETE /reference-rates/:id on a row Riksbanken gave: 409
// reference-rate-riksbank — add a manual rate for the half-year instead.
export class ReferenceRateRiksbankError extends Error {
  constructor(public validFrom: string) {
    super(`Referensräntan från ${validFrom} är hämtad från Riksbanken och kan inte tas bort`);
    this.name = "ReferenceRateRiksbankError";
  }
}

// Dröjsmålsränta: the slice the sales side reads — the referensräntor for
// the half-years a period touches, fetched from Riksbanken first when
// missing (never inside a transaction). Half-years still missing are absent
// from the map.
export interface ReferenceRateReader {
  ensureReferenceRates(halfYearStarts: string[]): Promise<Map<string, number>>;
}

export type ExchangeRateLookup = {
  currency: string;
  // The day asked for, and the day of the rate that answered (the latest
  // banking day ≤ requestedDate, or the manual rate's day).
  requestedDate: string;
  date: string;
  rate: number;
  // null = SEK (always 1, never looked up).
  source: ExchangeRateSource | null;
};

// The narrow slice the document services use (supplier invoices now, the
// sales side in steg 3) — declared here, consumers depend on the interface.
export interface ExchangeRateReader {
  getRate(currency: string, date: string): Promise<ExchangeRateLookup>;
}

type Observation = { date: string; value: number };
type FetchResult = { ok: true; observations: Observation[] } | { ok: false; reason: RiksbankFailure };

export interface ExchangeRateServiceDeps {
  db: Db;
  audit?: AuditWriter;
  // Injected by every test — the suite must never call Riksbanken.
  fetch?: typeof fetch;
  timeoutMs?: number;
  // Stockholm today (YYYY-MM-DD) and a millisecond clock for the fetch memo.
  today?: () => string;
  clock?: () => number;
  log?: (entry: { currency: string; from: string; to: string; status: number; detail: string }) => void;
}

// What we log about a transport failure: the error's name and the cause's
// code — never err.message (see the header).
function transportSummary(err: unknown): string {
  const e = (err ?? {}) as { name?: unknown; cause?: { code?: unknown } | null };
  return [e.name, e.cause?.code].filter((v): v is string => typeof v === "string" && v !== "").join(" ");
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;

// An exchange rate is always positive; the referensränta may be zero or
// negative (0,00 and −0,50 in the 2010s), so the series decides the check.
function parseObservations(text: string, opts: { allowNonPositive: boolean }): Observation[] | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  const observations: Observation[] = [];
  for (const item of data) {
    const entry = item as { date?: unknown; value?: unknown };
    if (typeof entry?.date !== "string" || !ISO_DATE.test(entry.date)) return null;
    if (typeof entry.value !== "number" || !Number.isFinite(entry.value)) return null;
    if (!opts.allowNonPositive && entry.value <= 0) return null;
    observations.push({ date: entry.date, value: Math.round(entry.value * 1e6) / 1e6 });
  }
  return observations;
}

function isWeekend(date: string): boolean {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

// Every day in (after, through] is a Saturday or a Sunday — then the stored
// rate for `after` is provably the latest banking day ≤ through.
function onlyWeekendBetween(after: string, through: string): boolean {
  for (let d = addDays(after, 1); d <= through; d = addDays(d, 1)) {
    if (!isWeekend(d)) return false;
  }
  return true;
}

export function createExchangeRateService(deps: ExchangeRateServiceDeps) {
  const { db } = deps;
  const audit: AuditWriter = deps.audit ?? { log: async () => {} };
  // Call-time lookup of the global, so the test setup's guard applies.
  const doFetch: typeof fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  const today = deps.today ?? stockholmToday;
  const clock = deps.clock ?? (() => Date.now());
  const log =
    deps.log ?? ((entry) => console.warn("Riksbanken request failed", entry));

  // `${currency}|${day}` → when the interval ending on that day was fetched
  // successfully may be trusted until.
  const fetched = new Map<string, number>();
  const fetchedKey = (currency: string, day: string) => `${currency}|${day}`;
  function fetchedRecently(currency: string, day: string): boolean {
    const until = fetched.get(fetchedKey(currency, day));
    return until !== undefined && until > clock();
  }
  function markFetched(currency: string, day: string) {
    if (fetched.size >= FETCHED_MEMO_MAX) fetched.clear();
    fetched.set(fetchedKey(currency, day), clock() + (day >= today() ? FETCHED_TTL_TODAY_MS : FETCHED_TTL_PAST_MS));
  }

  async function readSettings(): Promise<{ source: ExchangeRateMode; apiKey: string | null }> {
    const raw = await readExchangeRateSettings(db);
    const apiKey = raw.get(EXCHANGE_RATE_SETTING_KEYS.apiKey);
    return {
      source: raw.get(EXCHANGE_RATE_SETTING_KEYS.source) === "manual" ? "manual" : "riksbank",
      apiKey: apiKey && apiKey !== "" ? apiKey : null,
    };
  }

  // One SWEA observations call. `series` is the exchange rate's SEK{CCY}PMI
  // or the referensränta's SECBREFEFF; `currency` labels the log entry.
  async function fetchSeries(series: string, currency: string, from: string, to: string, apiKey: string | null): Promise<FetchResult> {
    const path = `/Observations/${series}/${from}/${to}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await doFetch(RIKSBANK_BASE_URL + path, {
        method: "GET",
        headers: { Accept: "application/json", ...(apiKey ? { "Ocp-Apim-Subscription-Key": apiKey } : {}) },
        signal: controller.signal,
      });
      // The body read is inside the timeout too: a body that never arrives
      // is as much a transport failure as a connect that hangs.
      text = await res.text();
    } catch (err) {
      log({ currency, from, to, status: 0, detail: transportSummary(err) });
      return { ok: false, reason: "unavailable" };
    } finally {
      clearTimeout(timer);
    }
    // 204 = no observation in the interval (weekend/holiday only, or a
    // currency Riksbanken does not publish — verified 2026-10-24 for
    // SEKAEDPMI). 400/404 are read the same way: no rate from Riksbanken.
    if (res.status === 204 || res.status === 400 || res.status === 404) {
      if (res.status !== 204) log({ currency, from, to, status: res.status, detail: "no series" });
      return { ok: true, observations: [] };
    }
    if (res.status === 429) {
      log({ currency, from, to, status: 429, detail: "rate limited" });
      return { ok: false, reason: "rate_limited" };
    }
    if (res.status === 401 || res.status === 403) {
      log({ currency, from, to, status: res.status, detail: "unauthorized" });
      return { ok: false, reason: "unauthorized" };
    }
    if (!res.ok) {
      log({ currency, from, to, status: res.status, detail: "error" });
      return { ok: false, reason: "unavailable" };
    }
    const observations = parseObservations(text, { allowNonPositive: series === REFERENCE_RATE_SERIES });
    if (observations === null) {
      log({ currency, from, to, status: res.status, detail: "unexpected body" });
      return { ok: false, reason: "unexpected" };
    }
    return { ok: true, observations: observations.filter((o) => o.date >= from && o.date <= to) };
  }

  async function fetchObservations(currency: string, from: string, to: string, apiKey: string | null): Promise<FetchResult> {
    return fetchSeries(`SEK${currency}PMI`, currency, from, to, apiKey);
  }

  // Riksbankens referensränta for one half-year: the first observation in
  // [start, start + 10 days]. ok with rate null = not published.
  async function fetchReferenceRate(
    validFrom: string,
    apiKey: string | null
  ): Promise<{ ok: true; rate: number | null } | { ok: false; reason: RiksbankFailure }> {
    const result = await fetchSeries(REFERENCE_RATE_SERIES, REFERENCE_RATE_SERIES, validFrom, addDays(validFrom, REFERENCE_RATE_WINDOW_DAYS), apiKey);
    if (!result.ok) return result;
    const first = [...result.observations].sort((a, b) => a.date.localeCompare(b.date))[0];
    return { ok: true, rate: first ? Math.round(first.value * 100) / 100 : null };
  }

  // The half-years Hämta från Riksbanken takes: [from, to] when given, else
  // the latest REFERENCE_RATE_DEFAULT_HALF_YEARS through today.
  function referenceHalfYears(input: { from?: string; to?: string }): string[] {
    const todayDate = today();
    const to = input.to ?? todayDate;
    let from = input.from;
    if (from === undefined) {
      from = halfYearStart(to);
      for (let i = 1; i < REFERENCE_RATE_DEFAULT_HALF_YEARS; i++) from = previousHalfYearStart(from);
    }
    // A half-year after today's is not published yet — never asked for.
    return halfYearStartsBetween(from, to).filter((start) => start <= todayDate);
  }

  function referenceFetchedKey(validFrom: string) {
    return `${REFERENCE_RATE_SERIES}|${validFrom}`;
  }

  function lookup(currency: string, requestedDate: string, rate: StoredRate): ExchangeRateLookup {
    return { currency, requestedDate, date: rate.date, rate: rate.rate, source: rate.source };
  }

  const service = {
    readSettings,

    async viewSettings() {
      const { apiKey, source } = await readSettings();
      return { source, apiKeySet: apiKey !== null };
    },

    // "" keeps the stored key (the form never sees it), null removes it. The
    // audit trail records changed key NAMES only.
    async updateSettings(input: UpdateExchangeRateSettingsInput, userId: string | null) {
      const changed: string[] = [];
      if (input.source !== undefined) {
        await writeExchangeRateSetting(db, EXCHANGE_RATE_SETTING_KEYS.source, input.source);
        changed.push(EXCHANGE_RATE_SETTING_KEYS.source);
      }
      if (input.apiKey === null) {
        await writeExchangeRateSetting(db, EXCHANGE_RATE_SETTING_KEYS.apiKey, null);
        changed.push(EXCHANGE_RATE_SETTING_KEYS.apiKey);
      } else if (input.apiKey !== undefined && input.apiKey !== "") {
        await writeExchangeRateSetting(db, EXCHANGE_RATE_SETTING_KEYS.apiKey, input.apiKey);
        changed.push(EXCHANGE_RATE_SETTING_KEYS.apiKey);
      }
      if (changed.length > 0) {
        changed.sort();
        await audit.log({ entityType: "exchange_rate_settings", entityId: null, action: "updated", detail: { keys: changed }, userId });
      }
      return service.viewSettings();
    },

    // The rate for (currency, date). SEK is always 1 without a lookup. A day
    // after today asks for today's (the latest known) rate.
    //
    // Setting riksbank (default): a manual rate for exactly the day wins (an
    // explicit decision for that day); then Riksbanken's latest banking day
    // ≤ the day — from the table when it can prove it, else one interval
    // call; then, when Riksbanken has nothing or does not answer, the latest
    // manual rate in [day−10, day] (a currency Riksbanken does not publish).
    // Setting manual: only the latest manual rate in [day−10, day].
    // Nothing found ⇒ ExchangeRateUnavailableError.
    async getRate(currencyInput: string, date: string): Promise<ExchangeRateLookup> {
      const currency = currencyInput.trim().toUpperCase();
      if (currency === SEK) return { currency, requestedDate: date, date, rate: 1, source: null };
      if (!CURRENCY.test(currency) || !ISO_DATE.test(date)) throw new ExchangeRateUnavailableError(currency, date);

      const todayDate = today();
      const target = date > todayDate ? todayDate : date;
      const from = addDays(target, -LOOKBACK_DAYS);
      const settings = await readSettings();
      const stored = await ratesInRange(db, currency, from, target);
      const manual = stored.filter((rate) => rate.source === "manual");
      const latestManual = manual.at(-1) ?? null;

      if (settings.source === "manual") {
        if (latestManual) return lookup(currency, date, latestManual);
        throw new ExchangeRateUnavailableError(currency, date);
      }

      const exactManual = manual.find((rate) => rate.date === target);
      if (exactManual) return lookup(currency, date, exactManual);

      const latestRiksbank = stored.filter((rate) => rate.source === "riksbank").at(-1) ?? null;
      const recently = fetchedRecently(currency, target);
      if (latestRiksbank && (latestRiksbank.date === target || recently || onlyWeekendBetween(latestRiksbank.date, target))) {
        return lookup(currency, date, latestRiksbank);
      }

      if (!recently) {
        const result = await fetchObservations(currency, from, target, settings.apiKey);
        if (result.ok) {
          await upsertRiksbankRates(db, currency, result.observations);
          markFetched(currency, target);
          const latest = [...result.observations].sort((a, b) => a.date.localeCompare(b.date)).at(-1);
          if (latest) return lookup(currency, date, { date: latest.date, rate: latest.value, source: "riksbank" });
        }
      }

      if (latestManual) return lookup(currency, date, latestManual);
      throw new ExchangeRateUnavailableError(currency, date);
    },

    async list(query: ListExchangeRatesQuery) {
      return listRates(db, query);
    },

    // A manual rate (Ny kurs). Replaces an earlier manual rate for the day.
    async createManualRate(input: CreateExchangeRateInput, userId: string | null) {
      const { id, created, previousRate } = await upsertManualRate(db, input, userId);
      await audit.log({
        entityType: "exchange_rate",
        entityId: `${input.currency} ${input.date}`,
        action: created ? "created" : "updated",
        detail: created ? { rate: input.rate } : { before: { rate: previousRate }, after: { rate: input.rate } },
        userId,
      });
      return (await findRateById(db, id))!;
    },

    // Hämta från Riksbanken for an interval: one call, every published day
    // stored. A day after today is not asked for (nothing is published yet).
    async fetchRange(input: FetchExchangeRatesInput) {
      const todayDate = today();
      const to = input.to > todayDate ? todayDate : input.to;
      if (input.from > to) return { currency: input.currency, from: input.from, to: input.to, fetched: 0, rates: [] as StoredRate[] };
      const settings = await readSettings();
      const result = await fetchObservations(input.currency, input.from, to, settings.apiKey);
      if (!result.ok) throw new RiksbankUnavailableError(result.reason);
      await upsertRiksbankRates(db, input.currency, result.observations);
      const rates = await ratesInRange(db, input.currency, input.from, to);
      return {
        currency: input.currency,
        from: input.from,
        to: input.to,
        fetched: result.observations.length,
        rates: rates.filter((rate) => rate.source === "riksbank"),
      };
    },

    // --- Referensränta (dröjsmålsränta) ---

    async listReferenceRates(): Promise<{ rows: ReferenceRateRow[]; total: number }> {
      const rows = await listReferenceRates(db);
      return { rows, total: rows.length };
    },

    // Lägg till (manual) — upsert for the half-year; wins over Riksbanken's.
    async createManualReferenceRate(input: { validFrom: string; rate: number }, userId: string | null): Promise<ReferenceRateRow> {
      const { row, previous } = await upsertManualReferenceRate(db, input, userId);
      await audit.log({
        entityType: "reference_rate",
        entityId: input.validFrom,
        action: previous ? "updated" : "created",
        detail: previous ? { before: { rate: previous.rate, source: previous.source }, after: { rate: input.rate } } : { rate: input.rate },
        userId,
      });
      return row;
    },

    // Only a manual row can be removed; Riksbanken's answers 409.
    async deleteReferenceRate(id: string, userId: string | null): Promise<boolean> {
      const row = await findReferenceRateById(db, id);
      if (!row) return false;
      if (row.source !== "manual") throw new ReferenceRateRiksbankError(row.validFrom);
      await deleteReferenceRateRow(db, id);
      await audit.log({ entityType: "reference_rate", entityId: row.validFrom, action: "deleted", detail: { rate: row.rate }, userId });
      return true;
    },

    // Hämta från Riksbanken for the half-years in [from, to] (default the
    // latest four through today) — every published half-year stored (a
    // manual row is never overwritten). One call per half-year; a failure
    // is the same 502 as the exchange rates' fetch.
    async fetchReferenceRates(input: { from?: string; to?: string }): Promise<{ fetched: number; rows: ReferenceRateRow[] }> {
      const settings = await readSettings();
      let fetchedCount = 0;
      for (const validFrom of referenceHalfYears(input)) {
        const result = await fetchReferenceRate(validFrom, settings.apiKey);
        if (!result.ok) throw new RiksbankUnavailableError(result.reason);
        markFetched(REFERENCE_RATE_SERIES, validFrom);
        if (result.rate === null) continue;
        await upsertRiksbankReferenceRate(db, validFrom, result.rate);
        fetchedCount += 1;
      }
      return { fetched: fetchedCount, rows: await listReferenceRates(db) };
    },

    // The referensräntor for the given half-year starts, fetching the
    // missing ones from Riksbanken first (best effort: a failure or an
    // unpublished half-year simply leaves it out — the caller reports
    // rateMissing). Never called inside a transaction. A half-year asked
    // for recently is not asked again (the fetch memo), so a list reload
    // does not hammer Riksbanken for a rate that is not published.
    async ensureReferenceRates(halfYearStarts: string[]): Promise<Map<string, number>> {
      const wanted = [...new Set(halfYearStarts)].sort();
      let stored = await referenceRatesFor(db, wanted);
      const todayDate = today();
      const missing = wanted.filter((start) => !stored.has(start) && start <= todayDate && !fetchedRecently(REFERENCE_RATE_SERIES, start));
      if (missing.length > 0) {
        const settings = await readSettings();
        for (const validFrom of missing) {
          const result = await fetchReferenceRate(validFrom, settings.apiKey);
          if (!result.ok) break;
          markFetched(REFERENCE_RATE_SERIES, validFrom);
          if (result.rate !== null) await upsertRiksbankReferenceRate(db, validFrom, result.rate);
        }
        stored = await referenceRatesFor(db, wanted);
      }
      return new Map([...stored].map(([start, row]) => [start, row.rate] as const));
    },
  };

  return service;
}

export type ExchangeRateService = ReturnType<typeof createExchangeRateService>;
