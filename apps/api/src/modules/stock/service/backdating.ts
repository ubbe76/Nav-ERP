// Bakdaterade lagerrörelser (#19) — the pure half: which day a movement is
// booked on, the moment that day stands for, and the two refusals. No DB
// imports; the verdict that reads the period lock and the counts lives in
// stock/repository/backdating.ts. Lagerjustering and inleverans share both
// (the writers live in two modules), and app.ts maps the errors ONCE for
// every route (backdateErrorStatus), like the batch errors.
import { addDays, stockholmInstant } from "../../system/service/delivery-days.js";

// The note every saldoimport row carries (import/service/stock-balances.ts
// re-exports it): the import SETS the place's balance, like a count, so a
// movement backdated to before it would count the goods twice.
export const STOCK_IMPORT_NOTE = "Import av lagersaldo";

export class StockBackdateInFutureError extends Error {
  constructor(readonly day: string) {
    super(`Datumet ${day} har inte kommit än. En lagerrörelse kan bokföras per i dag eller ett tidigare datum.`);
    this.name = "StockBackdateInFutureError";
  }
}

export type StockBackdateReason = "year_closed" | "period_locked" | "counted" | "imported";

export class StockBackdateRefusedError extends Error {
  constructor(
    readonly day: string,
    readonly reason: StockBackdateReason,
    reasonText: string
  ) {
    super(`Lagerrörelsen kan inte bokföras per ${day}: ${reasonText} Registrera den per i dag i stället.`);
    this.name = "StockBackdateRefusedError";
  }
}

export function backdateErrorStatus(err: unknown): number | null {
  if (err instanceof StockBackdateInFutureError) return 400;
  if (err instanceof StockBackdateRefusedError) return 409;
  return null;
}

// The day an input asks for, or null when the movement is simply registered
// now: left out, or today's Stockholm day (the form's default — booking
// "today" must not move the row to the end of the day). A later day is
// refused, never clamped.
export function backdatedDay(requested: string | undefined, today: string): string | null {
  if (requested === undefined || requested === today) return null;
  if (requested > today) throw new StockBackdateInFutureError(requested);
  return requested;
}

// The moment a backdated movement stands for: the END of its Stockholm day —
// one millisecond before the next Stockholm midnight, the bound
// stockValuedOnOrBefore compares with — so it counts in every "as of that
// day" reading and comes after the day's registered movements in the log and
// in FIFO's order.
export function backdatedInstant(day: string): Date {
  return new Date(stockholmInstant(addDays(day, 1), "00:00") - 1);
}
