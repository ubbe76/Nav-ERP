import { describe, expect, it } from "vitest";
import { backupFilename } from "../src/modules/system/service/backup.js";

// pg_dump isn't available in the vitest environment, so the streaming dump is
// verified end-to-end against the running api container instead. Here we only
// pin the pure, deterministic filename builder.
describe("backupFilename", () => {
  it("builds a timestamped .sql.gz name from UTC, dropping seconds", () => {
    expect(backupFilename(new Date("2026-07-24T09:05:12.345Z"))).toBe("erp-2026-07-24_0905.sql.gz");
  });

  it("zero-pads month/day/hour/minute", () => {
    expect(backupFilename(new Date("2026-01-02T00:03:00Z"))).toBe("erp-2026-01-02_0003.sql.gz");
  });
});
