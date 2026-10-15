// Upphämtning — pure. Weekday rows decide which days have a pickup (a
// Saturday row works); a full-day holiday (holidays row WITHOUT a day
// schedule) never has one; a short day (with a day schedule) is a normal day —
// the same holiday rule as planning's due-date suggestion.

export const PICKUP_SEARCH_DAYS = 14;

export interface PickupTime {
  weekday: number; // 1 = måndag … 7 = söndag
  timeFrom: string; // "HH:MM" or "HH:MM:SS" (Postgres time)
  timeTo: string;
}

export interface PickupSlot {
  date: string;
  timeFrom: string; // "HH:MM"
  timeTo: string;
}

const hhmm = (time: string) => time.slice(0, 5);

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isoWeekday(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return day === 0 ? 7 : day;
}

export function pickupFor(date: string, pickupTimes: PickupTime[], offDays: ReadonlySet<string>): PickupSlot | null {
  if (offDays.has(date)) return null;
  const row = pickupTimes.find((t) => t.weekday === isoWeekday(date));
  return row ? { date, timeFrom: hhmm(row.timeFrom), timeTo: hhmm(row.timeTo) } : null;
}

// Today if a pickup can still be requested today (see requestedPickupTime),
// otherwise the next day with a pickup — at most PICKUP_SEARCH_DAYS ahead (null = none configured).
export function nextPickup(
  now: { date: string; time: string },
  pickupTimes: PickupTime[],
  offDays: ReadonlySet<string>
): PickupSlot | null {
  for (let i = 0; i < PICKUP_SEARCH_DAYS; i++) {
    const slot = pickupFor(addDays(now.date, i), pickupTimes, offDays);
    if (!slot) continue;
    // Today only while a time can still be requested — the price fetch's own
    // rule, so a new shipment never starts on a day its first fetch refuses.
    if (i === 0 && requestedPickupTime(slot, now) === null) continue;
    return slot;
  }
  return null;
}

// "10:31" → "10:45", "10:45" → "10:45" (a whole quarter stays).
function roundUpToQuarter(time: string): string {
  const [h, m] = time.split(":").map(Number) as [number, number];
  const minutes = Math.ceil((h * 60 + m) / 15) * 15;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

// The pickup time asked of the broker for a slot: its Från time, except on
// the day itself, where a time already passed would be refused — then the
// later of Från and now rounded up to the next quarter hour, or null when
// that reaches Till (today's window has run out). The stored window itself
// is never changed.
export function requestedPickupTime(slot: PickupSlot, now: { date: string; time: string }): string | null {
  const from = hhmm(slot.timeFrom);
  if (slot.date !== now.date) return from;
  const earliest = roundUpToQuarter(hhmm(now.time));
  const time = earliest > from ? earliest : from;
  return time >= hhmm(slot.timeTo) ? null : time;
}

// What stops a stored pickup from being priced, in the words the price
// fetch refuses with — the card shows the same text as a warning before the
// user gets that far. `configured` = pickupFor(stored.date); null = no pickup that day.
export function pickupProblem(stored: PickupSlot, configured: PickupSlot | null, now: { date: string; time: string }): string | null {
  if (stored.date < now.date) return "Upphämtningsdatumet har passerat — välj ett nytt datum";
  if (!configured) return `Ingen upphämtning ${stored.date} — välj en annan dag`;
  if (requestedPickupTime(stored, now) === null) return "Dagens upphämtningstid har passerat — välj ett nytt datum";
  return null;
}

const STOCKHOLM = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Stockholm",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

// Wall-clock date/time in Sweden — pickup days and times are local.
export function stockholmNow(at: Date): { date: string; time: string } {
  const parts = Object.fromEntries(STOCKHOLM.formatToParts(at).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
