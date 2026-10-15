import { describe, expect, it } from "vitest";
import { formatStockholmDate, formatStockholmDateTime } from "../../web/lib/date.js";

// The web formats timestamps in Swedish time whatever the server's or the
// browser's own timezone (the containers run UTC).
describe("web date formatting", () => {
  it("formats in Stockholm time, summer and winter", () => {
    expect(formatStockholmDateTime("2026-07-01T22:30:00Z")).toBe("2026-07-02 00:30");
    expect(formatStockholmDateTime("2026-01-07T08:05:00Z")).toBe("2026-01-07 09:05");
    expect(formatStockholmDate("2026-07-01T22:30:00Z")).toBe("2026-07-02");
    expect(formatStockholmDateTime(null)).toBe("–");
  });
});
