import { ApiError } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { BankItemResult } from "../../lib/types";
import { FormError } from "../ui/Form";

export interface RowFailure {
  key: string;
  label: string;
  error: { error: string; code?: string };
}

// The per-row results of one booking call (Bekräfta utförd / Bokför valda),
// stamped with each row's state at the time. A failure is shown while its
// row is still in that state and drops out as soon as the row changes
// (booked by a later call, handled outside Nav, confirmed by hand) — the same
// rule as lib/stampedEdits.ts, so a stale error never outlives its cause.
export interface StampedResults {
  results: BankItemResult[];
  states: Record<string, string>;
}

const resultKey = (r: BankItemResult) => r.itemId ?? r.entryId ?? "";

export function stampResults(results: BankItemResult[] | null, rows: { id: string; state: string }[]): StampedResults | null {
  if (!results) return null;
  return { results, states: Object.fromEntries(rows.map((row) => [row.id, row.state])) };
}

export function liveFailures(stamped: StampedResults | null, rows: { id: string; state: string }[], label: (id: string) => string): RowFailure[] {
  if (!stamped) return [];
  const current = new Map(rows.map((row) => [row.id, row.state]));
  return stamped.results
    .filter((r) => !r.ok && r.error && current.get(resultKey(r)) === stamped.states[resultKey(r)])
    .map((r) => ({ key: resultKey(r), label: label(resultKey(r)), error: r.error! }));
}

// A per-row refusal from a booking call (Bekräfta utförd / Bokför valda) in
// Swedish: the dictionary text for its code, never the raw English message.
export function bookingErrorText(error: { error: string; code?: string }): string {
  // Without a code the server has already replaced the message by its
  // generic Swedish text (reportableError) — show that, never an English one.
  if (!error.code) return error.error || "Åtgärden misslyckades.";
  return apiErrorMessage(new ApiError(error.error, 409, error.code), "Åtgärden misslyckades.");
}

// Partial failures stay visible: the owner of the results state is an UNKEYED
// wrapper, so a router.refresh() that remounts the keyed card does not wipe
// the list of rows that did not go through.
export function BookingFailures({ failures }: { failures: RowFailure[] }) {
  if (failures.length === 0) return null;
  return (
    <FormError>
      {failures.map((f) => (
        <div key={f.key}>
          {f.label}: {bookingErrorText(f.error)}
        </div>
      ))}
    </FormError>
  );
}
