import { describe, expect, it } from "vitest";
import {
  deliveryPrecisionCsvQuerySchema,
  reportRangeSchema,
  salesStatisticsQuerySchema,
  scrapStatisticsQuerySchema,
} from "@navet/shared";

// Pure schema tests — no database.

describe("report query schemas", () => {
  it("accepts YYYY-MM months and rejects malformed ones", () => {
    expect(reportRangeSchema.parse({ from: "2026-01", to: "2026-12" })).toEqual({ from: "2026-01", to: "2026-12" });
    expect(() => reportRangeSchema.parse({ from: "2026-13" })).toThrow();
    expect(() => reportRangeSchema.parse({ from: "2026-00" })).toThrow();
    expect(() => reportRangeSchema.parse({ from: "2026-1" })).toThrow();
    expect(() => reportRangeSchema.parse({ from: "igår" })).toThrow();
  });

  it("rejects from after to", () => {
    expect(() => reportRangeSchema.parse({ from: "2026-05", to: "2026-04" })).toThrow();
    expect(reportRangeSchema.parse({ from: "2026-04", to: "2026-04" })).toBeTruthy(); // same month ok
  });

  it("allows open-ended ranges", () => {
    expect(reportRangeSchema.parse({})).toEqual({});
    expect(reportRangeSchema.parse({ from: "2026-01" }).from).toBe("2026-01");
  });

  it("defaults groupBy to month and rejects unknown values", () => {
    expect(salesStatisticsQuerySchema.parse({}).groupBy).toBe("month");
    expect(salesStatisticsQuerySchema.parse({ groupBy: "customer" }).groupBy).toBe("customer");
    expect(() => salesStatisticsQuerySchema.parse({ groupBy: "vecka" })).toThrow();
    expect(scrapStatisticsQuerySchema.parse({ groupBy: "reason" }).groupBy).toBe("reason");
  });

  it("requires kind on the delivery precision CSV query", () => {
    expect(deliveryPrecisionCsvQuerySchema.parse({ kind: "sales" }).kind).toBe("sales");
    expect(() => deliveryPrecisionCsvQuerySchema.parse({})).toThrow();
  });
});
