// Prognos (#10) — the forecast rules, pure like requirements-calc.ts and
// article-overview.ts: the repository loads the consumption per article and
// Stockholm month, the own quantities and the settings; this module owns
// the average, the month forecast, how real demand consumes it and how the
// month's forecast demand is spread over the weeks. ONE implementation for
// the behovsberäkning, the artikelöversikt and GET /articles/:id/forecast,
// so the three can never disagree about a forecast demand.
//
// Rules (spec 2026-11-07-prognos-abc-design.md, "Begrepp och regler"):
// - History window = the N whole calendar months before the current one.
//   Average per month = the window's consumption / N — but an article whose
//   FIRST STOCK MOVEMENT (any transaction type, dated by its värderingsdag)
//   lies inside the window is divided by the months from that month through
//   the window's last month (at least 1): a new article's empty months
//   before it existed in stock are not zero months. Chosen over "first
//   consumption" because an article received in August and sold from
//   September has had August as a real month without sales — dividing by
//   the consumption months only would overstate a slow starter, and a
//   one-off first sale would become the whole forecast. Four decimals.
// - Month forecast = the own quantity for the month when one exists, else
//   the average.
// - The forecast is consumed by orders: forecast demand for a month =
//   max(0, forecast − the month's real demand − (current month: what is
//   already consumed since the 1st)). The real demand is the article's
//   demand rows AS THE BEHOVSBERÄKNING DATES THEM (KO rows on their ship
//   day, TO material and planned TOs' explosion on the TO's start) — the
//   caller passes those dated demands, this module never dates anything.
//   Demand dated before the current month (late orders) consumes nothing.
// - Weekly spread: the month's forecast demand over the working days from
//   today (current month) or the 1st (later months) to the month's end,
//   summed per ISO week; each piece is dated on the week's FIRST working day
//   within the month (never before today). The month total is kept exactly
//   (the last piece takes the rest after rounding to 4 decimals). A month
//   without working days left gives nothing.
import { addDays, isWorkingDay } from "../../system/service/delivery-days.js";
import { isoWeekOf } from "../../timereport/service/schedule.service.js";
import { mondayOf } from "./capacity-calc.js";

// "YYYY-MM".
export type ForecastMonth = string;

const round4 = (n: number) => Math.round((n + Number.EPSILON) * 1e4) / 1e4;

export const monthOf = (date: string): ForecastMonth => date.slice(0, 7);
export const firstDayOf = (month: ForecastMonth): string => `${month}-01`;

export function addMonths(month: ForecastMonth, n: number): ForecastMonth {
  const y = Number(month.slice(0, 4));
  const m0 = Number(month.slice(5, 7)) - 1 + n;
  const year = y + Math.floor(m0 / 12);
  const monthNo = ((m0 % 12) + 12) % 12 + 1;
  return `${year}-${String(monthNo).padStart(2, "0")}`;
}

export function lastDayOf(month: ForecastMonth): string {
  return addDays(firstDayOf(addMonths(month, 1)), -1);
}

// The number of months from `from` through `to`, both inclusive (0 when
// `to` lies before `from`).
export function monthsInclusive(from: ForecastMonth, to: ForecastMonth): number {
  const n = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + (Number(to.slice(5, 7)) - Number(from.slice(5, 7))) + 1;
  return Math.max(0, n);
}

// The N whole months before today's month, ascending.
export function historyMonths(today: string, n: number): ForecastMonth[] {
  const current = monthOf(today);
  const out: ForecastMonth[] = [];
  for (let i = n; i >= 1; i--) out.push(addMonths(current, -i));
  return out;
}

// Today's month and the M − 1 following, ascending.
export function horizonMonths(today: string, m: number): ForecastMonth[] {
  const current = monthOf(today);
  const out: ForecastMonth[] = [];
  for (let i = 0; i < m; i++) out.push(addMonths(current, i));
  return out;
}

// The window's consumption / its months — divided by fewer months when the
// article's first stock movement lies inside the window (see the header);
// never by less than 1. No consumption ⇒ 0.
export function averageConsumption(
  consumedByMonth: ReadonlyMap<ForecastMonth, number>,
  history: readonly ForecastMonth[],
  firstMovementMonth: ForecastMonth | null
): number {
  if (history.length === 0) return 0;
  let sum = 0;
  for (const month of history) sum += consumedByMonth.get(month) ?? 0;
  const first = history[0]!;
  const last = history[history.length - 1]!;
  let months = history.length;
  if (firstMovementMonth !== null && firstMovementMonth > first) months = Math.max(1, monthsInclusive(firstMovementMonth, last));
  return round4(sum / months);
}

// The own quantity wins; without one the average applies.
export function monthForecast(average: number, own: number | null | undefined): number {
  return own ?? average;
}

// What the month still needs beyond its real demand (and, for the current
// month, what has already been consumed since the 1st) — never negative.
export function forecastDemandOf(i: { forecast: number; actualDemand: number; alreadyConsumed: number }): number {
  return round4(Math.max(0, i.forecast - i.actualDemand - i.alreadyConsumed));
}

export interface ForecastWeekPiece {
  date: string; // the week's first working day within the month, ≥ today
  isoYear: number;
  isoWeek: number;
  quantity: number;
}

// The month's quantity over its working days from `from` (today in the
// current month, the 1st later) to the month's end, per ISO week — exact in
// total, pieces of 0 dropped.
export function spreadOverWeeks(
  month: ForecastMonth,
  quantity: number,
  opts: { today: string; offDays: ReadonlySet<string> }
): ForecastWeekPiece[] {
  if (quantity <= 0) return [];
  const first = firstDayOf(month);
  const last = lastDayOf(month);
  const start = opts.today > first ? opts.today : first;
  const weeks: { monday: string; firstDay: string; days: number }[] = [];
  let total = 0;
  for (let day = start; day <= last; day = addDays(day, 1)) {
    if (!isWorkingDay(day, opts.offDays)) continue;
    total++;
    const monday = mondayOf(day);
    const current = weeks[weeks.length - 1];
    if (current && current.monday === monday) current.days++;
    else weeks.push({ monday, firstDay: day, days: 1 });
  }
  if (total === 0) return [];
  const pieces: ForecastWeekPiece[] = [];
  let given = 0;
  weeks.forEach((week, i) => {
    const share = i === weeks.length - 1 ? round4(quantity - given) : round4((quantity * week.days) / total);
    given = round4(given + share);
    if (share <= 0) return;
    const { isoYear, isoWeek } = isoWeekOf(week.firstDay);
    pieces.push({ date: week.firstDay, isoYear, isoWeek, quantity: share });
  });
  return pieces;
}

// The row's name in the artikelöversikt and the behovsberäkning's cascade:
// "Prognos 2026-11 · v.47".
export function forecastLabel(month: ForecastMonth, isoWeek: number): string {
  return `Prognos ${month} · v.${isoWeek}`;
}

// What the readers pass per forecast-controlled article: the average over
// the window, the own quantities per month and what the current month has
// consumed so far. Built by the planning service from the repository's
// consumption rows (articleForecastInput below).
export interface ArticleForecastInput {
  articleId: string;
  average: number;
  own: ReadonlyMap<ForecastMonth, number>;
  consumedThisMonth: number;
}

export interface ForecastCalendar {
  today: string;
  offDays: ReadonlySet<string>;
  horizon: readonly ForecastMonth[];
}

// Which articles get a forecast demand: Prognosstyrd, active, not a phantom
// or a service, not a beställningsvara's template (never proposed itself) —
// ONE predicate for the behovsberäkning and the artikelöversikt.
export function isForecastArticle(a: {
  forecastControlled?: boolean;
  active: boolean;
  isPhantom: boolean;
  type: "manufactured" | "purchased" | "service";
  configuratorMode?: "variants" | "to_order" | null;
}): boolean {
  return a.forecastControlled === true && a.active && !a.isPhantom && a.type !== "service" && a.configuratorMode !== "to_order";
}

// A dated demand the behovsberäkning nets (null = undated, never consumes).
export interface DatedDemand {
  date: string | null;
  quantity: number;
}

export interface ForecastMonthRow {
  month: ForecastMonth;
  average: number;
  own: number | null;
  forecast: number;
  actualDemand: number;
  // Only the current month: consumed since the 1st; null for later months.
  alreadyConsumed: number | null;
  forecastDemand: number;
}

// The real demand per horizon month out of the dated demands — undated
// rows and rows before the current month consume nothing.
function actualDemandByMonth(demands: readonly DatedDemand[], horizon: readonly ForecastMonth[]): Map<ForecastMonth, number> {
  const set = new Set(horizon);
  const out = new Map<ForecastMonth, number>();
  for (const d of demands) {
    if (d.date === null || d.quantity <= 0) continue;
    const month = monthOf(d.date);
    if (!set.has(month)) continue;
    out.set(month, round4((out.get(month) ?? 0) + d.quantity));
  }
  return out;
}

// One row per horizon month: the average, the own quantity, the forecast,
// the real demand, the already consumed part and the forecast demand.
export function forecastMonthRows(
  article: ArticleForecastInput,
  demands: readonly DatedDemand[],
  cal: Pick<ForecastCalendar, "today" | "horizon">
): ForecastMonthRow[] {
  const actual = actualDemandByMonth(demands, cal.horizon);
  const currentMonth = monthOf(cal.today);
  return cal.horizon.map((month) => {
    const own = article.own.get(month) ?? null;
    const forecast = monthForecast(article.average, own);
    const actualDemand = actual.get(month) ?? 0;
    const alreadyConsumed = month === currentMonth ? article.consumedThisMonth : null;
    return {
      month,
      average: article.average,
      own,
      forecast,
      actualDemand,
      alreadyConsumed,
      forecastDemand: forecastDemandOf({ forecast, actualDemand, alreadyConsumed: alreadyConsumed ?? 0 }),
    };
  });
}

export interface ForecastDemandPiece {
  articleId: string;
  month: ForecastMonth;
  date: string;
  label: string;
  quantity: number;
}

// The weekly forecast demands of one article — what the behovsberäkning
// nets and the artikelöversikt lists as `forecast` rows.
export function forecastWeeklyDemands(
  article: ArticleForecastInput,
  demands: readonly DatedDemand[],
  cal: ForecastCalendar
): ForecastDemandPiece[] {
  const pieces: ForecastDemandPiece[] = [];
  for (const row of forecastMonthRows(article, demands, cal)) {
    for (const piece of spreadOverWeeks(row.month, row.forecastDemand, cal)) {
      pieces.push({
        articleId: article.articleId,
        month: row.month,
        date: piece.date,
        label: forecastLabel(row.month, piece.isoWeek),
        quantity: piece.quantity,
      });
    }
  }
  return pieces;
}

// From the repository's rows to the readers' input: `consumption` is one
// row per (article, month) with the consumed quantity (positive), covering
// the history window AND the current month up to today; `firstMovement` the
// article's first stock movement day (any type). Missing = 0 / never moved.
export function articleForecastInput(i: {
  articleId: string;
  consumption: ReadonlyMap<ForecastMonth, number>;
  own: ReadonlyMap<ForecastMonth, number>;
  firstMovementDate: string | null;
  history: readonly ForecastMonth[];
  today: string;
}): ArticleForecastInput {
  return {
    articleId: i.articleId,
    average: averageConsumption(i.consumption, i.history, i.firstMovementDate === null ? null : monthOf(i.firstMovementDate)),
    own: i.own,
    consumedThisMonth: round4(i.consumption.get(monthOf(i.today)) ?? 0),
  };
}
