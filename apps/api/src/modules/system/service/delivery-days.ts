// Fasta leveransdagar: the date rules for suppliers' and customers' fixed
// delivery days, the arrival/dispatch mode and transit days. Pure — no DB
// imports; the callers load the settings and the holiday register
// (delivery-context.ts) and this module owns the rules. purchase, sales and
// planning all read it, hence system.
//
// All dates are Stockholm days as YYYY-MM-DD. Lead time and transit days
// count WORKING days (Monday–Friday, not a full-day holiday). A partner
// without settings (no weekdays, transit 0, lead time 0) short-circuits to
// the inputs unchanged — exactly the behaviour before delivery days existed.

export type DeliveryDayMode = "arrival" | "dispatch";
export type DeliverySide = "supplier" | "customer";

export interface DeliverySettings {
  weekdays: number[]; // ISO 1–7 (Monday = 1), sorted; empty = no fixed days
  mode: DeliveryDayMode;
  transitDays: number;
}

export interface DeliveryDefaults {
  supplier: { mode: DeliveryDayMode; transitDays: number };
  customer: { mode: DeliveryDayMode; transitDays: number };
}

// The partner's own columns; null = the system default for the side.
export interface PartnerDeliveryFields {
  deliveryWeekdays: number[];
  deliveryDayMode: DeliveryDayMode | null;
  transitDays: number | null;
}

export const DELIVERY_SETTING_KEYS = {
  supplierMode: "supplier_delivery_day_mode",
  supplierTransit: "supplier_transit_days",
  customerMode: "customer_delivery_day_mode",
  customerTransit: "customer_transit_days",
} as const;

// We know when we ship ourselves, so the customer side defaults to dispatch.
const DEFAULTS: DeliveryDefaults = {
  supplier: { mode: "arrival", transitDays: 0 },
  customer: { mode: "dispatch", transitDays: 0 },
};

const MAX_TRANSIT_DAYS = 60;
// Searches for a listed day give up after this many calendar days and
// return the date they started from — never an exception.
const SEARCH_DAYS = 60;

function decodeMode(raw: string | null | undefined, fallback: DeliveryDayMode): DeliveryDayMode {
  return raw === "arrival" || raw === "dispatch" ? raw : fallback;
}

function decodeTransit(raw: string | null | undefined): number {
  if (raw == null || !/^\d+$/.test(raw)) return 0;
  const n = Number(raw);
  return n <= MAX_TRANSIT_DAYS ? n : 0;
}

// Junk in system_settings falls back to the default instead of a 500.
export function decodeDeliveryDefaults(get: (key: string) => string | null | undefined): DeliveryDefaults {
  return {
    supplier: {
      mode: decodeMode(get(DELIVERY_SETTING_KEYS.supplierMode), DEFAULTS.supplier.mode),
      transitDays: decodeTransit(get(DELIVERY_SETTING_KEYS.supplierTransit)),
    },
    customer: {
      mode: decodeMode(get(DELIVERY_SETTING_KEYS.customerMode), DEFAULTS.customer.mode),
      transitDays: decodeTransit(get(DELIVERY_SETTING_KEYS.customerTransit)),
    },
  };
}

// The weekdays have no system default — only the mode and transit days do.
export function effectiveDeliverySettings(
  p: PartnerDeliveryFields,
  side: DeliverySide,
  d: DeliveryDefaults
): DeliverySettings {
  return {
    weekdays: p.deliveryWeekdays,
    mode: p.deliveryDayMode ?? d[side].mode,
    transitDays: p.transitDays ?? d[side].transitDays,
  };
}

export function hasDeliverySettings(s: DeliverySettings): boolean {
  return s.weekdays.length > 0 || s.transitDays > 0;
}

// Calendar arithmetic on YYYY-MM-DD strings in UTC, so no local time zone or
// DST shift can move a date.
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isoWeekday(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return day === 0 ? 7 : day;
}

// A working day is Monday–Friday and not a full-day holiday (offDays = the
// holiday register's dates without a day schedule). The company has no
// week schedule of its own — resources and employees do — so the weekend
// is the fixed default.
export function isWorkingDay(date: string, offDays: ReadonlySet<string>): boolean {
  return isoWeekday(date) <= 5 && !offDays.has(date);
}

// Bounded loops: a register that marks a whole year off can't loop forever.
const MAX_STEPS = 366;

function stepToWorkingDay(date: string, step: 1 | -1, offDays: ReadonlySet<string>): string {
  let day = date;
  for (let i = 0; i < MAX_STEPS && !isWorkingDay(day, offDays); i++) day = addDays(day, step);
  return day;
}

export function previousWorkingDay(date: string, offDays: ReadonlySet<string>): string {
  return stepToWorkingDay(addDays(date, -1), -1, offDays);
}

export function nextWorkingDayOnOrAfter(date: string, offDays: ReadonlySet<string>): string {
  return stepToWorkingDay(date, 1, offDays);
}

// The n:th working day after date; n = 0 leaves date unchanged even when it
// isn't a working day.
export function addWorkingDays(date: string, n: number, offDays: ReadonlySet<string>): string {
  let day = date;
  for (let i = 0; i < n; i++) day = stepToWorkingDay(addDays(day, 1), 1, offDays);
  return day;
}

export function subtractWorkingDays(date: string, n: number, offDays: ReadonlySet<string>): string {
  let day = date;
  for (let i = 0; i < n; i++) day = previousWorkingDay(day, offDays);
  return day;
}

// The number of working days in (from, to] — how many working days `to`
// lies after `from` (0 when to ≤ from). Pegging's "N dagar för sent".
// Bounded like the other walks: a span over a year counts no further.
export function workingDaysBetween(from: string, to: string, offDays: ReadonlySet<string>): number {
  if (to <= from) return 0;
  let n = 0;
  let day = from;
  for (let i = 0; i < MAX_STEPS && day < to; i++) {
    day = addDays(day, 1);
    if (isWorkingDay(day, offDays)) n++;
  }
  return n;
}

// No fixed days ⇒ working days. An explicitly ticked Saturday/Sunday is
// listed, a full-day holiday never is.
export function isListedDay(date: string, s: DeliverySettings, offDays: ReadonlySet<string>): boolean {
  if (s.weekdays.length === 0) return isWorkingDay(date, offDays);
  return !offDays.has(date) && s.weekdays.includes(isoWeekday(date));
}

function findListed(date: string, step: 1 | -1, s: DeliverySettings, offDays: ReadonlySet<string>): string | null {
  for (let i = 0, day = date; i <= SEARCH_DAYS; i++, day = addDays(day, step)) {
    if (isListedDay(day, s, offDays)) return day;
  }
  return null;
}

export function nextListedOnOrAfter(date: string, s: DeliverySettings, offDays: ReadonlySet<string>): string {
  return findListed(date, 1, s, offDays) ?? date;
}

export function lastListedOnOrBefore(date: string, s: DeliverySettings, offDays: ReadonlySet<string>): string {
  return findListed(date, -1, s, offDays) ?? date;
}

// The latest calendar day a dispatch can leave and still arrive (after
// transit WORKING days) on or before date: the day before the transit:th
// working day counted back from date (date itself counts when it is a
// working day). Transit 0 ⇒ date. That day may itself be a weekend day — an
// explicitly ticked Saturday with transit 1 still arrives on Monday — so the
// search below starts here, not at the last working day. Counted backwards
// only: a date near the end of the calendar never overflows.
function latestDispatchStart(date: string, transitDays: number, offDays: ReadonlySet<string>): string {
  if (transitDays === 0) return date;
  const lastWorking = isWorkingDay(date, offDays) ? date : previousWorkingDay(date, offDays);
  return addDays(subtractWorkingDays(lastWorking, transitDays - 1, offDays), -1);
}

// The latest listed dispatch day s whose arrival (s + transit) is on or
// before date; null when none is found within the search window. The
// search starts at the latest possible dispatch day (transit is up to 60
// WORKING days, so starting at date would run out of window) and the
// arrival check guards the invariant for every candidate.
function latestDispatchFor(date: string, s: DeliverySettings, offDays: ReadonlySet<string>): string | null {
  const start = latestDispatchStart(date, s.transitDays, offDays);
  for (let i = 0, day = start; i <= SEARCH_DAYS; i++, day = addDays(day, -1)) {
    if (isListedDay(day, s, offDays) && addWorkingDays(day, s.transitDays, offDays) <= date) return day;
  }
  return null;
}

// Supplier side, arrival dates. null = nothing found within the window.
function latestArrivalOnOrBefore(date: string, s: DeliverySettings, offDays: ReadonlySet<string>): string | null {
  if (s.mode === "arrival") return findListed(date, -1, s, offDays);
  const dispatch = latestDispatchFor(date, s, offDays);
  return dispatch === null ? null : addWorkingDays(dispatch, s.transitDays, offDays);
}

// "From today" never starts on a weekend or holiday, so an arrival is never
// counted back to a dispatch yesterday.
const startDay = (today: string, offDays: ReadonlySet<string>) => nextWorkingDayOnOrAfter(today, offDays);

// The earliest possible arrival at us: lead time = working days until the
// supplier can ship, transit = working days on the way. Monotone in `today`
// (a later order never arrives earlier) — latestPurchaseOrderDate relies on
// that to step backwards.
export function earliestPurchaseArrival(
  today: string,
  leadTimeDays: number,
  s: DeliverySettings,
  offDays: ReadonlySet<string>
): string {
  const t0 = startDay(today, offDays);
  if (s.mode === "dispatch") {
    const shipped = nextListedOnOrAfter(addWorkingDays(t0, leadTimeDays, offDays), s, offDays);
    return addWorkingDays(shipped, s.transitDays, offDays);
  }
  return nextListedOnOrAfter(addWorkingDays(t0, leadTimeDays + s.transitDays, offDays), s, offDays);
}

// The arrival date for a purchase: the latest possible arrival before the
// demand day (the goods must be in the day before it is needed, the same
// margin as the färdigdatumsförslag), but never earlier than the earliest
// possible arrival — late = that floor comes after the demand. demandDate is
// the RAW demand date, even when it has already passed.
export function suggestPurchaseDeliveryDate(i: {
  demandDate: string | null;
  today: string;
  leadTimeDays: number | null;
  settings: DeliverySettings;
  offDays: ReadonlySet<string>;
}): { date: string | null; late: boolean } {
  const lead = i.leadTimeDays ?? 0;
  if (!hasDeliverySettings(i.settings) && lead === 0) {
    if (i.demandDate === null) return { date: null, late: false };
    const before = previousWorkingDay(i.demandDate, i.offDays);
    return { date: before < i.today ? i.today : before, late: false };
  }
  const floor = earliestPurchaseArrival(i.today, lead, i.settings, i.offDays);
  if (i.demandDate === null) return { date: floor, late: false };
  const candidate = latestArrivalOnOrBefore(previousWorkingDay(i.demandDate, i.offDays), i.settings, i.offDays);
  return candidate !== null && candidate >= floor ? { date: candidate, late: false } : { date: floor, late: true };
}

// Senaste beställningsdag: the last day D an order can be placed and still
// arrive before the demand — the arrival aimed at is the latest listed
// arrival on or before the working day before the demand (the same margin
// as suggestPurchaseDeliveryDate), and D is the latest day whose earliest
// possible arrival (earliestPurchaseArrival, ordering on D) is on or before
// it. Built on the forward function rather than a mirrored backward one so
// the two can never disagree; the brute-force comparison in
// delivery-days.test.ts pins it. Stepping backwards from the arrival day
// is bounded: lead time and transit are working days (at most 7/5 calendar
// days each) plus the 60-day listed-day search and a margin — no answer
// inside that ⇒ null (as when no arrival day is found at all). The result
// may lie in the past; the caller decides what "late" means.
export function latestPurchaseOrderDate(i: {
  demandDate: string;
  leadTimeDays: number | null;
  settings: DeliverySettings;
  offDays: ReadonlySet<string>;
}): string | null {
  const lead = Math.max(0, i.leadTimeDays ?? 0);
  const arrival = latestArrivalOnOrBefore(previousWorkingDay(i.demandDate, i.offDays), i.settings, i.offDays);
  if (arrival === null) return null;
  const maxSteps = 2 * (lead + i.settings.transitDays) + SEARCH_DAYS + 14;
  for (let n = 0, day = arrival; n <= maxSteps; n++, day = addDays(day, -1)) {
    if (earliestPurchaseArrival(day, lead, i.settings, i.offDays) <= arrival) return day;
  }
  return null;
}

export function isValidPurchaseArrival(date: string, s: DeliverySettings, offDays: ReadonlySet<string>): boolean {
  if (s.mode === "arrival") return isListedDay(date, s, offDays);
  return latestArrivalOnOrBefore(date, s, offDays) === date;
}

// Customer side. The sales order's date is the day the customer gets the
// goods; the ship date is what we must have ready (the demand date).
export function shipDateFor(deliveryDate: string, s: DeliverySettings, offDays: ReadonlySet<string>): string {
  if (!hasDeliverySettings(s)) return deliveryDate;
  if (s.mode === "arrival") return subtractWorkingDays(deliveryDate, s.transitDays, offDays);
  return latestDispatchFor(deliveryDate, s, offDays) ?? deliveryDate;
}

// The day the customer gets goods that are ready to ship on `ship`: in
// dispatch mode the next dispatch day plus transit, in arrival mode transit
// then the next receiving day. Leveranstidskontrollen's last step.
export function deliveryFromShipDate(ship: string, s: DeliverySettings, offDays: ReadonlySet<string>): string {
  if (s.mode === "dispatch") return addWorkingDays(nextListedOnOrAfter(ship, s, offDays), s.transitDays, offDays);
  return nextListedOnOrAfter(addWorkingDays(ship, s.transitDays, offDays), s, offDays);
}

// Ignores stock, material and capacity — that is Leveranstidskontrollen.
export function earliestCustomerDelivery(today: string, s: DeliverySettings, offDays: ReadonlySet<string>): string {
  return deliveryFromShipDate(startDay(today, offDays), s, offDays);
}

export function isValidCustomerDelivery(date: string, s: DeliverySettings, offDays: ReadonlySet<string>): boolean {
  if (s.mode === "arrival") return isListedDay(date, s, offDays);
  const dispatch = latestDispatchFor(date, s, offDays);
  return dispatch !== null && addWorkingDays(dispatch, s.transitDays, offDays) === date;
}

const WEEKDAY_SHORT = ["mån", "tis", "ons", "tor", "fre", "lör", "sön"];
const WEEKDAY_PLURAL = ["måndagar", "tisdagar", "onsdagar", "torsdagar", "fredagar", "lördagar", "söndagar"];

const weekdayList = (weekdays: number[]) => weekdays.map((d) => WEEKDAY_SHORT[d - 1]).join(", ");
const transitText = (n: number) => `${n} ${n === 1 ? "transportdag" : "transportdagar"}`;

const SUMMARY_PREFIX: Record<DeliverySide, Record<DeliveryDayMode, string>> = {
  supplier: { dispatch: "Leverantören skickar", arrival: "Levereras till oss" },
  customer: { dispatch: "Vi skickar", arrival: "Kunden tar emot" },
};

// The hint under the date fields, e.g. "Leverantören skickar mån, tor · 2
// transportdagar"; null when the partner has neither days nor transit.
export function deliverySummary(side: DeliverySide, s: DeliverySettings): string | null {
  const parts: string[] = [];
  if (s.weekdays.length > 0) parts.push(`${SUMMARY_PREFIX[side][s.mode]} ${weekdayList(s.weekdays)}`);
  if (s.transitDays > 0) parts.push(transitText(s.transitDays));
  return parts.length > 0 ? parts.join(" · ") : null;
}

// The warning under a date field that doesn't fit the partner's days —
// never a block. Only when the partner has fixed days.
export function deliveryDateWarning(
  side: DeliverySide,
  date: string,
  s: DeliverySettings,
  offDays: ReadonlySet<string>
): string | null {
  if (s.weekdays.length === 0) return null;
  const valid = side === "supplier" ? isValidPurchaseArrival(date, s, offDays) : isValidCustomerDelivery(date, s, offDays);
  if (valid) return null;
  if (s.mode === "arrival") {
    const when = offDays.has(date) ? "helgdagar" : WEEKDAY_PLURAL[isoWeekday(date) - 1];
    return side === "supplier"
      ? `Leverantören levererar inte till oss på ${when}.`
      : `Kunden tar inte emot leveranser på ${when}.`;
  }
  const days = s.transitDays > 0 ? `${weekdayList(s.weekdays)} + ${transitText(s.transitDays)}` : weekdayList(s.weekdays);
  return side === "supplier"
    ? `Datumet passar inte leverantörens avsändningsdagar (${days}).`
    : `Datumet passar inte våra avsändningsdagar till kunden (${days}).`;
}

// The range of dates the system reasons about. New input is validated to it
// (businessDateSchema in @navet/shared); stored dates outside it (an old
// order dated 9999-12-31) are clamped where they reach date arithmetic that
// feeds a query, so they can't produce a +010000-… string Postgres rejects.
export const BUSINESS_DATE_MIN = "1900-01-01";
export const BUSINESS_DATE_MAX = "2999-12-31";

function clampBusinessDate(date: string): string {
  return date < BUSINESS_DATE_MIN ? BUSINESS_DATE_MIN : date > BUSINESS_DATE_MAX ? BUSINESS_DATE_MAX : date;
}

// The holiday range a caller must load so every search above sees the
// register: twice the working days added or subtracted (weekends) plus the
// 60-day search and some margin, both ways. dates must not be empty. The
// window is clamped to the business range (the inputs BEFORE the arithmetic,
// the result after it) — the register has nothing outside it anyway.
export function deliveryHolidayWindow(dates: string[], extraWorkingDays: number): { from: string; to: string } {
  const first = clampBusinessDate(dates.reduce((a, b) => (b < a ? b : a)));
  const last = clampBusinessDate(dates.reduce((a, b) => (b > a ? b : a)));
  return {
    from: clampBusinessDate(addDays(first, -(2 * extraWorkingDays + 75))),
    to: clampBusinessDate(addDays(last, 2 * extraWorkingDays + 120)),
  };
}

// Datum är Stockholmsdagar: the API's ONE reading of the Swedish calendar
// day and wall clock, whatever zone the process runs in (the test suite runs
// UTC on purpose; process-time-zone.test.ts keeps the local-zone Date API
// out of src).

// Today as a Stockholm day — the "from today" of every suggestion.
// Hållbarhet (#8 etapp 2): a manufactured batch's utgångsdatum = the
// Stockholm day it is received + the article's Hållbarhet (dagar), in
// calendar days. The utgångsdatum is the LAST usable day. null without a
// hållbarhet.
export function expiryFromShelfLife(day: string, shelfLifeDays: number | null | undefined): string | null {
  return shelfLifeDays == null || shelfLifeDays <= 0 ? null : addDays(day, shelfLifeDays);
}

export function stockholmToday(): string {
  return stockholmDateOf(new Date());
}

// sv-SE formats ISO-style (YYYY-MM-DD).
const STOCKHOLM_DAY = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" });

// The Stockholm day (YYYY-MM-DD) of an instant — the container may run UTC.
export function stockholmDateOf(instant: Date): string {
  return STOCKHOLM_DAY.format(instant);
}

const STOCKHOLM_WALL_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Stockholm",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  hourCycle: "h23",
});
const DAY_MS = 86_400_000;

// Stockholm's UTC offset (ms) at an instant: its wall clock read as UTC,
// minus the instant (whole seconds — the formatter has no milliseconds).
function stockholmOffsetMs(ms: number): number {
  const p = Object.fromEntries(STOCKHOLM_WALL_CLOCK.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  const wall = new Date(Date.UTC(2000, 0, 1, p.hour, p.minute, p.second));
  wall.setUTCFullYear(p.year!, p.month! - 1, p.day); // Date.UTC would read years 0–99 as 19xx
  return wall.getTime() - Math.floor(ms / 1000) * 1000;
}

// The instant (epoch ms) of a Stockholm wall clock: date YYYY-MM-DD, clock
// "HH:MM" or "HH:MM:SS" — the payroll day's bounds and schedule clocks. On
// the two switch days it reads the clock the way a Date in the zone itself
// would: an autumn clock that occurs twice is its first occurrence (summer
// time), a spring clock the jump skips is read with the winter offset
// (02:30 → 03:30 summer time).
export function stockholmInstant(date: string, clock: string): number {
  const wall = Date.parse(`${date}T${clock.length === 5 ? `${clock}:00` : clock}Z`); // the wall clock read as UTC
  const dayStart = Date.parse(`${date}T00:00:00Z`);
  // A clock inside the date (00:00–24:00) on a date without a switch nearby:
  // one offset for the whole day, looked up once per date.
  if (wall >= dayStart && wall <= dayStart + DAY_MS) {
    const offset = steadyOffsetOf(date, dayStart);
    if (offset !== null) return wall - offset;
  }
  return instantNearSwitch(wall);
}

// The formatter costs ~5 µs and a payroll day reads some fifteen clocks per
// employee, so the offset is kept per date. instantNearSwitch's probes for a
// clock on the date lie at wall ± 24 h, all inside [date − 1 day, date + 2
// days]; when the offset is the same at both ends of that window it is the
// same throughout (Stockholm's switches are months apart, never two within
// three days), and every probe would have read it — the result is exactly the
// one instantNearSwitch gives. Otherwise null: the date is a switch day or
// next to one, and the clock goes the long way.
const steadyOffsets = new Map<string, number | null>();
const STEADY_OFFSETS_MAX = 4096;

function steadyOffsetOf(date: string, dayStart: number): number | null {
  const cached = steadyOffsets.get(date);
  if (cached !== undefined) return cached;
  const first = stockholmOffsetMs(dayStart - DAY_MS);
  const offset = first === stockholmOffsetMs(dayStart + 2 * DAY_MS) ? first : null;
  if (steadyOffsets.size >= STEADY_OFFSETS_MAX) steadyOffsets.clear();
  steadyOffsets.set(date, offset);
  return offset;
}

// The offset either side of the wall clock: equal, there is no switch within
// a day of it; different, the clock is read with the offset that gives it back.
function instantNearSwitch(wall: number): number {
  const before = stockholmOffsetMs(wall - DAY_MS);
  const after = stockholmOffsetMs(wall + DAY_MS);
  if (before === after) return wall - before;
  if (stockholmOffsetMs(wall - before) === before) return wall - before;
  if (stockholmOffsetMs(wall - after) === after) return wall - after;
  return wall - before;
}
