import { stockholmToday } from "../../lib/date";

// A quote whose Giltig t.o.m. has passed (Stockholm day). Expiry is derived —
// the quote keeps its status until someone confirms it, loses it or moves the
// date.
export function isQuoteExpired(status: string, quoteValidUntil: string | null | undefined): boolean {
  return status === "quote" && !!quoteValidUntil && quoteValidUntil < stockholmToday();
}

export function QuoteExpiredBadge() {
  return (
    <span
      style={{
        background: "var(--status-stopped-bg)",
        color: "var(--status-stopped-text)",
        padding: "1px 8px",
        borderRadius: "var(--radius-control-sm)",
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      Utgången
    </span>
  );
}
