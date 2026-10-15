import { ApiError } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { FormError } from "../ui/Form";

export interface RowFailure {
  key: string;
  label: string;
  error: { error: string; code?: string };
}

// A per-row refusal from a booking call (Bekräfta utförd / Bokför valda) in
// Swedish: the dictionary text for its code, never the raw English message.
export function bookingErrorText(error: { error: string; code?: string }): string {
  // Without a code the English message is all there is — show the generic text.
  if (!error.code) return "Åtgärden misslyckades.";
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
